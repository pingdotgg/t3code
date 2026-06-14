#!/bin/sh
set -eu

action="${1:-remove}"
case "$action" in
  remove|0)
    if command -v systemctl >/dev/null 2>&1; then
      systemctl disable --now morecode.service || true
    fi
    ;;
esac

