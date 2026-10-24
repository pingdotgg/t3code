#!/usr/bin/env bash
# Reproduces #8701: run in a T3 Code terminal, scroll to the top, and note the
# oldest retained T3-SCROLLBACK marker. Compare that marker before and after the
# fix; the scrollback budget is bytes, so which row survives depends on width.
printf '\033c'
cols=$(tput cols 2>/dev/null || printf '?')
i=1
while [ "$i" -le 12000 ]; do
  printf 'T3-SCROLLBACK-%05d\n' "$i"
  i=$((i+1))
done
printf 'T3-END cols=%s\n' "$cols"
