#!/usr/bin/env bash
if [[ ${BASH_SOURCE[0]} == "$0" ]]; then
  set -eu
  mkdir -p /tmp/t3-terminal-evidence
  exec env -i HOME=/tmp/t3-terminal-evidence PATH=/usr/bin:/bin TERM=xterm-256color LANG=C.UTF-8 LC_ALL=C.UTF-8 EVIDENCE_PANE="${1:-A}" bash --noprofile --rcfile "$0" -i
fi
cd /tmp/t3-terminal-evidence
HISTFILE=/dev/null
set +o history
fixture_prompt() {
  local width fill
  width=$(stty size); width=${width##* }
  printf -v fill '%*s' "$((width > 12 ? width - 12 : 1))" ''
  PS1="\[\e[36m\]LEFT-${fill// /-}-RIGHT\[\e[0m\]\n\[\e[32m\]pane ${EVIDENCE_PANE} READY\[\e[0m\] ANSI blue: \[\e[34m\]0123456789\[\e[0m\]\nevidence:/fixture $ "
  printf '\033[?25l'
  stty size > /tmp/t3-terminal-evidence/input-size
  printf '%s\n' "$EVIDENCE_PANE" > "/tmp/t3-terminal-evidence/ready-${EVIDENCE_PANE}"
}
fixture_reset() { printf '\033[3J\033[H\033[2J'; }
fixture_scrollback() {
  local n
  for ((n=1;n<=80;n++)); do printf 'SCROLL %03d | deterministic terminal output | RIGHT\n' "$n"; done
}
PROMPT_COMMAND=fixture_prompt
fixture_reset

# Leave the next command on the first physical line with a steady visible cursor.
fixture_input() {
  PROMPT_COMMAND=
  PS1=
  printf '\033[3J\033[H\033[2J\033[?25h\033[2 q'
  stty size > /tmp/t3-terminal-evidence/input-size
  printf 'input\n' > /tmp/t3-terminal-evidence/ready-input
}
