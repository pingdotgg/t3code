/**
 * Open - Browser/editor launch service interface.
 *
 * Owns process launch helpers for opening URLs in a browser and workspace
 * paths in a configured editor.
 *
 * @module Open
 */
import { join } from "node:path";

import { EDITORS, type EditorId, type ServerRuntimeEnvironment } from "@t3tools/contracts";
import { ServiceMap, Schema, Effect, Layer } from "effect";
import {
  isExecutableFile,
  resolveCommandCandidates,
  resolvePathEnvironmentVariable,
  resolveWindowsPathExtensions,
  stripWrappingQuotes,
} from "./commandResolution";
import { spawnDetachedProcess, spawnProcessSync } from "./processRunner";
import { detectServerRuntimeEnvironment } from "./runtimeEnvironment";

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

interface ResolveOpenOptions extends CommandAvailabilityOptions {
  readonly runtimeEnvironment?: ServerRuntimeEnvironment;
  readonly translateWslPathToWindows?: (target: string) => string;
}

const LINE_COLUMN_SUFFIX_PATTERN = /:\d+(?::\d+)?$/;
const WINDOWS_ABSOLUTE_PATH_PATTERN = /^[A-Za-z]:[\\/]/;
const WINDOWS_UNC_PATH_PATTERN = /^\\\\/;

function detectRuntimeEnvironment(options: ResolveOpenOptions): ServerRuntimeEnvironment {
  return (
    options.runtimeEnvironment ??
    detectServerRuntimeEnvironment({
      ...(options.platform !== undefined ? { platform: options.platform } : {}),
      ...(options.env !== undefined ? { env: options.env } : {}),
    })
  );
}

function shouldUseGotoFlag(editorId: EditorId, target: string): boolean {
  return (editorId === "cursor" || editorId === "vscode") && LINE_COLUMN_SUFFIX_PATTERN.test(target);
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
      isExecutableFile(candidate, { platform, windowsPathExtensions }),
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
      if (isExecutableFile(join(pathEntry, candidate), { platform, windowsPathExtensions })) {
        return true;
      }
    }
  }
  return false;
}

export function resolveAvailableEditors(
  options: ResolveOpenOptions = {},
): ReadonlyArray<EditorId> {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const runtimeEnvironment = detectRuntimeEnvironment({ ...options, platform, env });
  const available: EditorId[] = [];

  for (const editor of EDITORS) {
    const launch = resolveOpenCommand(editor.id, {
      platform,
      env,
      runtimeEnvironment,
    });
    if (launch.some((entry) => isCommandAvailable(entry, { platform, env }))) {
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

function splitPathAndPosition(value: string): {
  path: string;
  line: string | undefined;
  column: string | undefined;
} {
  let path = value;
  let column: string | undefined;
  let line: string | undefined;

  const columnMatch = path.match(/:(\d+)$/);
  if (!columnMatch?.[1]) {
    return { path, line: undefined, column: undefined };
  }

  column = columnMatch[1];
  path = path.slice(0, -columnMatch[0].length);

  const lineMatch = path.match(/:(\d+)$/);
  if (lineMatch?.[1]) {
    line = lineMatch[1];
    path = path.slice(0, -lineMatch[0].length);
  } else {
    line = column;
    column = undefined;
  }

  return { path, line, column };
}

function stripLineColumnSuffix(value: string): string {
  const { path } = splitPathAndPosition(value);
  return path;
}

function formatPathWithPosition(input: {
  readonly path: string;
  readonly line?: string;
  readonly column?: string;
}): string {
  if (!input.line) {
    return input.path;
  }
  return `${input.path}:${input.line}${input.column ? `:${input.column}` : ""}`;
}

function isWindowsPath(value: string): boolean {
  return WINDOWS_ABSOLUTE_PATH_PATTERN.test(value) || WINDOWS_UNC_PATH_PATTERN.test(value);
}

function defaultTranslateWslPathToWindows(target: string): string {
  const parsed = splitPathAndPosition(target);
  if (parsed.path.length === 0 || !parsed.path.startsWith("/") || isWindowsPath(parsed.path)) {
    return target;
  }

  const result = spawnProcessSync("wslpath", ["-w", parsed.path], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || "wslpath failed";
    throw new Error(detail);
  }

  const translatedPath = result.stdout.trim();
  if (translatedPath.length === 0) {
    throw new Error("wslpath returned an empty path");
  }

  return formatPathWithPosition({
    path: translatedPath,
    ...(parsed.line ? { line: parsed.line } : {}),
    ...(parsed.column ? { column: parsed.column } : {}),
  });
}

function resolveOpenCommand(
  editorId: EditorId,
  options: ResolveOpenOptions,
): ReadonlyArray<string> {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const runtimeEnvironment = detectRuntimeEnvironment({ ...options, platform, env });
  const editorDef = EDITORS.find((editor) => editor.id === editorId);
  if (!editorDef) {
    return [];
  }

  if (editorId === "file-manager") {
    if (runtimeEnvironment.windowsInteropMode === "wsl-hosted") {
      return ["explorer.exe", "xdg-open"];
    }
    return [fileManagerCommandForPlatform(platform)];
  }

  if (!editorDef.command) {
    return [];
  }

  if (runtimeEnvironment.windowsInteropMode === "wsl-hosted") {
    return [editorDef.command, `${editorDef.command}.exe`];
  }

  return [editorDef.command];
}

export function resolveBrowserLaunch(
  target: string,
  options: ResolveOpenOptions = {},
): EditorLaunch | null {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const runtimeEnvironment = detectRuntimeEnvironment({ ...options, platform, env });

  if (runtimeEnvironment.windowsInteropMode === "wsl-hosted") {
    if (isCommandAvailable("wslview", { platform, env })) {
      return { command: "wslview", args: [target] };
    }
    if (isCommandAvailable("explorer.exe", { platform, env })) {
      return { command: "explorer.exe", args: [target] };
    }
  }

  return null;
}

export const resolveEditorLaunch = Effect.fnUntraced(function* (
  input: OpenInEditorInput,
  options: ResolveOpenOptions = {},
): Effect.fn.Return<EditorLaunch, OpenError> {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const runtimeEnvironment = detectRuntimeEnvironment({ ...options, platform, env });
  const editorDef = EDITORS.find((editor) => editor.id === input.editor);
  if (!editorDef) {
    return yield* new OpenError({ message: `Unknown editor: ${input.editor}` });
  }

  const translateWslPathToWindows = options.translateWslPathToWindows ?? defaultTranslateWslPathToWindows;

  if (editorDef.command) {
    const candidateCommands = resolveOpenCommand(editorDef.id, {
      platform,
      env,
      runtimeEnvironment,
    });
    const command =
      candidateCommands.find((entry) => isCommandAvailable(entry, { platform, env })) ??
      candidateCommands[0];
    if (!command) {
      return yield* new OpenError({ message: `Editor command not found: ${editorDef.command}` });
    }

    const usesWindowsPath = runtimeEnvironment.windowsInteropMode === "wsl-hosted" && command.endsWith(".exe");
    const target = usesWindowsPath
      ? yield* Effect.try({
          try: () => translateWslPathToWindows(input.cwd),
          catch: (cause) =>
            new OpenError({
              message: "Failed to translate WSL path for Windows editor launch",
              cause,
            }),
        })
      : input.cwd;

    return shouldUseGotoFlag(editorDef.id, target)
      ? { command, args: ["--goto", target] }
      : { command, args: [target] };
  }

  if (editorDef.id !== "file-manager") {
    return yield* new OpenError({ message: `Unsupported editor: ${input.editor}` });
  }

  const candidateCommands = resolveOpenCommand(editorDef.id, {
    platform,
    env,
    runtimeEnvironment,
  });
  const command =
    candidateCommands.find((entry) => isCommandAvailable(entry, { platform, env })) ??
    candidateCommands[0];
  if (!command) {
    return yield* new OpenError({ message: "Editor command not found: file-manager" });
  }

  let target = stripLineColumnSuffix(input.cwd);
  if (runtimeEnvironment.windowsInteropMode === "wsl-hosted" && command === "explorer.exe") {
    target = yield* Effect.try({
      try: () => translateWslPathToWindows(target),
      catch: (cause) =>
        new OpenError({
          message: "Failed to translate WSL path for Windows file manager launch",
          cause,
        }),
    });
  }

  return { command, args: [target] };
});

export const launchDetached = (launch: EditorLaunch) =>
  Effect.tryPromise({
    try: async () => {
      if (!isCommandAvailable(launch.command)) {
        throw new OpenError({ message: `Editor command not found: ${launch.command}` });
      }

      await spawnDetachedProcess(launch.command, [...launch.args]);
    },
    catch: (cause) =>
      Schema.is(OpenError)(cause)
        ? cause
        : new OpenError({ message: "failed to spawn detached process", cause }),
  });

const make = Effect.gen(function* () {
  const open = yield* Effect.tryPromise({
    try: () => import("open"),
    catch: (cause) => new OpenError({ message: "failed to load browser opener", cause }),
  });

  return {
    openBrowser: (target) => {
      const launch = resolveBrowserLaunch(target);
      if (launch) {
        return launchDetached(launch);
      }
      return Effect.tryPromise({
        try: () => open.default(target),
        catch: (cause) => new OpenError({ message: "Browser auto-open failed", cause }),
      });
    },
    openInEditor: (input) => Effect.flatMap(resolveEditorLaunch(input), launchDetached),
  } satisfies OpenShape;
});

export const OpenLive = Layer.effect(Open, make);
