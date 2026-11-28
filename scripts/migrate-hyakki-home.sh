#!/bin/sh
set -eu

if [ "$#" -ne 1 ] || [ "$1" != --confirm-legacy-is-hyakki ]; then
  printf '%s\n' 'Quit Hyakki, T3 Code, and any background server first. Run with --confirm-legacy-is-hyakki only if ~/.t3 belongs to Hyakki.' >&2
  exit 2
fi
if [ -n "${HYAKKI_HOME:-}" ]; then
  printf '%s\n' 'HYAKKI_HOME is set; leaving the selected home unchanged.' >&2
  exit 2
fi
old="$HOME/.t3"
new="$HOME/.hyakki"
if [ ! -d "$old" ] || [ -L "$old" ] || [ -e "$new" ] || [ -L "$new" ]; then
  printf '%s\n' 'Expected a real ~/.t3 directory and no ~/.hyakki. Nothing was moved.' >&2
  exit 2
fi

umask 077
backup=$(mktemp -d "$HOME/.hyakki-backup.XXXXXX")
cp -a "$old" "$backup/home"
printf 'Backup: %s/home\n' "$backup"
mv "$old" "$new"
if ! ln -s .hyakki "$old"; then
  if [ ! -e "$old" ] && [ ! -L "$old" ]; then
    mv "$new" "$old"
  fi
  printf 'Could not create the compatibility link; backup is at %s/home.\n' "$backup" >&2
  exit 1
fi
printf '%s\n' 'Moved Hyakki data to ~/.hyakki. The compatibility link keeps existing worktrees reachable; do not run upstream T3 Code against it.'
