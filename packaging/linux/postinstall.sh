#!/bin/sh
set -eu

action="${1:-configure}"

case "$action" in
  configure|1|2)
    if command -v systemd-sysusers >/dev/null 2>&1; then
      systemd-sysusers /usr/lib/sysusers.d/morecode.conf
    elif ! id morecode >/dev/null 2>&1; then
      groupadd --system morecode 2>/dev/null || true
      useradd --system --gid morecode --home-dir /var/lib/morecode --shell /usr/sbin/nologin morecode
    fi

    if command -v systemd-tmpfiles >/dev/null 2>&1; then
      systemd-tmpfiles --create /usr/lib/tmpfiles.d/morecode.conf
    else
      install -d -m 0750 -o morecode -g morecode \
        /var/lib/morecode \
        /var/lib/morecode/state \
        /var/lib/morecode/workspace
    fi

    if command -v systemctl >/dev/null 2>&1; then
      systemctl daemon-reload || true
      systemctl enable morecode.service || true
      systemctl restart morecode.service || systemctl start morecode.service || true
    fi
    ;;
esac

