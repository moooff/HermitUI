# hermit-agent: runs with real models

Every run of hermit-agent against a real model from 2026-10-03 to 2026-11-02, collected in one place. Until now the results were spread over the phase results in [ROADMAP.md](../hermit-agent/ROADMAP.md), and many runs were never written up at all; they existed only as logs and JSON files in the local lab (`~/ws/hermit-agent-lab/`, not in the repo).

All runs used the built file in headless Chromium through the test harness, with risk-based supervision. The harness approves held steps and checks each task's result in the interpreter or in the final answer. Unless a row says otherwise, reasoning effort was Low.

## Findings at a glance

| Question | Answer | Evidence |
|---|---|---|
| Which model drives the agent reliably? | Qwen3.8-27B | 96 to 100 % on the full reference suite in every phase since 2a; app task 7/8 and 3/3; long run with outages 5/5. |
| Can a small model drive it? | Short tasks yes, long tasks no | Qwen3.5-9B passes 46 of 54 short tasks natively, Qwen3.5-4B and Gemma-4-E4B about 21 of 27. The app task: 0 of 16 runs for the small Qwen models. |
| Is an in-browser engine worth it? | Only on a GPU, only for short tasks | 4B decodes at about 47 tok/s in the browser on a GPU, about 3 on a CPU. Phones were very slow. |
| Native tool calls or code blocks? | Depends on the model; Auto prefers native | Qwen3.8-27B: same accuracy, code blocks faster (35 vs 45 min for the suite). Small models: native better (Qwen3.5-4B 42 vs 26 of 54). |
| Does reasoning effort matter? | Barely, on Qwen3.8-27B | 47 of 48 runs passed from Off to High. Off was fastest on short tasks. |
| Does a larger context help a small model? | No | Qwen3-8B at 131k: markdown report 1 of 6, app 0 of 2. Its failures are the model's. |
| Is gpt-oss-20b an option? | No | 0/12 native, at most 5/12 in text mode. It calls its own built-in tool or writes headers llama.cpp rejects. |
| Does the plan raise the success rate? | No, it adds visibility | Same pass rates with and without it (Phase 3.7). Small models almost never send one natively. |
| Does the agent use ask_llm on its own? | No | 0 of 8 runs used it unprompted, all 8 passed; asked to, it did in 4 of 4. |
| Which KV cache for Qwen3.8-27B on 16 GB? | q8_0 | Full suite 27/27 either way, but the app task (40-step limit) passed 3/3 with q8_0 at about 50k context against 2/3 with q4_0 at 81k. |
| Which misses are noise? | calculation and data processing | int32 overflow (about 10 % of runs) and the `amount`/`total` column name (about half of text runs on IQ3_S). |

## The suites

| Suite | Script | What it does |
|---|---|---|
| Reference | `tests/e2e_reference.py` | Short tasks with checked results. 3 tasks in Phase 1, 15 in 2a, 18 in 2b, 24 in 3.5, 27 since 3.6. |
| Quick | `e2e_reference.py --quick` | 5 of the reference tasks, about 1 minute. |
| App | `tests/e2e_app.py` | One long task: build a small multi-file library-loans app, then run its tests. 10 to 20 steps. |
| Long run | `tests/e2e_longrun.py` | A 22-question treasure hunt over 20+ steps, with staged outages and compaction. |
| Ad hoc selections | `--only "..."` | Six tasks (calculation, word frequency, code + tests, image (Pillow), dates, rename across a project) for the 2026-10-30 runs. |

"Native" means native tool calls, "text" means code blocks and tags (code-as-action).

## Summary

| Model | Best result | Verdict |
|---|---|---|
| Qwen3.8-27B (IQ4_XS, later IQ3_S + MTP) | 27/27 and 80/81 on the full suite, both protocols | The reference model. Drives every suite, including the long ones. |
| Qwen3.5-9B (Q4_K_M) | 46/54 native (85 %), 37/54 text | Best small model on short tasks, about as fast as the 4B. Fails the app task. |
| Gemma-4-E4B (Q4_K_M) | 21/27 native, 19/27 text | Usable on short tasks. Never tried on the app task. |
| Qwen3.5-4B (Q4_K_M) | 21/27 native (twice) | Best small model on short tasks, fastest of all. Fails the app task. |
| Qwen3-8B (Q4_K_M) | 20/27 native, 19/27 text | Mid-field, slow. Fails the app task. |
| Qwen3-4B (Q4_K_M) | 16/27 native | Weakest. Fails the app task. |
| gpt-oss-20b | 5/12 text, 0/12 native | Can't drive the agent. |

## Is an in-browser engine worth it?

This was the question behind the Phase 4 floor runs (2026-10-25): before porting wllama into the agent, find out whether a model small enough for the browser can drive it at all. The small models ran on a native llama.cpp server, which is faster than wllama, so these results are an upper bound for what the browser can do.

What the runs say:
- **Short tasks: yes, on a GPU.** Qwen3.5-9B (46/54 native, 2026-11-02), Qwen3.5-4B (21/27 native, twice) and Gemma-4-E4B (21/27 native, 19/27 text) pass most of the reference suite. Qwen3.8-27B passes 27/27.
- **Long tasks: no.** No small model built the app: 0 of 16 runs across Qwen3-4B, Qwen3.5-4B, Qwen3-8B and Qwen3.5-9B. They hit the step limit or paused on the loop guard. A larger context didn't help Qwen3-8B (131k: markdown report 1 of 6, app 0 of 2). Gemma-4-E4B was never run on the app task.
- **Speed in the browser** (HermitUI's wllama benchmark, [benchmark/README.md](../benchmark/README.md)): on the GPU, Qwen3-4B decodes at about 47 tok/s and is the recommended rung. On the CPU, 4B manages about 3 tok/s, too slow for an agent that sends 3 to 7 requests per task. Gemma-4 suffers from wllama's slow prompt processing (E2B about 40 s to the first token on the CPU). In-tab wllama on a Pixel phone was very slow (2026-10-26), so phones need a server.
- **gpt-oss-20b** was the most plausible offline agent model on paper (DESIGN §6: Memory64, about 43 tok/s on the GPU). On a real server it can't drive the agent (0/12 native, at most 5/12 text), so that hope is gone. DESIGN §6 now says so.

Verdict as of 2026-10-25: an in-browser engine is viable for short tasks on a machine with a WebGPU-capable GPU, with Qwen3.5-4B or Gemma-4-E4B and native tool calls. It is not a replacement for a server model on long tasks, and not usable on CPU-only machines or phones. The port stays planned (ROADMAP Phase 4, "Then the port"), unstarted; the open checks are Gemma-4-E4B on the app task and the error-repeat guard on a small model.

## Qwen3.8-27B

The reference model throughout, on the user's llama.cpp server with one slot. IQ4_XS until early October, `Qwen3.8-27B-GSQ-RCO-IQ3_S-mtp.gguf` (with a multi-token prediction draft) from 2026-10-24.

| Date | Build | Suite | Native | Text | Notes |
|---|---|---|---|---|---|
| 10-03 | Phase 1 | Reference, 3 tasks | | 3/3 | Data processing 14 s, code + tests 42 s, calculation 5 s. |
| 10-05 | Phase 2a | Reference, 15 × 3 | | 44/45 (98 %) | 13 min. The miss is the int32 overflow in calculation. A first run scored 41/45; three misses were `<python>` tags, fixed. |
| 10-05 | Phase 2a | Long run × 5 | | 5/5 | 27 to 33 steps, 1 to 4 compactions, outages ridden out or resumed with nothing lost. 234 to 308 s per run. |
| 10-05 | Phase 2b | Reference, 18 × 3 | | 53/54 (98 %) | 16 min. Same int32 miss. Charts and Pillow tasks 3/3. |
| 10-05 | Phase 3 | 3 tasks | 9/9 | 14/18 | Text misses: int32 overflow (3) and the amount/total flake (1). |
| 10-06 | Phase 3.5 | Reference, 24 × 3 | 72/72 | 71/72 (99 %) | Native first scored 68/72; two misses were suite bugs, fixed. New library tasks took 9 to 18 s on average. |
| 10-06 | Phase 3.5 | odfpy task × 3 | 3/3 | 2/3 | |
| 10-06 | Phase 3.6 | Reference, 27 × 3 | 79/81 (98 %), 26 min | 79/81 (98 %), 21 min | New file-tool tasks 6/6 in each protocol, all correctly held. |
| 10-24 | Phase 3.7 | Reference, 27 × 3 | 78/81 (96 %), then 80/81 with the final build in 39 min | 80/81 (99 %) | IQ3_S. Text was faster: 35 vs 45 min, 6.5 vs 9.2 s per step. |
| 10-24 | Phase 3.7 | App × 8 | 7/8 | 3/3 | Plan build 14.9 steps, 5.0 min against 16.5 and 5.5 for v0.3.11. |
| 10-25 | floor build | Quick / full / app, 81,920 ctx, q4_0 KV | 4/5, 27/27 (7 min), app 1/2 | 5/5 | Lab `fit` chain. Decode 83 tok/s. |
| 10-25 | floor build | App, 40-step limit × 3 (same server) | 2/3 | | 13 min. |
| 10-25 | floor build | Full / app 40, about 50k ctx, q8_0 KV and q8_0 draft | 27/27 (8 min), app 3/3 (12 min) | | Lab `q8draft` chain. Decode 81 tok/s. One attempt in the chain ran at 8 tok/s (VRAM spill) and was discarded. |
| 10-25 | floor build | User's own :9931 server, 66,560 ctx | quick 5/5, full 26/27, app 40 2/2 | quick 5/5 | Miss: word report. |
| 10-30 | same day's build | 6 tasks × 2 | 12/12, 4.4 min | 12/12, 3.2 min | Lab `proto` runs: where a native step spends its time. |
| 10-30 | v0.3.29 | ask_llm probe, 37k ctx | 8/8 runs passed when not asked to use it, 4/4 when asked | | Both protocols. Unprompted, the agent never used ask_llm. ROADMAP "Later". |
| 10-31 | v0.3.30 | Quick | 4/5 | | The miss is the amount/total flake; that task then passed 2/2. |

Conclusion from the Phase 3.7 runs: on this model code-as-action is as accurate as native tool calls and faster, because native sends one call per reply and pays for JSON escaping.

## Small models: the Phase 4 floor (2026-10-25)

Can a model small enough for the browser drive the agent? Measured on a native llama.cpp server (b11531 CUDA, RTX 5070 Ti, 32k context, Q4_K_M) before porting anything to wllama. Written up in ROADMAP Phase 4, "Floor result"; the per-run numbers are below.

| Model | Quick native | Quick text | Full native | Full text | App (2 native + 2 text) |
|---|---|---|---|---|---|
| Qwen3-4B | 3/5, 3/5, 5/5 | 2/5, 3/5, 2/5 | 16/27 (34 min) | 12/27 (39 min) | 0/4 |
| Qwen3.5-4B | 5/5 | 4/5 | 21/27 (10 min), 21/27 (7 min) | 10/27, 16/27 (5 and 7 min) | 0/4 |
| Qwen3-8B | 3/5 | 4/5 | 20/27 (25 min), 17/27 (46 min) | 19/27, 17/27 (26 and 32 min) | 0/4 |

- A 4B model can drive the agent on short tasks, not on long ones. No small model built the app: most runs hit the 20-step limit or paused on the loop guard.
- `code + tests` failed in every native run of every small model.
- Text mode was weaker on both 4B models, level on 8B. So Auto keeps preferring native tool calls when the template supports them; the 27B result doesn't carry over.
- With native tool calls the small models almost never sent a plan.

Follow-up runs the same day, never written up before:

| Run | Result | What it showed |
|---|---|---|
| Qwen3.5-4B at its own 262k context, quick | native 5/5, text 4/5 | A large context doesn't change the short tasks. |
| Qwen3-8B at 131k (YaRN × 4), "markdown report" × 3 | 1/3 (16 min) | The two tasks that compacted at 32k still fail with room to spare. |
| Qwen3-8B at 131k, q4_0 KV, "markdown report" × 3 | 0/3 | Same. |
| Qwen3-8B at 131k, app in text mode × 2 | 0/2 (32 min) | Same. Decode 71 tok/s. |

The context was not the bottleneck for Qwen3-8B. Its failures are the model's.

## Qwen3.5-9B (2026-11-02)

The next size up from the best 4B model. Same server settings as the floor runs (llama.cpp b11531 CUDA, 32k context, Q4_K_M, all 33 layers on the GPU, 6.1 GB of buffers, 107 tok/s), but today's build, v0.3.35, frozen for the run. Lab folder `~/ws/hermit-agent-lab/2026-11-02-q35-9b/`.

| Suite | Native | Text |
|---|---|---|
| Quick | 5/5 | 3/5 |
| Full suite × 2 | 23/27 and 23/27 = 46/54 (85 %), 20 min | 37/54 (69 %), 21 min |
| App task × 2 | 0/2 | 0/2 |

- **The best small model on short tasks.** 46/54 natively against 42 for Qwen3.5-4B and 37 for Qwen3-8B, and as fast as the 4B (7 to 40 s per task).
- **Failed in both native runs:** code + tests (20 steps debugging its own Roman-numeral parser), PDF report, PowerPoint deck (guessed python-pptx chart calls). Library tasks (Excel, Word, OpenDocument, QR) and the harder ones (spec to code, log analysis, rename across a project) mostly passed.
- **Text mode is weaker,** as for every small model. A typical miss: it writes a script with the file tag, then writes the same file again instead of running it, and the loop guard pauses the run.
- **The app task:** 0 of 4, but one native run kept its plan up to step 7 of 8 when it hit the 20-step limit. A run with a 40-step limit, as Qwen3.8-27B once had, would show whether it gets there.
- In a tidy-up task it deleted two files it had just moved. The harness approves everything; a person would have seen "deletes your file jan.csv" and could have rejected it.

## Gemma

| Date | Model | Suite | Native | Text |
|---|---|---|---|---|
| 10-25 | gemma-4-E4B-it Q4_K_M, 131k ctx, 4.7 GB on the GPU | Quick | 4/5 | 5/5 |
| 10-25 | same | Full | 21/27 (14 min) | 19/27 (11 min) |
| 10-30 | a Gemma-4 GGUF on port 9941 (the file name was not recorded) | 6 tasks × 2 | 12/12 (15 min) | 12/12 (13 min) |

- Gemma-4-E4B sits with Qwen3.5-4B at the top of the small models: 21/27 native, and better than every small Qwen in text mode (19/27). Decode 121 tok/s.
- Shared misses in both protocols: code + tests, data processing, log analysis, markdown to html, powerpoint deck.
- It was never run on the app task. That is the open question for an in-browser default.
- The 10-30 runs passed everything but took three to four times as long as Qwen3.8-27B on the same six tasks.

## gpt-oss-20b (2026-10-30)

| Run | Native | Text |
|---|---|---|
| 6 tasks × 2, first attempt | 0/12 (1 min) | 2/12 (3 min) |
| Second attempt | 0/6, crashed | 5/12 (22 min) |
| Single-task error check | 0/1 | 0/1 |

gpt-oss-20b can't drive the agent. In text mode it calls its built-in harmony `python` tool instead of writing a code block, so replies arrive empty. Natively it often writes a malformed final header that llama.cpp's parser rejects with a 500. Not useful as a second model for protocol questions.

## Reasoning effort × protocol (2026-10-30)

Qwen3.8-27B IQ3_S, the build of that day, every effort level in both protocols.

| Effort | 6 tasks, native | 6 tasks, text | App × 2, native | App × 2, text |
|---|---|---|---|---|
| Off | 6/6, 0.8 min | 5/6, 1.5 min | 2/2, 24 and 10 steps | 2/2, 5 and 21 steps |
| Low | 6/6, 3.4 min | 6/6, 1.3 min | 2/2, 16 and 14 steps | 2/2, 6 and 7 steps |
| Medium | 6/6, 1.7 min | 6/6, 1.2 min | 2/2, 13 and 9 steps | 2/2, 6 and 16 steps |
| High | 6/6, 2.9 min | 6/6, 3.5 min | 2/2, 10 and 14 steps | 2/2, 12 and 9 steps |

- 47 of 48 runs passed. The one miss was "rename across a project" with reasoning off, in text mode.
- On this model the effort level barely changes the pass rate. Off is fastest on short tasks but needed the most steps in two app runs (24 and 21).
- One run per cell on short tasks and two on the app task: a pattern, not a measurement.

## Long-context recall with the agent (2026-10-31)

Can the agent find facts in a document larger than its context? Qwen3.8-27B IQ3_S, native, with a 277k-character book (Moby Dick) and a food knowledge base in the workspace.

| Run | Result | Steps, time |
|---|---|---|
| Six recall questions | 5/6 | 0.9 min. Miss: "no overlap: cheese". |
| Knowledge-base task, first attempt | 0/1 | 20 steps (the limit), 3 min |
| Knowledge-base task, second attempt | 1/1 | 26 steps, 3 min |
| Same task using ask_llm, v0.3.29 | 1/1 | 22 steps, 13 min |
| Same task using ask_llm, v0.3.30 | 1/1 | 19 steps, 16 min |

3 of 12 ask_llm requests on parts of the book came back empty: Low reasoning spent the whole 8,192-token budget before writing an answer. That led to the v0.3.30 changes ([REVIEW_NOTES.md](../hermit-agent/REVIEW_NOTES.md), "ask_llm reasoning level and budget"): the session caps the level, the budget is twice Max tokens, and an empty answer is retried once with reasoning off.

A separate probe of the model itself, without the agent, is a local note (not in the repo).

## Known flakes

These miss now and then on Qwen3.8-27B and are not regressions:
- **calculation**: numpy's int32 sum overflows past 2³¹. About 40 % of runs before the 2026-10-07 prompt line about it, about 10 % after.
- **data processing**: the model names the column `amount` instead of the requested `total`, and says in its answer that it is `total`. About half the text-mode runs on the IQ3_S model.

To tell a flake from a regression, rerun the task on the old build.

## Gaps

- The result files leave `model` empty, so the model is known only from file names, lab scripts and notes. The Gemma GGUF of 2026-10-30 is unknown for that reason. Recording `/props` `model_path` in each result would close this.
- Gemma-4-E4B and Gemma-4-12B have no app-task run, and Gemma-4-12B no agent run at all. Gemma-4-E4B ran on v0.3.19, Qwen3.5-9B on v0.3.35, so a rerun on the same build would make them comparable.
- Only Qwen3.5-9B ran with the error-repeat guard (v0.3.21); no other small model has.
- No model has been run in the browser through wllama yet (Phase 4 port).
- Most cells have one or two runs. Between two runs a small model moved by up to 6 tasks of 27.

## Where the data is

| Batch | Local folder |
|---|---|
| Phase 1 to 3.7 | Results quoted in ROADMAP; the JSON files were in `hermit-agent/tests/results/` (gitignored) and are mostly gone. |
| Floor, Gemma-4-E4B, fit and q8draft runs | `~/ws/hermit-agent-lab/2026-10-25-floor/` (`results/`, chain logs, `logs/` for the server logs) |
| Plan A/B and app runs | `~/ws/hermit-agent-lab/2026-10-24-plan-ab/` |
| Protocol, effort, Gemma, gpt-oss | `~/ws/hermit-agent-lab/2026-10-30-protocol/` |
| Recall | `~/ws/hermit-agent-lab/2026-10-31-recall/` |
| Qwen3.5-9B | `~/ws/hermit-agent-lab/2026-11-02-q35-9b/` |
