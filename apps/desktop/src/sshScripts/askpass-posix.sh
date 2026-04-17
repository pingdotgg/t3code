#!/bin/sh
# Invoked by ssh via SSH_ASKPASS when T3 Code re-runs ssh with a cached password
# from the renderer's in-app prompt. We never expose a native dialog here — if
# T3_SSH_AUTH_SECRET is missing, that's a caller bug and we fail loudly.
if [ "${T3_SSH_AUTH_SECRET+x}" = "x" ]; then
  printf "%s\n" "$T3_SSH_AUTH_SECRET"
  exit 0
fi
printf 'T3 Code ssh-askpass invoked without T3_SSH_AUTH_SECRET.\n' >&2
exit 1
