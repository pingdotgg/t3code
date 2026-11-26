#!/usr/bin/env bash
# Layers a mobile video: the story render (render.sh), the 3D phone (phone-3d.mjs) until the phone
# beats end, and optionally a 1200×750 tablet clip in the story's .tablet-stage hole, then writes
# a QA contact sheet. Usage:
#   mobile-composite.sh <dir> <out-name> <story.mp4> <phone-end-s> [<tablet.mp4> <tablet-start-s>]
# phone-end-s: 2 + phone-live length + 0.3; tablet-start-s: when the story's tablet hole appears.
set -euo pipefail
dir=${1:?usage: mobile-composite.sh <dir> <out-name> <story.mp4> <phone-end-s> [<tablet.mp4> <tablet-start-s>]}
name=${2:?out name}; story=${3:?story mp4}; phone_end=${4:?phone end seconds}
tablet=${5:-}; tablet_start=${6:-}
skill=$(cd "$(dirname "$0")/.." && pwd)
cd "$dir"
inputs=(-i "$story" -i phone-3d.mov)
graph="[0:v][1:v]overlay=0:0:eof_action=pass:enable='lt(t,$phone_end)'"
if [ -n "$tablet" ]; then
  len=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$tablet")
  out_at=$(python3 -c "print(round($len-0.35,3))")
  end=$(python3 -c "print(round($tablet_start+$len,3))")
  inputs+=(-i "$tablet" -loop 1 -i "$skill/assets/tablet-mask.png")
  graph="$graph[bg];[2:v]format=rgba[tab];[3:v]format=gray[m];\
[tab][m]alphamerge,fade=t=in:st=0:d=0.32:alpha=1,fade=t=out:st=$out_at:d=0.35:alpha=1,setpts=PTS+$tablet_start/TB[t];\
[bg][t]overlay=360:240:eof_action=pass:enable='between(t,$tablet_start,$end)'"
fi
ffmpeg -hide_banner -loglevel error -y "${inputs[@]}" -filter_complex "$graph,format=yuv420p[out]" \
  -map "[out]" -r 30 -c:v libx264 -preset slow -crf 17 -pix_fmt yuv420p -movflags +faststart -an "$name.mp4"
d=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$name.mp4")
ffmpeg -hide_banner -loglevel error -y -i "$name.mp4" \
  -vf "fps=16/$d,scale=480:270:flags=lanczos,tile=4x4" -frames:v 1 "$name-sheet.png"
echo "$dir/$name.mp4 (${d}s), sheet $dir/$name-sheet.png"
