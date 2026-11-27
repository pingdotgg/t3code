#!/usr/bin/env bash
# Creates a launch-video working directory. Usage: new.sh <dir> [real|mock|mobile]
#   real (default): template/real.html, a story over frozen pages of the real app (beats/).
#   mock: template/story.html, a hand-built HTML mock of the app.
#   mobile: stagings/mobile-2.4/story.html, copy beside a 3D phone plus a tablet beat.
set -euo pipefail
dir=${1:?usage: new.sh <dir> [real|mock|mobile]}
mode=${2:-real}
skill=$(cd "$(dirname "$0")/.." && pwd)
repo=$(cd "$skill/../../.." && pwd)
if [ -e "$dir/story.html" ]; then echo "$dir/story.html already exists" >&2; exit 1; fi
case "$mode" in
  real) template=template/real.html ;;
  mock) template=template/story.html ;;
  mobile) template=stagings/mobile-2.4/story.html ;;
  *) echo "mode is real, mock or mobile" >&2; exit 2 ;;
esac
mkdir -p "$dir"
cp "$skill/$template" "$dir/story.html"
cp "$skill/assets/kit.js" "$skill/assets/inter.woff2" "$skill/assets/jbmono.woff2" "$dir/"
cp "$repo/assets/prod/black-macos-1024.png" "$dir/logo-prod.png"
echo "$dir is ready ($mode): edit $dir/story.html"
