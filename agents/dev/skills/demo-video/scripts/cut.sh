#!/bin/sh
# cut.sh TAKE SEGMENT START END SPEED
# Cuts START..END seconds of $VIDEO_DIR/footage/TAKE.mp4, speeds it up SPEED times and writes
# $VIDEO_DIR/footage/seg/SEGMENT.mp4 at 30 fps with no audio and a zero start time, so a shot
# plays it at 1x from its first frame. Prints the segment's length for the shot's `len`.
set -eu
video_dir=${VIDEO_DIR:-$HOME/video}
mkdir -p "$video_dir/footage/seg"
out="$video_dir/footage/seg/$2.mp4"
ffmpeg -v error -y -ss "$3" -to "$4" -i "$video_dir/footage/$1.mp4" -an \
  -vf "setpts=(PTS-STARTPTS)/$5,fps=30" \
  -c:v libx264 -preset veryfast -crf 14 -pix_fmt yuv420p -g 30 -bf 0 "$out"
printf '%s %s\n' "$2" "$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$out")"
