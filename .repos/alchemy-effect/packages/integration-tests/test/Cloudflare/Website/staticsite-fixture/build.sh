#!/bin/bash
# Minimal deterministic build for the StaticSite fixture: copy src/ -> dist/.
#
# We sleep briefly before *and* during the copy so that any Worker.update
# that races against this build (e.g. reading dist/ mid-write) has a wide
# enough window to actually trip. The user-visible bug this test guards
# against — "two deploys needed to publish assets" — only manifests when
# the build takes meaningful wall time, which a real astro/vite build
# does but a one-line `cp` does not.
set -euo pipefail
sleep 0.5
rm -rf dist
mkdir -p dist
sleep 0.5
cp -R src/. dist/
