#!/bin/bash

# dpkg runs the installed release's postrm after this script, and releases built
# with electron-builder's stock postrm delete the AppArmor profile on upgrade too.
# Give that script the remove/purge guard from after-remove.tpl before it runs.
if [ "$1" = upgrade ]; then
  OLD_POSTRM=$(dpkg-query --control-path "$DPKG_MAINTSCRIPT_PACKAGE" postrm 2>/dev/null)
  if [ -f "$OLD_POSTRM" ] && ! grep -qF 'remove|purge) ;;' "$OLD_POSTRM"; then
    sed -i '1a case "$1" in remove|purge) ;; *) exit 0 ;; esac' "$OLD_POSTRM" || true
  fi
fi

exit 0
