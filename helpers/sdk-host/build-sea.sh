#!/usr/bin/env bash
# Builds dist/conn-sdk-host: the helper as a Node single executable, with the Node that
# runs this script (use the version the T3 server ships, Node 26.12.1). See README.md.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
npm ci --no-audit --no-fund
rm -rf dist && mkdir dist
# A single executable's main module has no import.meta.url; the SDK passes it to createRequire.
# Give it the executable's own file URL.
npx esbuild index.mjs --bundle --platform=node --format=esm --target=node24 \
  --define:import.meta.url=__connSdkHostUrl \
  --banner:js='import { pathToFileURL as __connPathToFileURL } from "node:url"; const __connSdkHostUrl = __connPathToFileURL(process.execPath).href;' \
  --outfile=dist/helper.mjs --log-level=warning
cat > dist/sea-config.json <<'JSON'
{
  "main": "helper.mjs",
  "mainFormat": "module",
  "output": "conn-sdk-host",
  "disableExperimentalSEAWarning": true,
  "useCodeCache": false
}
JSON
(cd dist && node --build-sea sea-config.json)
if [ "$(uname)" = "Darwin" ]; then codesign --sign - --force dist/conn-sdk-host; fi
echo '{"t":"shutdown"}' | dist/conn-sdk-host
ls -la dist/conn-sdk-host
