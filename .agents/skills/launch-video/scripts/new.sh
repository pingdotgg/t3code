#!/usr/bin/env bash
# Creates a launch-video working directory from the template. Usage: new.sh <dir>
set -euo pipefail
dir=${1:?usage: new.sh <dir>}
skill=$(cd "$(dirname "$0")/.." && pwd)
repo=$(cd "$skill/../../.." && pwd)
if [ -e "$dir/story.html" ]; then echo "$dir/story.html already exists" >&2; exit 1; fi
mkdir -p "$dir"
cp "$skill/template/story.html" "$skill/assets/kit.js" "$skill/assets/inter.woff2" "$skill/assets/jbmono.woff2" "$dir/"
cp "$repo/assets/prod/black-macos-1024.png" "$dir/logo-prod.png"
echo "$dir is ready: edit $dir/story.html"
