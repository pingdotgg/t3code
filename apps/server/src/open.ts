/**
 * Open - Browser/editor launch service interface.
 *
 * Owns process launch helpers for opening URLs in a browser and workspace
 * paths in a configured editor.
 *
 * @module Open
 */
import { spawn } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { extname, join } from "node:path";

import { EDITORS, type EditorId } from "@t3tools/contracts";
import { ServiceMap, Schema, Effect, Layer } from "effect";

// ==============================
// Definitions
// ==============================

export class OpenError extends Schema.TaggedErrorClass<OpenError>()("OpenError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect),
}) {}

export interface OpenInEditorInput {
  readonly cwd: string;
  readonly editor: EditorId;
}

interface EditorLaunch {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
}

interface CommandAvailabilityOptions {
  readonly platform?: NodeJS.Platform;
  readonly env?: NodeJS.ProcessEnv;
}

const LINE_COLUMN_SUFFIX_PATTERN = /:\d+(?::\d+)?$/;

function shouldUseGotoFlag(editorId: EditorId, target: string): boolean {
  return (
    (editorId === "cursor" || editorId === "vscode") && LINE_COLUMN_SUFFIX_PATTERN.test(target)
  );
}

function fileManagerCommandForPlatform(platform: NodeJS.Platform): string {
  switch (platform) {
    case "darwin":
      return "open";
    case "win32":
      return "explorer";
    default:
      return "xdg-open";
  }
}

function terminalCommandForPlatform(platform: NodeJS.Platform): string {
  switch (platform) {
    case "darwin":
      return "open";
    case "win32":
      return "cmd";
    default:
      return "xdg-open";
  }
}

function stripWrappingQuotes(value: string): string {
  return value.replace(/^"+|"+$/g, "");
}

function resolvePathEnvironmentVariable(env: NodeJS.ProcessEnv): string {
  return env.PATH ?? env.Path ?? env.path ?? "";
}

function resolveWindowsPathExtensions(env: NodeJS.ProcessEnv): ReadonlyArray<string> {
  const rawValue = env.PATHEXT;
  const fallback = [".COM", ".EXE", ".BAT", ".CMD"];
  if (!rawValue) return fallback;

  const parsed = rawValue
    .split(";")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map((entry) => (entry.startsWith(".") ? entry.toUpperCase() : `.${entry.toUpperCase()}`));
  return parsed.length > 0 ? Array.from(new Set(parsed)) : fallback;
}

function resolveCommandCandidates(
  command: string,
  platform: NodeJS.Platform,
  windowsPathExtensions: ReadonlyArray<string>,
): ReadonlyArray<string> {
  if (platform !== "win32") return [command];
  const extension = extname(command);
  const normalizedExtension = extension.toUpperCase();

  if (extension.length > 0 && windowsPathExtensions.includes(normalizedExtension)) {
    const commandWithoutExtension = command.slice(0, -extension.length);
    return Array.from(
      new Set([
        command,
        `${commandWithoutExtension}${normalizedExtension}`,
        `${commandWithoutExtension}${normalizedExtension.toLowerCase()}`,
      ]),
    );
  }

  const candidates: string[] = [];
  for (const extension of windowsPathExtensions) {
    candidates.push(`${command}${extension}`);
    candidates.push(`${command}${extension.toLowerCase()}`);
  }
  return Array.from(new Set(candidates));
}

function isExecutableFile(
  filePath: string,
  platform: NodeJS.Platform,
  windowsPathExtensions: ReadonlyArray<string>,
): boolean {
  try {
    const stat = statSync(filePath);
    if (!stat.isFile()) return false;
    if (platform === "win32") {
      const extension = extname(filePath);
      if (extension.length === 0) return false;
      return windowsPathExtensions.includes(extension.toUpperCase());
    }
    accessSync(filePath, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function resolvePathDelimiter(platform: NodeJS.Platform): string {
  return platform === "win32" ? ";" : ":";
}

export function isCommandAvailable(
  command: string,
  options: CommandAvailabilityOptions = {},
): boolean {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const windowsPathExtensions = platform === "win32" ? resolveWindowsPathExtensions(env) : [];
  const commandCandidates = resolveCommandCandidates(command, platform, windowsPathExtensions);

  if (command.includes("/") || command.includes("\\")) {
    return commandCandidates.some((candidate) =>
      isExecutableFile(candidate, platform, windowsPathExtensions),
    );
  }

  const pathValue = resolvePathEnvironmentVariable(env);
  if (pathValue.length === 0) return false;
  const pathEntries = pathValue
    .split(resolvePathDelimiter(platform))
    .map((entry) => stripWrappingQuotes(entry.trim()))
    .filter((entry) => entry.length > 0);

  for (const pathEntry of pathEntries) {
    for (const candidate of commandCandidates) {
      if (isExecutableFile(join(pathEntry, candidate), platform, windowsPathExtensions)) {
        return true;
      }
    }
  }
  return false;
}

export function resolveAvailableEditors(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): ReadonlyArray<EditorId> {
  const available: EditorId[] = [];

  for (const editor of EDITORS) {
    let command: string;
    if (editor.command) {
      command = editor.command;
    } else if (editor.id === "terminal") {
      command = terminalCommandForPlatform(platform);
    } else {
      command = fileManagerCommandForPlatform(platform);
    }
    if (isCommandAvailable(command, { platform, env })) {
      available.push(editor.id);
    }
  }

  return available;
}

/**
 * OpenShape - Service API for browser and editor launch actions.
 */
export interface OpenShape {
  /**
   * Open a URL target in the default browser.
   */
  readonly openBrowser: (target: string) => Effect.Effect<void, OpenError>;

  /**
   * Open a workspace path in a selected editor integration.
   *
   * Launches the editor as a detached process so server startup is not blocked.
   */
  readonly openInEditor: (input: OpenInEditorInput) => Effect.Effect<void, OpenError>;
}

/**
 * Open - Service tag for browser/editor launch operations.
 */
export class Open extends ServiceMap.Service<Open, OpenShape>()("t3/open") {}

// ==============================
// Implementations
// ==============================

function sanitizeSessionName(cwd: string): string {
  const base = cwd.split("/").pop() ?? cwd;
  return base.replace(/[^a-zA-Z0-9_-]/g, "_");
}

function quoteForPosixShell(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function quoteForWindowsCmd(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function escapeForAppleScriptString(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

export function buildPosixTmuxBootstrapCommand(cwd: string, sessionName: string): string {
  const quotedCwd = quoteForPosixShell(cwd);
  const quotedSessionName = quoteForPosixShell(sessionName);
  const paneCountCommand = `$(tmux display-message -p -t ${quotedSessionName} '#{window_panes}' 2>/dev/null)`;

  return [
    `if tmux has-session -t ${quotedSessionName} 2>/dev/null; then`,
    `if [ "${paneCountCommand}" = "1" ]; then`,
    `tmux split-window -h -t ${quotedSessionName} -c ${quotedCwd} -p 30;`,
    `tmux select-pane -L -t ${quotedSessionName};`,
    "fi;",
    `exec tmux attach-session -t ${quotedSessionName};`,
    "fi;",
    `tmux new-session -d -s ${quotedSessionName} -c ${quotedCwd};`,
    `tmux split-window -h -t ${quotedSessionName} -c ${quotedCwd} -p 30;`,
    `tmux select-pane -L -t ${quotedSessionName};`,
    `tmux new-window -t ${quotedSessionName} -c ${quotedCwd};`,
    `tmux select-window -l -t ${quotedSessionName};`,
    `exec tmux attach-session -t ${quotedSessionName}`,
  ].join(" ");
}

export function buildWindowsTmuxBootstrapCommand(cwd: string, sessionName: string): string {
  const quotedCwd = quoteForWindowsCmd(cwd);

  return [
    `tmux has-session -t ${sessionName} 2>nul`,
    `&& (for /f "usebackq delims=" %p in (\`tmux display-message -p -t ${sessionName} "#{window_panes}" 2^>nul\`) do @if "%p"=="1" tmux split-window -h -t ${sessionName} -c ${quotedCwd} -p 30 && tmux select-pane -L -t ${sessionName}) && tmux attach-session -t ${sessionName}`,
    `|| (tmux new-session -d -s ${sessionName} -c ${quotedCwd}`,
    `&& tmux split-window -h -t ${sessionName} -c ${quotedCwd} -p 30`,
    `&& tmux select-pane -L -t ${sessionName}`,
    `&& tmux new-window -t ${sessionName} -c ${quotedCwd}`,
    `&& tmux select-window -l -t ${sessionName}`,
    `&& tmux attach-session -t ${sessionName})`,
  ].join(" ");
}

export function buildDarwinTerminalAppLaunch(shellCommand: string): EditorLaunch {
  return {
    command: "osascript",
    args: [
      "-e",
      'tell application "Terminal" to activate',
      "-e",
      `tell application "Terminal" to do script "${escapeForAppleScriptString(shellCommand)}"`,
    ],
  };
}

/**
 * Well-known macOS `.app` bundle binary paths for rich terminals.
 * Used as a fallback when PATH-based lookup fails (common in packaged Electron builds
 * where the login shell PATH may not be available).
 */
const DARWIN_APP_BUNDLE_TERMINALS: ReadonlyArray<{ bin: string; path: string }> = [
  { bin: "ghostty", path: "/Applications/Ghostty.app/Contents/MacOS/ghostty" },
  { bin: "kitty", path: "/Applications/kitty.app/Contents/MacOS/kitty" },
];

/**
 * macOS terminal preference order: ghostty → kitty → Terminal.app.
 * Returns the resolved terminal and whether it's a "rich" terminal (ghostty/kitty)
 * that supports `-e` and working-directory flags directly.
 *
 * First checks PATH, then falls back to well-known `.app` bundle locations
 * for packaged builds where `fixPath` may not have resolved the full user PATH.
 */
function resolveDarwinTerminal():
  | { command: string; rich: true }
  | { command: "open"; rich: false } {
  if (isCommandAvailable("ghostty")) return { command: "ghostty", rich: true };
  if (isCommandAvailable("kitty")) return { command: "kitty", rich: true };

  for (const { bin: _bin, path } of DARWIN_APP_BUNDLE_TERMINALS) {
    if (isExecutableFile(path, "darwin", [])) {
      return { command: path, rich: true };
    }
  }

  return { command: "open", rich: false };
}

/**
 * Well-known Linux binary paths for rich terminals.
 * Used as a fallback when PATH-based lookup fails (common in packaged Electron builds
 * where the login shell PATH may not be available).
 */
const LINUX_TERMINAL_PATHS: ReadonlyArray<{ bin: string; path: string }> = [
  { bin: "ghostty", path: "/usr/bin/ghostty" },
  { bin: "kitty", path: "/usr/bin/kitty" },
  { bin: "ghostty", path: "/usr/local/bin/ghostty" },
  { bin: "kitty", path: "/usr/local/bin/kitty" },
];

/**
 * Linux terminal preference order: ghostty → kitty → x-terminal-emulator → xterm.
 * Returns the resolved terminal and whether it's a "rich" terminal (ghostty/kitty)
 * that supports `-e` and working-directory flags directly.
 *
 * First checks PATH, then falls back to well-known binary locations
 * for packaged builds where the full user PATH may not be available.
 */
function resolveLinuxTerminal():
  | { command: string; rich: true }
  | { command: string; rich: false } {
  if (isCommandAvailable("ghostty")) return { command: "ghostty", rich: true };
  if (isCommandAvailable("kitty")) return { command: "kitty", rich: true };

  for (const { bin: _bin, path } of LINUX_TERMINAL_PATHS) {
    if (isExecutableFile(path, "linux", [])) {
      return { command: path, rich: true };
    }
  }

  if (isCommandAvailable("x-terminal-emulator")) {
    return { command: "x-terminal-emulator", rich: false };
  }
  return { command: "xterm", rich: false };
}

/**
 * Resolve a user-facing terminal display name for the current platform.
 *
 * On macOS: Ghostty / Kitty / Terminal
 * On Windows: Command Prompt
 * On Linux: Ghostty / Kitty / Terminal
 */
export function resolveTerminalName(platform: NodeJS.Platform = process.platform): string {
  if (platform === "darwin") {
    const terminal = resolveDarwinTerminal();
    if (terminal.command.endsWith("ghostty")) return "Ghostty";
    if (terminal.command.endsWith("kitty")) return "Kitty";
    return "Terminal";
  }
  if (platform === "win32") return "Command Prompt";
  const terminal = resolveLinuxTerminal();
  if (terminal.command.endsWith("ghostty")) return "Ghostty";
  if (terminal.command.endsWith("kitty")) return "Kitty";
  return "Terminal";
}

function richTerminalCwdArgs(command: string, cwd: string): ReadonlyArray<string> {
  if (command.endsWith("ghostty")) return [`--working-directory=${cwd}`];
  if (command.endsWith("kitty")) return ["--directory", cwd];
  return [];
}

export const resolveTerminalLaunch = Effect.fnUntraced(function* (
  cwd: string,
  platform: NodeJS.Platform = process.platform,
): Effect.fn.Return<EditorLaunch, OpenError> {
  yield* Effect.void;
  const hasTmux = isCommandAvailable("tmux");

  if (hasTmux) {
    const sessionName = `t3-${sanitizeSessionName(cwd)}`;
    const posixTmuxBootstrapCommand = buildPosixTmuxBootstrapCommand(cwd, sessionName);

    if (platform === "darwin") {
      const terminal = resolveDarwinTerminal();
      if (terminal.rich) {
        return {
          command: terminal.command,
          args: [
            ...richTerminalCwdArgs(terminal.command, cwd),
            "-e",
            "sh",
            "-lc",
            posixTmuxBootstrapCommand,
          ],
        };
      }
      // Fallback: Terminal.app via AppleScript so we can run a shell command reliably.
      return buildDarwinTerminalAppLaunch(
        `sh -lc ${quoteForPosixShell(posixTmuxBootstrapCommand)}`,
      );
    }

    if (platform === "win32") {
      return {
        command: "cmd",
        args: [
          "/c",
          "start",
          "cmd",
          "/k",
          `cd /d ${quoteForWindowsCmd(cwd)} && ${buildWindowsTmuxBootstrapCommand(cwd, sessionName)}`,
        ],
      };
    }

    // Linux: prefer rich terminals (ghostty/kitty) over generic x-terminal-emulator
    const linuxTerminal = resolveLinuxTerminal();
    if (linuxTerminal.rich) {
      return {
        command: linuxTerminal.command,
        args: [
          ...richTerminalCwdArgs(linuxTerminal.command, cwd),
          "-e",
          "sh",
          "-lc",
          posixTmuxBootstrapCommand,
        ],
      };
    }
    return {
      command: linuxTerminal.command,
      args: ["-e", "sh", "-lc", posixTmuxBootstrapCommand],
    };
  }

  // No tmux: open the terminal in the target directory
  if (platform === "darwin") {
    const terminal = resolveDarwinTerminal();
    if (terminal.rich) {
      return {
        command: terminal.command,
        args: [...richTerminalCwdArgs(terminal.command, cwd)],
      };
    }
    return buildDarwinTerminalAppLaunch(`cd ${quoteForPosixShell(cwd)}`);
  }
  if (platform === "win32") {
    return { command: "cmd", args: ["/c", "start", "cmd", "/k", `cd /d "${cwd}"`] };
  }
  const linuxTerminal = resolveLinuxTerminal();
  if (linuxTerminal.rich) {
    return {
      command: linuxTerminal.command,
      args: [...richTerminalCwdArgs(linuxTerminal.command, cwd)],
    };
  }
  return { command: linuxTerminal.command, args: ["--working-directory", cwd] };
});

export const resolveEditorLaunch = Effect.fnUntraced(function* (
  input: OpenInEditorInput,
  platform: NodeJS.Platform = process.platform,
): Effect.fn.Return<EditorLaunch, OpenError> {
  const editorDef = EDITORS.find((editor) => editor.id === input.editor);
  if (!editorDef) {
    return yield* new OpenError({ message: `Unknown editor: ${input.editor}` });
  }

  if (editorDef.command) {
    return shouldUseGotoFlag(editorDef.id, input.cwd)
      ? { command: editorDef.command, args: ["--goto", input.cwd] }
      : { command: editorDef.command, args: [input.cwd] };
  }

  if (editorDef.id === "terminal") {
    return yield* resolveTerminalLaunch(input.cwd, platform);
  }

  if (editorDef.id !== "file-manager") {
    return yield* new OpenError({ message: `Unsupported editor: ${input.editor}` });
  }

  return { command: fileManagerCommandForPlatform(platform), args: [input.cwd] };
});

export const launchDetached = (launch: EditorLaunch) =>
  Effect.gen(function* () {
    if (!isCommandAvailable(launch.command)) {
      return yield* new OpenError({ message: `Editor command not found: ${launch.command}` });
    }

    yield* Effect.callback<void, OpenError>((resume) => {
      let child;
      try {
        child = spawn(launch.command, [...launch.args], {
          detached: true,
          stdio: "ignore",
          shell: process.platform === "win32",
        });
      } catch (error) {
        return resume(
          Effect.fail(new OpenError({ message: "failed to spawn detached process", cause: error })),
        );
      }

      const handleSpawn = () => {
        child.unref();
        resume(Effect.void);
      };

      child.once("spawn", handleSpawn);
      child.once("error", (cause) =>
        resume(Effect.fail(new OpenError({ message: "failed to spawn detached process", cause }))),
      );
    });
  });

const make = Effect.gen(function* () {
  const open = yield* Effect.tryPromise({
    try: () => import("open"),
    catch: (cause) => new OpenError({ message: "failed to load browser opener", cause }),
  });

  return {
    openBrowser: (target) =>
      Effect.tryPromise({
        try: () => open.default(target),
        catch: (cause) => new OpenError({ message: "Browser auto-open failed", cause }),
      }),
    openInEditor: (input) => Effect.flatMap(resolveEditorLaunch(input), launchDetached),
  } satisfies OpenShape;
});

export const OpenLive = Layer.effect(Open, make);
