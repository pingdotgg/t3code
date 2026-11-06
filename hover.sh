#!/usr/bin/env bash
# hover.sh <outdir> <cdp_port> <winx> <winy>: real XTest pointer moves over the Favorites button, in and below the 40px header strip.
set -u; OUT=$1; P=$2; WX=$3; WY=$4; D=/tmp/issue-lead-31783-r1/repro
. "$OUT/display.env"
node $D/cdp.mjs $P '(()=>{window.__ev=[];const pop=document.querySelector("[data-slot=popover-popup]");["pointerover","pointermove","pointerenter"].forEach(t=>pop.addEventListener(t,e=>window.__ev.push(t+"@"+Math.round(e.clientX)+","+Math.round(e.clientY)),true));return "armed"})()'
state='(()=>{const f=[...document.querySelectorAll("button")].find(b=>(b.getAttribute("aria-label")||"")==="Favorites");const tip=[...document.querySelectorAll("[data-slot=tooltip-popup],[role=tooltip]")].map(t=>t.innerText.trim()).filter(Boolean);const n=window.__ev.length;const last=window.__ev.slice(-2);window.__ev=[];return {favHover:f.matches(":hover"),tooltips:tip,events:n,last}})()'
python3 $D/xptr.py move $((WX+200)) $((WY+500)); sleep 1
for y in 20 30 38 43; do
  python3 $D/xptr.py move $((WX+466)) $((WY+y)); sleep 0.3; python3 $D/xptr.py move $((WX+467)) $((WY+y)); sleep 1.5
  echo "y=$y $(node $D/cdp.mjs $P "$state" | tr -d '\n ')"
  import -window root -crop ${WW:-1100}x${WH:-780}+$WX+$WY "$OUT/hover-y$y.png"
done
