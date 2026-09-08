#!/bin/bash
# Deterministic build for the Cloudflare StaticSite: copy src/ -> dist/.
# `alchemy dev` runs this on every re-apply, so the stress suite's stack
# storms exercise the build/deploy interlock too.
set -euo pipefail
rm -rf dist
mkdir -p dist
cp -R src/. dist/
