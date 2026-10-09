# Reword benchmark

Measures how well GGUF models do the Cleaner's **Reword** step, through the
unmodified app. Use it to pick a model to recommend, and before and after every
change to the reword prompt.

```bash
../benchmark/.venv/bin/python bench/bench.py                        # default ladder, judged
../benchmark/.venv/bin/python bench/bench.py --models Qwen3-4B-Q4_K_M.gguf --runs 1
../benchmark/.venv/bin/python bench/bench.py --levels light --texts de --judge none
../benchmark/.venv/bin/python bench/bench.py --app /tmp/patched.html --label prompt-b   # a prompt A/B
../benchmark/.venv/bin/python bench/bench.py --backend wllama --models Qwen3-1.7B-Q4_K_M.gguf --runs 1
```

Run it from `hermit-cleaner/` after `python3 build.py`. Models are read from
`../benchmark/models/`, filled by `../benchmark/download_models.py`. A full run of
the default ladder (Qwen3 0.6B, 1.7B, 4B, 8B, Qwen3.5 4B, Gemma-4 E2B and E4B;
`Qwen3.5-4B-Q4_K_M.gguf` is from `unsloth/Qwen3.5-4B-GGUF`, not in the download script) takes about
20-30 minutes on an RTX 5070 Ti, most of it judging. Launch it detached and watch
the log.

## How it works

1. **The model server.** For each model, `bench.py` starts llama.cpp's `llama-server`
   on the GPU. The build is pinned (`LLAMA_TAG`, the Ubuntu CUDA 12.8 one) and is
   downloaded once into `~/.cache/hermit-cleaner-bench/` (about 770 MB). `--api URL`
   uses a server that is already running instead.
2. **The app.** Headless Chromium opens the built
   `dist/hermit-cleaner-standalone.html`, configures it for that server, and presses
   Run for every text in `corpus.json` at every level (`--levels`), by sentence, with
   every sentence picked, `--runs` times. Four pages work at once against four
   server slots (`--parallel`), after one warm-up run each.
   - `--backend wllama` loads the model into the `-wllama` build instead, as a user
     would. It runs one page on the CPU (or `--webgpu`), and is slow.
3. **The judge.** Every rewrite is then scored 1-5 for **meaning**, **grammar** and
   **natural** by a judge model on the same server. The default is the local
   gpt-oss-20b (else Qwen3-8B); `--judge-api` uses a running server, and
   `--judge none` skips this step. The judge is told what the Cleaner is for, so
   replacing hype and stock phrases doesn't cost meaning points. Before judging, it
   scores five known pairs (an inverted meaning, a changed number, a German grammar
   error, two harmless phrase drops). The report says how many it got right.

## What the report says

`results/<time>-<label>/` (gitignored) holds:
- `review.md`: the summary, judge grammar per language, a recommendation per level,
  every rewrite the judge scored 3 or lower, and the refusals
- `samples.md`: every original/rewrite pair, with its scores
- `run.json`: everything, including the server logs' location and the arguments

Per model and level:

| Column | Meaning |
|---|---|
| Accepted / Unchanged | share of sentences reworded and kept, or returned as they were |
| Refused | requests the app threw away (wrong language, an introduction, too long, a Light edit that changed too much) |
| 2nd try (reworded) | sentences that got the app's one retry after an unchanged or refused reply, and how many it then reworded |
| Words changed | median share of words changed per request (the app's `wordDiff`) |
| Stock phrases removed | how many of the corpus's `stock_phrases` disappeared |
| Numbers / Names kept | rewrites with the same numbers, and with every listed name of the text |
| Meaning, Grammar, Natural | the judge's averages; Bad counts rewrites at 3 or lower on meaning or grammar |
| s/run, decode tok/s | one text through the app; the server's decode speed (from `/metrics`) |

Speeds are those of llama-server on the GPU, not of the browser. For in-browser
speed, use `--backend wllama` or see the table in `../README.md`.

## Things learned building it

- **Mentioning another language in the prompt pulls small models into it.** The
  prompt used to say "German stays German" and list German stock phrases for every
  passage. Qwen3-1.7B then answered one English sentence in German 22 times in 120.
  With the phrases listed only in the passage's language, it was 0 in 120. The app
  refused those replies anyway, but each was a lost rewrite.
- **Parallel slots change the samples a little.** At temperature 0, 9 of 20 replies
  sent four at a time matched those sent one at a time, with or without a shared KV
  cache: llama.cpp's results depend on the batch. With the old prompt, the shared cache
  (`kv_unified`, llama-server's default for parallel slots) made the German drift far
  worse (92 of 120 with German requests in flight, against 27 with separate caches),
  so the server runs with `--no-kv-unified`.
- The number check and the judge catch different things: a dropped "in just 45
  seconds" got meaning 4 from the judge but fails Numbers kept.
- Headless Chromium in WSL only has a software WebGPU, so `--backend wllama` stays on
  the CPU unless `--webgpu` is given.
- `llama-server` started from a shell with `cd dir && ./llama-server &` survives a
  `kill $!` (that kills the subshell), and its VRAM then fails the next run's
  idle-GPU check. `bench.py` keeps the process handle and stops it itself.
