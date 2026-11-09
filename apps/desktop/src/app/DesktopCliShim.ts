import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Random from "effect/Random";

import * as DesktopEnvironment from "./DesktopEnvironment.ts";
import { makeComponentLogger } from "./DesktopObservability.ts";

// AppImage mounts change each run; the launcher must mount the image itself.
const { logInfo, logWarning } = makeComponentLogger("desktop-cli-shim");

export const MARKER = "Written by T3 Code: runs the desktop app's bundled t3 CLI.";
const WSL_MARKER = "Written by T3 Code: Windows desktop WSL launcher.";

const SERVER_ENTRY = "apps/server/dist/bin.mjs";

const shellWord = (value: string) => `'${value.replaceAll("'", `'"'"'`)}'`;
/** cmd.exe expands `%` even inside quotes; Windows paths cannot contain `"`. */
const cmdText = (value: string) => value.replaceAll("%", "%%");
const cmdWord = (value: string) => `"${cmdText(value)}"`;

const MOVED = "T3 Code has moved or been removed. Open the app once to update this command.";

export type CliShimTarget =
  | { readonly kind: "appimage"; readonly appImage: string; readonly executableName: string }
  | { readonly kind: "direct"; readonly executable: string; readonly entry: string }
  | { readonly kind: "windows"; readonly executable: string; readonly entry: string };

// Encoding preserves cmd quoting across WSL and PowerShell argument parsing.
const wslPowerShellCommand = (args: string) =>
  Buffer.from(
    `$ProgressPreference = 'SilentlyContinue'; Set-Location -LiteralPath $env:SystemRoot; & $env:ComSpec /d /s /c '""%T3CODE_WSL_LAUNCHER%" ${args}"'; exit $LASTEXITCODE`,
    "utf16le",
  ).toString("base64");

export const renderWslCliShim = (windowsCliPath: string) =>
  [
    "#!/bin/sh",
    "# Written by T3 Code: Windows desktop WSL launcher.",
    `cli=${shellWord(windowsCliPath)}`,
    'if [ "${1:-}" != app ]; then echo "Usage: t3 app [project-directory] [--base-dir directory]" >&2; exit 2; fi',
    "shift",
    "project=; base_dir=; help=; options=1",
    'while [ "$#" -gt 0 ]; do',
    '  case "$1" in',
    "    --help|-h) help=1; shift ;;",
    '    --base-dir) [ "$#" -ge 2 ] && [ -n "$2" ] || { echo "--base-dir requires a directory" >&2; exit 2; }; base_dir=$2; shift 2 ;;',
    '    --base-dir=*) base_dir=${1#*=}; [ -n "$base_dir" ] || { echo "--base-dir requires a directory" >&2; exit 2; }; shift ;;',
    "    --) options=; shift; break ;;",
    '    -*) echo "Unknown option: $1" >&2; exit 2 ;;',
    '    *) [ -z "$project" ] || { echo "Only one project directory is supported" >&2; exit 2; }; project=$1; shift ;;',
    "  esac",
    "done",
    'if [ -z "$options" ] && [ "$#" -gt 0 ]; then [ -z "$project" ] && [ "$#" -eq 1 ] || { echo "Only one project directory is supported" >&2; exit 2; }; project=$1; fi',
    // A Linux T3 home cannot identify the Windows desktop's control socket.
    "unset T3CODE_HOME T3CODE_WSL_WORKSPACE_ROOT T3CODE_WSL_BASE_DIR",
    'export T3CODE_WSL_DISTRO="${WSL_DISTRO_NAME:?Run this command inside WSL}"',
    'if [ -z "$help" ]; then',
    '  workspace_root=$(CDPATH= cd -- "${project:-.}" && pwd) || { echo "Project directory not found: ${project:-.}" >&2; exit 1; }',
    '  export T3CODE_WSL_WORKSPACE_ROOT="$workspace_root"',
    '  if [ -n "$base_dir" ]; then',
    '    case "$base_dir" in',
    '      [A-Za-z]:*|\\\\*) base_dir_wsl=$(wslpath -u "$base_dir") || exit 1 ;;',
    '      "~"|"~/"*) base_dir_wsl=$HOME${base_dir#"~"} ;;',
    "      *) base_dir_wsl=$base_dir ;;",
    "    esac",
    '    T3CODE_WSL_BASE_DIR=$(wslpath -w "$base_dir_wsl") || exit 1',
    "    export T3CODE_WSL_BASE_DIR",
    "  fi",
    "fi",
    'cli_wsl=$(wslpath -u "$cli") || exit 1',
    'T3CODE_WSL_LAUNCHER=$(wslpath -w "$cli_wsl") || exit 1',
    "export T3CODE_WSL_LAUNCHER",
    'export WSLENV="${WSLENV:+$WSLENV:}T3CODE_WSL_DISTRO/w:T3CODE_WSL_WORKSPACE_ROOT/w:T3CODE_WSL_BASE_DIR/w:T3CODE_WSL_LAUNCHER/w"',
    `if [ -n "$help" ]; then exec powershell.exe -NoProfile -NonInteractive -EncodedCommand ${wslPowerShellCommand("app --help")}; fi`,
    `exec powershell.exe -NoProfile -NonInteractive -EncodedCommand ${wslPowerShellCommand("app")}`,
    "",
  ].join("\n");

export const renderWslCliInstallScript = (input: {
  readonly action: "state" | "install" | "uninstall";
  readonly windowsCliPath: string;
}) => `set -eu
bin="$HOME/.local/bin"
target="$bin/t3"
marker="${WSL_MARKER}"
report_state() {
    if [ -f "$target" ] && grep -Fq "$marker" "$target"; then
      printf "%s\\n%s\\n" "$target" "$WSL_DISTRO_NAME"
    else
      printf "NONE\\n"
    fi
}
case ${shellWord(input.action)} in
  state) report_state ;;
  install)
    mkdir -p "$bin"
    existing=$(command -v t3 || :)
    if [ -n "$existing" ] && [ "$existing" != "$target" ]; then
      echo "A different t3 command is already on PATH at $existing." >&2
      exit 73
    fi
    if [ -L "$target" ] || { [ -e "$target" ] && ! grep -Fq "$marker" "$target"; }; then
      echo "A different t3 command already exists at $target." >&2
      exit 73
    fi
    cat > "$target" <<'T3CODE_WSL_SHIM'
${renderWslCliShim(input.windowsCliPath)}T3CODE_WSL_SHIM
    chmod 755 "$target"
    report_state
    ;;
  uninstall)
    if [ -f "$target" ] && grep -Fq "$marker" "$target"; then rm "$target"; fi
    ;;
esac
`;

/** Embed this install's home and executable path so `sudo`, which clears the environment, uses the same install. */
export const renderCliShim = (input: {
  readonly target: CliShimTarget;
  readonly shimPath: string;
  readonly t3Home: string;
}) => {
  const { target } = input;
  if (target.kind === "windows") {
    const utf8 = [target.executable, target.entry, input.shimPath, input.t3Home].some((value) =>
      [...value].some((character) => character.codePointAt(0)! > 0x7f),
    );
    const restore = utf8 ? ["chcp %t3_codepage% >nul"] : [];
    return [
      "@echo off",
      `rem ${MARKER}`,
      // Delayed expansion would rewrite `!name!` in paths and arguments.
      "setlocal EnableExtensions DisableDelayedExpansion",
      // Ctrl-C skips codepage restoration, so switch to UTF-8 only for non-ASCII install paths.
      ...(utf8
        ? [
            `for /f "tokens=2 delims=:." %%c in ('chcp') do set "t3_codepage=%%c"`,
            "chcp 65001 >nul",
          ]
        : []),
      `set "T3CODE_CLI_PATH=${cmdText(input.shimPath)}"`,
      `if not defined T3CODE_HOME set "T3CODE_HOME=${cmdText(input.t3Home)}"`,
      'set "ELECTRON_RUN_AS_NODE=1"',
      // Electron's Windows executable starts without stdin; this tells the CLI to reopen the console.
      'set "T3CODE_DESKTOP_CLI_LAUNCHER=1"',
      // A goto, not a parenthesized block: "Program Files (x86)" would close the block early.
      `if exist ${cmdWord(target.executable)} goto run`,
      ...restore,
      `echo ${MOVED} 1>&2`,
      "exit /b 127",
      ":run",
      `${cmdWord(target.executable)} ${cmdWord(target.entry)} %*`,
      'set "t3_exit=%ERRORLEVEL%"',
      ...restore,
      "exit /b %t3_exit%",
      "",
    ].join("\r\n");
  }
  const header = [
    "#!/bin/sh",
    `# ${MARKER}`,
    `export T3CODE_CLI_PATH=${shellWord(input.shimPath)}`,
    `home=${shellWord(input.t3Home)}`,
    'export T3CODE_HOME="${T3CODE_HOME:-$home}"',
    "export ELECTRON_RUN_AS_NODE=1",
    `app=${shellWord(target.kind === "appimage" ? target.appImage : target.executable)}`,
    'if [ ! -x "$app" ]; then',
    `  echo "${MOVED}" >&2`,
    "  exit 127",
    "fi",
  ];
  if (target.kind === "direct") {
    return [...header, `exec "$app" ${shellWord(target.entry)} "$@"`, ""].join("\n");
  }
  const run = (root: string) =>
    `"${root}/${target.executableName}" "${root}/resources/app.asar/${SERVER_ENTRY}" "$@"`;
  return [
    ...header,
    // Extract-and-run would make the runtime start the app instead of mounting it.
    "unset APPIMAGE_EXTRACT_AND_RUN",
    // The runtime stays mounted until killed; traps unmount it because background jobs ignore Ctrl-C.
    "work=$(mktemp -d) || exit 1",
    '"$app" --appimage-mount >"$work/mount" 2>/dev/null &',
    "mounter=$!",
    `trap 'kill "$mounter" 2>/dev/null; rm -rf "$work"' EXIT`,
    "trap 'exit 130' INT TERM",
    "mount=",
    'while kill -0 "$mounter" 2>/dev/null; do',
    '  mount=$(head -n 1 "$work/mount")',
    '  [ -d "$mount" ] && break',
    "  mount=",
    "  sleep 0.05",
    "done",
    // Without FUSE the runtime cannot mount (it prints why and exits); extracting the image still works.
    'if [ -z "$mount" ]; then',
    '  (cd "$work" && "$app" --appimage-extract >/dev/null) || { echo "Could not open $app." >&2; exit 1; }',
    '  mount="$work/squashfs-root"',
    "fi",
    run("$mount"),
    "",
  ].join("\n");
};

export const launcherPath = (environment: DesktopEnvironment.DesktopEnvironment["Service"]) =>
  environment.path.join(
    environment.baseDir,
    "bin",
    environment.platform === "win32" ? "t3.cmd" : "t3",
  );

export const install = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  if (!environment.isPackaged) return Option.none<string>();
  const fs = yield* FileSystem.FileSystem;
  const path = environment.path;
  const windows = environment.platform === "win32";
  const shimPath = launcherPath(environment);
  const entry = path.join(environment.serverRoot, SERVER_ENTRY);
  const target: CliShimTarget = windows
    ? { kind: "windows", executable: process.execPath, entry }
    : Option.match(environment.appImagePath, {
        onSome: (appImage) => ({
          kind: "appimage" as const,
          appImage,
          executableName: path.basename(process.execPath),
        }),
        onNone: () => ({ kind: "direct" as const, executable: process.execPath, entry }),
      });
  const content = renderCliShim({ target, shimPath, t3Home: environment.baseDir });

  return yield* Effect.gen(function* () {
    const existing = yield* fs.readFileString(shimPath).pipe(Effect.option);
    if (Option.isSome(existing) && !existing.value.includes(MARKER)) {
      yield* logWarning("leaving a t3 launcher the app did not write", { shimPath });
      return Option.none<string>();
    }
    if (Option.getOrUndefined(existing) !== content) {
      yield* fs.makeDirectory(path.dirname(shimPath), { recursive: true });
      // Unique per call: backend startup and the first-launch command install can race here.
      const staging = `${shimPath}.${process.pid}.${yield* Random.nextIntBetween(0, 0xffffff)}.tmp`;
      yield* fs.writeFileString(staging, content, { mode: 0o755 });
      yield* fs.rename(staging, shimPath);
      yield* logInfo("installed t3 launcher", { shimPath });
    }
    return Option.some(shimPath);
  }).pipe(
    Effect.catchCause((cause) =>
      logWarning("could not install t3 launcher", { shimPath, cause: Cause.pretty(cause) }).pipe(
        Effect.as(Option.none<string>()),
      ),
    ),
    Effect.withSpan("desktop.cliShim.install"),
  );
});
