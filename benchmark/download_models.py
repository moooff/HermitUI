#!/usr/bin/env python3
"""Download the benchmark model ladder into benchmark/models/ (gitignored).

Idempotent: files already present with the expected size are skipped, partial
downloads are resumed via HTTP Range. Stdlib only.
"""
import sys
import urllib.request
from pathlib import Path

sys.stdout.reconfigure(line_buffering=True)

MODELS_DIR = Path(__file__).parent / "models"

# The ladder, smallest first within each family. The ~5 GB rungs (Qwen3-8B,
# Gemma-4-E4B) need a browser with WASM Memory64 (current Chrome/Edge have it);
# on older wasm32-only browsers they fail to load and the harness records that
# as the device's ceiling.
# "family" groups rungs so a too-slow/failed rung only skips the rest of its
# own family; "nothink" marks models with a /no_think soft switch (Qwen3).
LADDER = [
    {
        "name": "Qwen3-0.6B",
        "file": "Qwen3-0.6B-Q4_K_M.gguf",
        "repo": "unsloth/Qwen3-0.6B-GGUF",
        "family": "qwen3",
        "nothink": True,
    },
    {
        "name": "Qwen3-1.7B",
        "file": "Qwen3-1.7B-Q4_K_M.gguf",
        "repo": "unsloth/Qwen3-1.7B-GGUF",
        "family": "qwen3",
        "nothink": True,
    },
    {
        "name": "Qwen3-4B",
        "file": "Qwen3-4B-Q4_K_M.gguf",
        "repo": "unsloth/Qwen3-4B-GGUF",
        "family": "qwen3",
        "nothink": True,
    },
    {
        "name": "Qwen3-8B",
        "file": "Qwen3-8B-Q4_K_M.gguf",
        "repo": "unsloth/Qwen3-8B-GGUF",
        "family": "qwen3",
        "nothink": True,
    },
    {
        "name": "Gemma-4-E2B",
        "file": "gemma-4-E2B-it-Q4_K_M.gguf",
        "repo": "unsloth/gemma-4-E2B-it-GGUF",
        "family": "gemma4",
    },
    {
        "name": "Gemma-4-E4B",
        "file": "gemma-4-E4B-it-Q4_K_M.gguf",
        "repo": "unsloth/gemma-4-E4B-it-GGUF",
        "family": "gemma4",
    },
    {
        "name": "Gemma-4-12B",
        "file": "gemma-4-12b-it-Q4_K_M.gguf",
        "repo": "unsloth/gemma-4-12b-it-GGUF",
        "family": "gemma4",
    },
]

CHUNK = 1 << 20  # 1 MiB


def hf_url(model: dict) -> str:
    return f"https://huggingface.co/{model['repo']}/resolve/main/{model['file']}"


def remote_size(url: str) -> int:
    req = urllib.request.Request(url, method="HEAD")
    with urllib.request.urlopen(req) as resp:
        return int(resp.headers["Content-Length"])


def download(model: dict) -> Path:
    dest = MODELS_DIR / model["file"]
    url = hf_url(model)
    total = remote_size(url)
    have = dest.stat().st_size if dest.exists() else 0
    if have == total:
        print(f"✅ {model['file']} already complete ({total / 1e9:.2f} GB), skipping")
        return dest
    if have > total:  # corrupt leftover — start over
        dest.unlink()
        have = 0

    headers = {}
    mode = "wb"
    if have:
        headers["Range"] = f"bytes={have}-"
        mode = "ab"
        print(f"↻ resuming {model['file']} at {have / 1e9:.2f} GB")
    else:
        print(f"⬇️  {model['file']} ({total / 1e9:.2f} GB) from {model['repo']}")

    req = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(req) as resp, open(dest, mode) as out:
        done = have
        while True:
            chunk = resp.read(CHUNK)
            if not chunk:
                break
            out.write(chunk)
            done += len(chunk)
            pct = done * 100 // total
            print(f"\r   {done / 1e9:.2f} / {total / 1e9:.2f} GB ({pct}%)", end="", flush=True)
    print()
    got = dest.stat().st_size
    if got != total:
        sys.exit(f"❌ {model['file']}: got {got} bytes, expected {total} — rerun to resume")
    return dest


def main():
    MODELS_DIR.mkdir(exist_ok=True)
    for model in LADDER:
        download(model)
    print("🏁 all ladder models present in", MODELS_DIR)


if __name__ == "__main__":
    main()
