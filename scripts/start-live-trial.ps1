Remove-Item -Force runs/trial-live/agents/dynasty-alpha.jsonl -ErrorAction SilentlyContinue
$envLines = Get-Content .env
foreach ($line in $envLines) {
    if ($line -match '^([^=]+)=(.*)$') {
        [Environment]::SetEnvironmentVariable($matches[1].Trim(), $matches[2].Trim())
    }
}
$env:ERIS_LOCAL_DEPLOY = "1"
$env:CF_ACCESS_CLIENT_ID = $env:CF_ID
$env:CF_ACCESS_CLIENT_SECRET = $env:CF_SECRET
$env:ERIS_RPC_HEADERS = (@{ "X-ASCON-Key" = $env:ASCON_KEY } | ConvertTo-Json -Compress)
$env:ERIS_MANIFEST = "runs/trial-live/manifest.json"
$env:ERIS_CONFIG = "config/practice.yaml"
$env:ERIS_RUN_DIR = "runs/trial-live"
$env:ERIS_AGENT_PRIVATE_KEY = $env:AGENT_PRIVATE_KEY
$env:ERIS_AGENT_DIR = "example/agents/dynasty-alpha"
$env:ERIS_AGENT_ID = "dynasty-alpha"

node --import tsx example/agents/runtime/bot.ts
