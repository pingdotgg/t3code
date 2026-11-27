#!/bin/sh
printf '%s\n' "$*" >> "$FAKE_NPM_LOG"
prefix="${npm_config_prefix:-$FAKE_NPM_PREFIX}"
explicit_prefix=
previous=
for arg in "$@"; do
  case "$arg" in
    --prefix=*) explicit_prefix=${arg#--prefix=} ;;
  esac
  [ "$previous" = "--prefix" ] && explicit_prefix=$arg
  previous=$arg
done
# Some npm shims (Bun-backed ones) honor only a literal --prefix argument.
[ -n "$FAKE_NPM_IGNORE_PREFIX_ENV" ] && prefix="$FAKE_NPM_PREFIX"
prefix="${explicit_prefix:-$prefix}"
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
  if [ "$FAKE_NPM_REQUIRE_PREFIX" = "1" ] && [ -z "$explicit_prefix" ]; then
    # Volta handles global installs itself unless --prefix is explicit.
    exit 0
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
