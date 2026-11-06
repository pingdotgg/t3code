#!/usr/bin/env bash
# click.sh <outdir> <cdp_port> <winx> <winy> <relx> <rely>: real XTest click; report focused element and window position after.
set -u; OUT=$1; P=$2; WX=$3; WY=$4; D=/tmp/issue-lead-31783-r1/repro
. "$OUT/display.env"
python3 $D/xptr.py click $((WX+$5)) $((WY+$6)); sleep 1
echo "click@$5,$6 $(node $D/cdp.mjs $P '({popupText:document.querySelector("[data-slot=popover-popup]")?.innerText.replace(/\s+/g," ").slice(0,90), screen:[screenX,screenY]})' | tr -d "\n")"
import -window root -crop ${WW:-1100}x${WH:-780}+$WX+$WY "$OUT/click-$5-$6.png"
