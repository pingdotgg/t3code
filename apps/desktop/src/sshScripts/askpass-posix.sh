#!/bin/sh
set -eu
PROMPT="${1:-SSH authentication}"
if [ "${T3_SSH_AUTH_SECRET+x}" = "x" ]; then
  printf "%s\n" "$T3_SSH_AUTH_SECRET"
  exit 0
fi
if command -v osascript >/dev/null 2>&1; then
  T3_SSH_ASKPASS_PROMPT="$PROMPT" /usr/bin/osascript <<'APPLESCRIPT'
set promptText to system attribute "T3_SSH_ASKPASS_PROMPT"
try
  set dialogResult to display dialog promptText default answer "" with hidden answer buttons {"Cancel", "OK"} default button "OK" cancel button "Cancel"
  text returned of dialogResult
on error number -128
  error number -128
end try
APPLESCRIPT
  exit $?
fi
if command -v zenity >/dev/null 2>&1; then
  zenity --password --title="SSH authentication" --text="$PROMPT"
  exit $?
fi
if command -v kdialog >/dev/null 2>&1; then
  kdialog --title "SSH authentication" --password "$PROMPT"
  exit $?
fi
if command -v ssh-askpass >/dev/null 2>&1; then
  ssh-askpass "$PROMPT"
  exit $?
fi
printf 'Unable to open an SSH password prompt on this desktop.\n' >&2
exit 1
