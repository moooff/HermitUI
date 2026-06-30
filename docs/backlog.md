# HermitUI Backlog

This document tracks upcoming features, tasks, and ideas for the HermitUI project.

## 📝 To-Do
- [ ] **Local Model Text Analysis (Browser-based Standalone App)**
  - Create a separate application (e.g., `hermit-local.html`) to prevent bloat in the main HermitUI application (`dist/hermit-ui-standalone.html`).
  - Extract common CSS (`src/styles.css`) and core JS (`src/core.js`) from `src/hermit-ui.src.html`.
    - *Note:* This is the explicit `build.py`-workflow exception to the Single File Constraint in `AGENTS.md` — the split source files must still be inlined by `build.py` so every shipped output remains a standalone single-file `.html`.
  - Update `build.py` to inject the shared CSS/JS and generate both standalone apps in the same repository.
  - Use `Transformers.js` with WebGPU acceleration (with a fallback to WebAssembly).
  - Target ultra-small models (< 200MB) like specialized T5 or SmolLM.
  - Dedicated specifically for text analysis and summarization tasks.

## 🚧 In Progress
- [ ] 

## ✅ Completed
- [x] Create backlog.md

