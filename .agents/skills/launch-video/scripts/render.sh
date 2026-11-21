#!/usr/bin/env bash
# Renders <dir>/story.html to <dir>/<name>.mp4 (1920x1080, 30 fps) and <dir>/outro.png (its last frame).
# Usage: render.sh <dir> [name]
set -euo pipefail
dir=$(cd "${1:?usage: render.sh <dir> [name]}" && pwd)
name=${2:-video}
here=$(cd "$(dirname "$0")" && pwd)
node "$here/capture.mjs" "$dir/story.html" "$dir/frames"
ffmpeg -hide_banner -loglevel error -y -reinit_filter 0 -framerate 30 -i "$dir/frames/f%04d.png" \
  -c:v libx264 -preset slow -crf 16 -pix_fmt yuv420p -movflags +faststart "$dir/$name.mp4"
cp "$(ls "$dir/frames"/f*.png | tail -1)" "$dir/outro.png"
ffprobe -v error -show_entries format=duration:stream=width,height -of default=nw=1 "$dir/$name.mp4"
echo "video -> $dir/$name.mp4, outro -> $dir/outro.png"
