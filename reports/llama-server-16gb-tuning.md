# llama-server on a 16 GB card: context and prompt speed

Notes from 2026-10-30 and 2026-10-31, tuning the local server that hermit-agent's real-model tests and daily use run against. Everything here was measured on one machine. Other cards and models need their own numbers.

## Setup

- GPU: RTX 5070 Ti, 16,303 MiB, Windows, driver with CUDA 13.3 (KMD 610.88).
- Model: `Qwen3.8-27B-GSQ-RCO-IQ3_S-mtp.gguf` (12.1 GB, 3.44 bpw).
- Server: `llama-server` on port 9931, started by [`docs/start-qwen38.ps1`](../docs/start-qwen38.ps1). Fixed flags: `--flash-attn on`, KV cache `q8_0` for the model and the MTP draft, `--spec-type draft-mtp`, `--parallel 1`, `--batch-size 1024`, `--fit off`, `--n-gpu-layers all`.

The model is a hybrid. The GGUF says `general.architecture = qwen35`, `full_attention_interval = 4` and `nextn_predict_layers = 1`: only every fourth layer is ordinary attention with a KV cache, the others are recurrent (Gated DeltaNet). That keeps the KV cache small (about 53 MiB per 1,024 tokens at `q8_0`, MTP draft included). It also means llama.cpp can't rewind the cache to an arbitrary position, only to a saved checkpoint (see "Prompt cache in agent use").

## Why the context changed between restarts

The script sizes the context from the VRAM that is free when it starts:

```
ctx = 57344 + 1024 * floor((free - margin - need57k) / 53)
```

with `margin = 200` MiB and `need57k = 14970` MiB (minus 104 when the build has `--spec-draft-n-ubatch`). Every 53 MiB that browsers, Phone Link, G HUB or the desktop hold at launch costs 1,024 tokens. That is why the same script gave 37,888 tokens one day and 49,152 the next. The script prints the free VRAM and the chosen context at start.

Set `$ctxOverride` for a fixed value, for example when comparing benchmark runs.

## Build update: b10678 to b12017

The `v0.8.0` release on GitHub ships no binaries. It points to the nightly build b11960. The Windows files for an RTX 50 card are `llama-bXXXXX-bin-win-cuda-13.4-x64.zip` plus `cudart-llama-bin-win-cuda-13.4-x64.zip`, unpacked into one folder. The CUDA 12.4 build predates Blackwell (sm_120). The 13.4 build ran on the 13.3 driver without problems. The newest nightly (b12017) was installed in the end.

Effect, same short code prompt (300 tokens, thinking off):

| | b10678 | b12017 |
|---|---:|---:|
| Decode | 94 to 98 tok/s | 104 to 117 tok/s |
| Draft tokens accepted | not recorded | 79 to 89 % |

b12017 has `--spec-draft-n-ubatch`, which the script then sets to 64 (about 104 MiB, 2,000 tokens, saved). It also needs about 370 MiB less VRAM than the formula assumed. Recalibrated: `need57k = 14500`.

## How far the context goes (ubatch 256)

| Start | Context | VRAM free after load and requests |
|---|---:|---:|
| b10678, default figures | 49,152 | 670 MiB |
| b12017, default figures | 54,272 | 520 MiB |
| b12017, GPU programs closed | 65,536 | 600 MiB |
| b12017, `need57k = 14500` | 80,896 | 350 MiB |

Checked at full depth with a "needle" prompt: random record lines with one password at 68 % depth, then a question. The model found it at 60k and at 78k tokens. Decode falls with depth, as attention gets more expensive. Nothing spilled to system memory; a spill shows as 1 to 18 tok/s.

| Context filled | Code reply | Prose reply |
|---:|---:|---:|
| about 30 tokens | 113 to 117 tok/s | |
| 59,838 | 73 tok/s | 48 tok/s |
| 78,374 | 63 tok/s | 44 tok/s |

Prose decodes slower because the MTP draft guesses it less well (39 % accepted against 71 to 78 % for code).

## Prompt processing: ubatch 256 against 1024

Measured with `cache_prompt: false` so every prompt is processed in full, best of two runs up to 16k:

| Prompt | `-ub 256` | `-ub 1024` | Gain |
|---:|---:|---:|---:|
| 512 | 1,350 tok/s | 1,621 tok/s | +20 % |
| 2,048 | 1,569 | 1,768 | +13 % |
| 8,192 | 1,569 | 1,802 | +15 % |
| 16,384 | 1,494 | 1,744 | +17 % |
| 32,768 | 1,311 | 1,548 | +18 % |
| about 60k | 1,048 (65,536) | 1,285 (56,000) | about +15 % |

Decode did not change (112 tok/s). The larger ubatch costs roughly 700 MiB of VRAM, about 13k tokens of context. With `-ub 1024` the server started at 57,088 tokens and still had 892 MiB free after a 56k prompt, so about 69,632 tokens should fit with the 200 MiB margin. That value is not verified yet.

The script's formula assumes `-ub 256`. With another ubatch, use `$ctxOverride` until the formula is recalibrated, or it picks too large a context.

Which to use:

- Long cold prompts (documents, a first request with lots of context): `-ub 1024`, about 68k context.
- hermit-agent: `-ub 256` and the larger context. Agent turns mostly append to a cached prompt (next section), so only a few thousand new tokens are processed per step and the 15 % saves well under a second.

## Prompt cache in agent use

A hybrid model needs checkpoints to reuse a prompt whose earlier part changed. llama.cpp keeps up to 32 per slot (`--ctx-checkpoints`), at least 8,192 tokens apart (`--checkpoint-min-step`). hermit-agent shortens old steps in blocks of 4 (`elideHistory`), so its prompt prefix changes only every fourth step.

Test: six simulated agent steps of about 3,500 tokens each, then an edit to an early message, like elision does.

| Request | Prompt | From cache | Processed |
|---|---:|---:|---:|
| Step 1 | 3,498 | 0 | 3,498 |
| Steps 2 to 6 | up to 21,159 | everything before | about 3,490 each |
| After editing step 2 | 17,776 | 3,544 | 14,232 |

Appending reuses the whole cache, and after an edit the server restarts from the edit point, not from the beginning. No checkpoint setting needs changing for agent use.

## Settings tried or rejected

- KV cache `q4_0`: rejected. In the 2026-10-25 lab run the long app task got worse (2 of 3 passed at about 22 steps, against 3 of 3 at about 13 with `q8_0`), at the same speed. Stay at `q8_0`, K and V.
- Moving layers to the CPU, a smaller model quant, dropping MTP: each frees VRAM but costs decode speed or quality. Not worth it for context.

## Getting more context without losing quality

1. NVIDIA Control Panel, Manage 3D settings, Program Settings, `llama-server.exe`: set "CUDA - Sysmem Fallback Policy" to "Prefer No Sysmem Fallback". Windows otherwise moves what doesn't fit into system memory without an error, and decode drops to 1 to 18 tok/s. With the policy off, a context that is too large fails with an out-of-memory error instead, so it is safe to push close to the limit. MTP reserves a second compute buffer on the first request (llama.cpp issue #27282), so a fit that is too tight fails then, not at load. The script's speed check sends that first request.
2. Free the VRAM Windows holds (about 800 MiB with nothing else open): drive the monitor from the CPU's integrated graphics if there is one, and turn off hardware acceleration in browsers, Discord, Steam and similar apps.
3. `--ubatch-size 128` would free a little more (estimated 2k to 3k tokens) for slower prompt processing. Not measured.

## How the numbers were taken

From WSL against `http://localhost:9931`:

- Context and build: `GET /props` (`default_generation_settings.n_ctx`, `build_info`).
- VRAM: `nvidia-smi --query-gpu=memory.used,memory.total --format=csv`, after at least one request so the second compute buffer is counted.
- Decode: a chat request ("Write a Python function that parses ISO dates, with a docstring.", `max_tokens` 300, `enable_thinking: false`), read from `timings.predicted_per_second`. The first request after a load is discarded as a warm-up.
- Prompt processing: random record lines tokenized with `POST /tokenize`, cut to the target length and sent to `POST /completion` with `n_predict: 1` and `cache_prompt: false`, read from `timings.prompt_per_second`.

For numbers others can compare against, use `llama-bench.exe` from the same zip, with the server stopped:

```
llama-bench.exe -m <model.gguf> -ngl 99 -fa 1 -ctk q8_0 -ctv q8_0 -b 2048 -ub 256,512,1024 -p 512,4096 -n 128 -d 0,32768 -r 2
```

It doesn't use the MTP draft, so its decode (`tg`) figures come out below the server's.

## Open

- Verify `-ub 1024` at 69,632 tokens with a full-depth needle prompt.
- `-ub 512`: probably between the two in speed and context.
- A/B without `--spec-draft-n-ubatch 64`: the small draft batch may slow prompt processing.
- Recalibrate `need57k` for `-ub 1024`, from the "Free VRAM" line the script prints at launch.
- Run `llama-bench` for comparable numbers.
- hermit-agent's batching test (ROADMAP, "asking native mode to batch file writes") ran with the app capped at 20k context. Repeat it at the full context.
