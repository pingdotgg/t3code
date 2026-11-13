#!/usr/bin/env bash
# Builds dist/conn-claude-sdk-helper: the helper as a Node single executable, with the Node that
# runs this script (use the version the T3 server ships, Node 26.12.1). See README.md.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
npm ci --no-audit --no-fund
rm -rf dist && mkdir dist
npx esbuild index.mjs --bundle --platform=node --format=esm --target=node24 \
  --outfile=dist/helper.mjs --log-level=warning
cat > dist/sea-config.json <<'JSON'
{
  "main": "helper.mjs",
  "mainFormat": "module",
  "output": "conn-claude-sdk-helper",
  "disableExperimentalSEAWarning": true,
  "useCodeCache": false
}
JSON
(cd dist && node --build-sea sea-config.json)
if [ "$(uname)" = "Darwin" ]; then codesign --sign - --force dist/conn-claude-sdk-helper; fi
echo '{"t":"shutdown"}' | dist/conn-claude-sdk-helper
ls -la dist/conn-claude-sdk-helper
