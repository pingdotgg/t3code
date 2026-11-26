#!/bin/sh
printf '%s\n' "$*" >> "$FAKE_NPM_LOG"
prefix="${npm_config_prefix:-$FAKE_NPM_PREFIX}"
# Some npm shims (Bun-backed ones) honor only a literal --prefix argument.
if [ -n "$FAKE_NPM_IGNORE_PREFIX_ENV" ]; then
  prefix="$FAKE_NPM_PREFIX"
  previous=
  for arg in "$@"; do
    case "$arg" in
      --prefix=*) prefix=${arg#--prefix=} ;;
    esac
    [ "$previous" = "--prefix" ] && prefix=$arg
    previous=$arg
  done
fi
[ -n "$FAKE_NPM_IGNORE_PREFIX" ] && prefix="$FAKE_NPM_PREFIX"
if [ "$1" = "root" ] && [ "$2" = "--global" ]; then
  printf '%s\n' "$prefix/lib/node_modules"
  exit 0
fi
if [ "$1" = "prefix" ] && [ "$2" = "--global" ]; then
  printf '%s\n' "$prefix"
  exit 0
fi
if [ "$1" = "install" ] && [ "$2" = "--global" ]; then
  if [ -n "$FAKE_NPM_INSTALL_FAILURE_LINES" ]; then
    yes 'npm notice resolving example dependency' | head -n "$FAKE_NPM_INSTALL_FAILURE_LINES" >&2
    printf '%s\n' 'npm error see the complete log for details' >&2
    exit 1
  fi
  package_root="$prefix/lib/node_modules/@example/acp"
  executable="$prefix/bin/example-agent"
  mkdir -p "$package_root" "$prefix/bin"
  printf '%s' "$FAKE_NPM_MANIFEST" > "$package_root/package.json"
  if [ "$npm_config_bin_links" != "false" ]; then
    printf '#!/bin/sh\n' > "$executable"
    chmod 755 "$executable"
  fi
  exit 0
fi
exit 64
