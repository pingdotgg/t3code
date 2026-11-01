import { MARKER } from "../app/DesktopCliShim.ts";

const WSL_RUNTIME_POINTER = "current";

export type WslCliCommandAction = "state" | "install" | "uninstall";

export interface WslCliCommandReport {
  readonly distroName: string | null;
  readonly installedPath: string | null;
  readonly onPath: boolean;
  readonly shadowedBy: string | null;
  readonly failure: "runtime-missing" | "shadowed" | "no-folder" | "write" | null;
}

const shellQuote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;

const READ_TARGET = [
  "app= script=",
  `if [ -r "$runtimes/${WSL_RUNTIME_POINTER}" ]; then`,
  `  { IFS= read -r app; IFS= read -r script; } < "$runtimes/${WSL_RUNTIME_POINTER}"`,
  "fi",
];
const TARGET_MISSING =
  '[ -z "$app" ] || [ ! -x "$app" ] || { [ -n "$script" ] && [ ! -f "$script" ]; }';

// Embed the distro home so the command uses the backend's data even if HOME changes.
const LAUNCHER_BODY = [
  ...READ_TARGET,
  `if ${TARGET_MISSING}; then`,
  `  echo "T3 Code's runtime is missing from this distro. Open T3 Code once to restore it." >&2`,
  "  exit 127",
  "fi",
  'export T3CODE_HOME="${T3CODE_HOME:-$home}"',
  'if [ -n "$script" ]; then set -- "$script" "$@"; fi',
  'exec "$app" "$@"',
];

const COMMON = [
  "set -u",
  `marker=${shellQuote(MARKER)}`,
  'runtimes="$HOME/.t3/wsl-runtime"',
  "ours() {",
  '  [ -f "$1" ] && [ "$(wc -c < "$1")" -le 16384 ] && grep -qF -- "$marker" "$1"',
  "}",
  "installed_at() {",
  '  for dir in "$HOME/.local/bin" "$HOME/bin"; do',
  '    if ours "$dir/t3"; then printf \'%s\' "$dir/t3"; return 0; fi',
  "  done",
  "  return 1",
  "}",
  // `wsl.exe --exec` skips the user's profile, so its PATH is not a terminal's.
  "terminal_path() {",
  '  set -- "${SHELL:-/bin/sh}" -ilc \'printf "\\n__t3_path__:%s\\n" "$PATH"\'',
  // timeout owns the probe's process group, including children started by a profile.
  "  command -v timeout >/dev/null 2>&1 || { printf '%s' \"$PATH\"; return; }",
  "  out=$(mktemp) || { printf '%s' \"$PATH\"; return; }",
  '  timeout --kill-after=1 10 "$@" </dev/null >"$out" 2>/dev/null || true',
  "  captured=$(sed -n 's/^__t3_path__://p' \"$out\" | tail -n 1)",
  '  rm -f "$out"',
  "  printf '%s' \"${captured:-$PATH}\"",
  "}",
  "first_on_path() {",
  "  set -f",
  "  old_ifs=$IFS",
  "  IFS=:",
  "  for dir in $1; do",
  '    if [ -n "$dir" ] && [ -f "$dir/t3" ] && [ -x "$dir/t3" ]; then',
  "      IFS=$old_ifs; set +f; printf '%s' \"$dir/t3\"; return 0",
  "    fi",
  "  done",
  "  IFS=$old_ifs",
  "  set +f",
  "  return 1",
  "}",
];

const INSTALL = [
  "quote() {",
  `  printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\\\\\''/g")"`,
  "}",
  "write_launcher() {",
  "  {",
  "    printf '#!/bin/sh\\n# %s\\n' \"$marker\"",
  '    printf \'runtimes=%s\\n\' "$(quote "$runtimes")"',
  '    printf \'home=%s\\n\' "$(quote "$HOME/.t3")"',
  '    printf \'export T3CODE_CLI_PATH=%s\\n\' "$(quote "$2")"',
  "    cat <<'T3CODE_LAUNCHER'",
  ...LAUNCHER_BODY,
  "T3CODE_LAUNCHER",
  '  } > "$1"',
  "}",
  "install_launcher() {",
  ...READ_TARGET.map((line) => `  ${line}`),
  `  if ${TARGET_MISSING}; then`,
  "    echo failure:runtime-missing",
  "    return",
  "  fi",
  "  target=$(installed_at) || target=",
  '  if [ -z "$target" ]; then',
  "    path=$(terminal_path)",
  '    first=$(first_on_path "$path") || first=',
  '    if [ -n "$first" ] && ! ours "$first"; then',
  "      echo failure:shadowed",
  "      return",
  "    fi",
  // A folder already on a terminal's PATH first, so `t3` works right away.
  "    for pass in on off; do",
  '      for dir in "$HOME/.local/bin" "$HOME/bin"; do',
  '        case ":$path:" in *":$dir:"*) where=on ;; *) where=off ;; esac',
  '        [ "$where" = "$pass" ] || continue',
  '        if [ -e "$dir/t3" ] || [ -L "$dir/t3" ]; then continue; fi',
  '        mkdir -p "$dir" 2>/dev/null && [ -w "$dir" ] || continue',
  '        target="$dir/t3"',
  "        break 2",
  "      done",
  "    done",
  '    if [ -z "$target" ]; then',
  "      echo failure:no-folder",
  "      return",
  "    fi",
  "  fi",
  '  staging="$target.$$.tmp"',
  '  if write_launcher "$staging" "$target" 2>/dev/null && chmod 755 "$staging" 2>/dev/null && mv -f "$staging" "$target" 2>/dev/null; then',
  "    return",
  "  fi",
  '  rm -f "$staging"',
  "  echo failure:write",
  "}",
  "install_launcher",
];

const UNINSTALL = [
  'for dir in "$HOME/.local/bin" "$HOME/bin"; do',
  '  if ours "$dir/t3"; then rm -f "$dir/t3" || echo failure:write; fi',
  "done",
];

const REPORT = [
  "printf 'distro:%s\\n' \"${WSL_DISTRO_NAME:-}\"",
  "installed=$(installed_at) || installed=",
  "printf 'installedPath:%s\\n' \"$installed\"",
  'first=$(first_on_path "$(terminal_path)") || first=',
  'if [ -n "$installed" ] && [ -n "$first" ] && [ "$first" -ef "$installed" ]; then',
  "  echo onPath:1",
  "fi",
  'if [ -n "$first" ] && ! ours "$first"; then',
  "  printf 'shadowedBy:%s\\n' \"$first\"",
  "fi",
];

export const buildWslCliCommandScript = (action: WslCliCommandAction) =>
  [
    ...COMMON,
    ...(action === "install" ? INSTALL : action === "uninstall" ? UNINSTALL : []),
    ...REPORT,
  ].join("\n");

export const buildWslCliTargetScript = (command: ReadonlyArray<string>) =>
  [
    "set -eu",
    'runtimes="$HOME/.t3/wsl-runtime"',
    'mkdir -p "$runtimes"',
    `printf '%s\\n' ${command.map(shellQuote).join(" ")} > "$runtimes/.${WSL_RUNTIME_POINTER}.$$"`,
    `mv -f "$runtimes/.${WSL_RUNTIME_POINTER}.$$" "$runtimes/${WSL_RUNTIME_POINTER}"`,
  ].join("\n");

const FAILURES = ["runtime-missing", "shadowed", "no-folder", "write"] as const;

export const parseWslCliCommandReport = (stdout: string): WslCliCommandReport => {
  const lines = stdout.split("\n").map((line) => line.replace(/\r$/, ""));
  const field = (name: string) => {
    const value = lines.find((line) => line.startsWith(`${name}:`))?.slice(name.length + 1);
    return value ? value : null;
  };
  const failure = field("failure");
  return {
    distroName: field("distro"),
    installedPath: field("installedPath"),
    onPath: field("onPath") === "1",
    shadowedBy: field("shadowedBy"),
    failure: FAILURES.find((known) => known === failure) ?? null,
  };
};
