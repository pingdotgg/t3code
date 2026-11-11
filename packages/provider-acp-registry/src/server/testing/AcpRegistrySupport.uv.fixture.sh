#!/bin/sh
printf '%s\n' "$*" >> "$FAKE_UV_LOG"
tool_bin="${UV_TOOL_BIN_DIR:-$FAKE_UV_BIN}"
executable="$tool_bin/fast-agent"
printf "tool-dir=%s bin-dir=%s\n" "$UV_TOOL_DIR" "$UV_TOOL_BIN_DIR" >> "$FAKE_UV_LOG"
if [ "$1" = "tool" ] && [ "$2" = "dir" ] && [ "$3" = "--bin" ]; then
  printf '%s\n' "$tool_bin"
  exit 0
fi
if [ "$1" = "tool" ] && [ "$2" = "list" ]; then
  if [ -x "$executable" ]; then
    printf 'fast-agent-acp v0.10.1\n- fast-agent\n'
  fi
  exit 0
fi
if [ "$1" = "tool" ] && [ "$2" = "install" ] && [ "$3" = "--force" ]; then
  mkdir -p "$tool_bin"
  printf '#!/bin/sh\n' > "$executable"
  chmod 755 "$executable"
  exit 0
fi
exit 64
