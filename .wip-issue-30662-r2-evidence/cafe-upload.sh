#!/usr/bin/env bash
# Scratch: upload images as GitCafe repo attachments (ghdrop stand-in). Prints ![name](url) per file.
set -euo pipefail
repo=pingdotgg/t3code
for f in "$@"; do
  sha=$(sha256sum "$f" | cut -d' ' -f1)
  size=$(stat -c %s "$f")
  name=$(basename "$f")
  key="issue-30662-r2-$sha"
  res=$(cafe api "/repos/$repo/attachments/" --raw-field "requestKey=$key" --raw-field "sha256=$sha" --field "size=$size")
  id=$(printf '%s' "$res" | python3 -I -c 'import json,sys;print(json.load(sys.stdin)["id"])')
  state=$(printf '%s' "$res" | python3 -I -c 'import json,sys;print(json.load(sys.stdin)["state"])')
  if [ "$state" != "ready" ]; then
    cafe api "/repos/$repo/attachments/$id" --method PUT --header "Content-Type:application/octet-stream" --input "$f" >/dev/null
  fi
  echo "![$name](https://git.cafe/api/attachments/$id)"
done
