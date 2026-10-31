# start-qwen38.ps1 - llama-server with Qwen3.8-27B IQ3_S + MTP on a 16 GB card (RTX 5070 Ti)
# Usage: put it next to llama-server.exe, set $model below, then right-click -> "Run with PowerShell"
#
# Settings come from the measurements of 2026-10-25 (hermit-agent Phase 4 lab) and
# 2026-10-31 (reports/llama-server-16gb-tuning.md):
# - KV cache q8_0 (main and MTP draft). Against q4_0 it needed fewer steps on the long app
#   task (3/3 at ~13 steps vs 2/3 at ~22) at the same speed.
# - draft-mtp with the default 3 drafted tokens: 75-85 % accepted on code.
# - -ub 256: ~280 MB less VRAM than 512. -ub 1024 processes prompts 13-20 % faster but costs
#   ~700 MiB (~13k tokens of context); with it, set $ctxOverride, since the formula below
#   assumes 256.
# - Context is sized from the free VRAM. With MTP, llama.cpp reserves the main compute
#   buffer a second time on the first request (llama.cpp issue #27282), and Windows moves
#   whatever doesn't fit into shared system memory WITHOUT an error: decode drops from ~110
#   to 1-18 tok/s. The script therefore keeps 200 MB spare and checks the speed after start.
#   Better still: NVIDIA Control Panel -> Manage 3D settings -> Program Settings ->
#   llama-server.exe -> "CUDA - Sysmem Fallback Policy" = "Prefer No Sysmem Fallback".
#   A context that doesn't fit then fails with an out-of-memory error instead.
# The VRAM figures below are for this model file (27B IQ3_S with MTP, ~12.1 GB) and
# llama.cpp b12017 (Windows CUDA 13.4 build). A different model or build needs new figures.

$ErrorActionPreference = "Stop"
Set-Location -LiteralPath $PSScriptRoot

$port  = 9931          # if NVIDIA Broadcast is running it squats 127.0.0.1:8080 - the check below catches it
$exe   = Join-Path $PSScriptRoot "llama-server.exe"
$model = Join-Path $PSScriptRoot "Qwen3.8-27B-GSQ-RCO-IQ3_S-mtp.gguf"    # or the full path to your copy

$ctxOverride = 0       # 0: size the context from the free VRAM; or set a fixed value, e.g. 65536
$marginMiB   = 200     # spare VRAM; 25-80 MB spare still spilled in the tests

foreach ($p in @($exe, $model)) {
    if (-not (Test-Path -LiteralPath $p)) {
        Write-Host "Not found: $p" -ForegroundColor Red
        Read-Host "Press Enter to close" | Out-Null
        exit 1
    }
}

# Binding 0.0.0.0 does NOT fail when another process holds 127.0.0.1 on the same
# port - the server starts, then localhost traffic silently goes to that other
# process instead. Check first, or spend an hour debugging a phantom CORS error.
$busy = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
if ($busy) {
    Write-Host "Port $port is already in use by:" -ForegroundColor Red
    $busy | Select-Object -ExpandProperty OwningProcess -Unique | ForEach-Object {
        $p = Get-Process -Id $_ -ErrorAction SilentlyContinue
        if ($p) { Write-Host ("  PID {0}  {1}" -f $p.Id, $p.ProcessName) -ForegroundColor Yellow }
    }
    Write-Host "Edit `$port at the top of this script and try again." -ForegroundColor Red
    Read-Host "Press Enter to close" | Out-Null
    exit 1
}

# --spec-draft-n-ubatch (a smaller batch for the MTP draft context, ~100 MB less) only
# exists in newer builds (it is in b11871, not in b11531).
$help = (& $exe --help 2>&1 | Out-String)
$hasDraftUbatch = $help.Contains("--spec-draft-n-ubatch")

# Free VRAM as llama.cpp will see it: total minus what the desktop and other programs use.
$freeMiB = 0
try {
    $q = (& nvidia-smi --query-gpu=memory.total,memory.used --format=csv,noheader,nounits | Select-Object -First 1).Split(",")
    $freeMiB = [int]$q[0].Trim() - [int]$q[1].Trim()
} catch {
    Write-Host "nvidia-smi didn't answer; using a fixed context." -ForegroundColor Yellow
}

if ($ctxOverride -gt 0) {
    $ctx = $ctxOverride
} elseif ($freeMiB -gt 0) {
    # With q8_0/q8_0 and -ub 256: 57344 tokens need ~14500 MiB including the second compute
    # buffer on b12017 (14970 on b10678), each further 1024 tokens ~53 MiB; the small draft
    # batch saves ~104 MiB.
    $need57k = 14500
    if ($hasDraftUbatch) { $need57k -= 104 }
    $steps = [math]::Floor(($freeMiB - $marginMiB - $need57k) / 53)
    $ctx = 57344 + 1024 * $steps
    if ($ctx -gt 131072) { $ctx = 131072 }
    if ($ctx -lt 16384) {
        Write-Host ("Only {0} MiB of VRAM free - close GPU programs (browsers, Phone Link, G HUB) and try again." -f $freeMiB) -ForegroundColor Red
        Read-Host "Press Enter to close" | Out-Null
        exit 1
    }
} else {
    $ctx = 50000
}

$serverArgs = @(
    "--model", $model
    "--jinja"
    "--reasoning-format", "deepseek"
    "--reasoning-preserve"
    "--flash-attn", "on"
    "--cache-type-k", "q8_0"
    "--cache-type-v", "q8_0"
    "--spec-type", "draft-mtp"
    "--cache-type-k-draft", "q8_0"
    "--cache-type-v-draft", "q8_0"
    "--parallel", "1"
    "--batch-size", "1024"
    "--ubatch-size", "256"
    "--n-gpu-layers", "all"
    "--fit", "off"
    "--ctx-size", "$ctx"
    # Qwen's "thinking, precise coding" profile (from the Qwen3.6-27B card; none found for 3.8).
    # The general thinking profile is --temp 1.0; lower temperatures also tend to raise MTP acceptance.
    "--temp", "0.6"
    "--top-p", "0.95"
    "--top-k", "20"
    "--min-p", "0.0"
    "--repeat-penalty", "1.0"
    "--host", "0.0.0.0"
    "--port", "$port"
)
if ($hasDraftUbatch) { $serverArgs += @("--spec-draft-n-ubatch", "64") }

Write-Host ""
Write-Host "Starting llama-server - Qwen3.8-27B IQ3_S + MTP" -ForegroundColor Cyan
if ($freeMiB -gt 0) { Write-Host ("Free VRAM {0} MiB -> context {1} tokens (q8_0 cache)" -f $freeMiB, $ctx) -ForegroundColor Cyan }
if ($hasDraftUbatch) { Write-Host "This build has --spec-draft-n-ubatch: using 64" -ForegroundColor DarkGray }
Write-Host "Listening on 0.0.0.0:$port (reachable from your LAN)" -ForegroundColor Yellow
Write-Host "HermitUI -> Settings -> API URL: http://localhost:$port/v1/chat/completions" -ForegroundColor Green
Write-Host "Ctrl+C to stop." -ForegroundColor DarkGray
Write-Host ""

$server = Start-Process -FilePath $exe -ArgumentList $serverArgs -NoNewWindow -PassThru
try {
    # Wait until it serves, then check that nothing spilled into shared memory.
    $ready = $false
    for ($i = 0; $i -lt 300 -and -not $server.HasExited; $i++) {
        try {
            $h = Invoke-RestMethod -Uri "http://127.0.0.1:$port/health" -TimeoutSec 2
            if ($h.status -eq "ok") { $ready = $true; break }
        } catch { }
        Start-Sleep -Seconds 1
    }
    if ($ready) {
        # A ~2,000-token prompt as well: a spilled compute buffer can leave decode at full
        # speed while prompt processing drops from ~1,500 to ~100 tok/s (seen 2026-10-31).
        $filler = "The crew checked the ropes, counted the barrels and wrote everything in the log. " * 120
        $body = @{ prompt = $filler + "`nWrite a long Python module with several classes and docstrings:`n"; n_predict = 256; temperature = 0; cache_prompt = $false } | ConvertTo-Json
        try {
            $r = Invoke-RestMethod -Uri "http://127.0.0.1:$port/completion" -Method Post -ContentType "application/json" -Body $body -TimeoutSec 600
            $tps = [math]::Round($r.timings.predicted_per_second, 1)
            $pps = [math]::Round($r.timings.prompt_per_second)
            Write-Host ""
            if ($tps -lt 40 -or $pps -lt 400) {
                Write-Host ("SPEED CHECK: decode {0} tok/s, prompt {1} tok/s - part of the model spilled into shared GPU memory." -f $tps, $pps) -ForegroundColor Red
                Write-Host "Close GPU programs, or set `$ctxOverride lower (e.g. 4000 below the context above), and restart." -ForegroundColor Red
            } else {
                Write-Host ("SPEED CHECK: decode {0} tok/s, prompt {1} tok/s - everything is in VRAM." -f $tps, $pps) -ForegroundColor Green
            }
            Write-Host ""
        } catch {
            Write-Host "Speed check failed: $($_.Exception.Message)" -ForegroundColor Yellow
        }
    }
    Wait-Process -Id $server.Id
} finally {
    if (-not $server.HasExited) { Stop-Process -Id $server.Id -Force }
}

Write-Host ""
Read-Host "Server stopped. Press Enter to close" | Out-Null
