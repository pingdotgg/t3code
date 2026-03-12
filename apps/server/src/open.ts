/**
 * Open - Browser/editor launch service interface.
 *
 * Owns process launch helpers for opening URLs in a browser and workspace
 * paths in a configured editor.
 *
 * @module Open
 */
import { spawn, spawnSync } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { extname, join } from "node:path";

import {
  EDITORS,
  type EditorId,
  WORKSPACE_OPEN_TARGETS,
  type WorkspaceOpenTargetId,
} from "@t3tools/contracts";
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

export interface OpenWorkspaceInput {
  readonly cwd: string;
  readonly target: WorkspaceOpenTargetId;
}

interface EditorLaunch {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
}

interface CommandAvailabilityOptions {
  readonly platform?: NodeJS.Platform;
  readonly env?: NodeJS.ProcessEnv;
}

interface OpenTargetAvailabilityOptions extends CommandAvailabilityOptions {
  readonly isMacApplicationAvailable?: (appName: string) => boolean;
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

function ghosttyCommandForPlatform(platform: NodeJS.Platform): string | null {
  switch (platform) {
    case "darwin":
    case "linux":
      return "ghostty";
    default:
      return null;
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
    const command = editor.command ?? fileManagerCommandForPlatform(platform);
    if (isCommandAvailable(command, { platform, env })) {
      available.push(editor.id);
    }
  }

  return available;
}

function isWorkspaceEditorTarget(target: WorkspaceOpenTargetId): target is EditorId {
  return target !== "ghostty";
}

function resolveWorkspaceTargetCommand(
  target: WorkspaceOpenTargetId,
  platform: NodeJS.Platform,
): string | null {
  if (target === "ghostty") {
    return ghosttyCommandForPlatform(platform);
  }

  const editorDef = EDITORS.find((editor) => editor.id === target);
  if (!editorDef) return null;
  return editorDef.command ?? fileManagerCommandForPlatform(platform);
}

function isMacApplicationAvailable(appName: string): boolean {
  const result = spawnSync("open", ["-Ra", appName], {
    stdio: "ignore",
  });
  return result.status === 0;
}

function isWorkspaceTargetAvailable(
  target: WorkspaceOpenTargetId,
  options: OpenTargetAvailabilityOptions,
): boolean {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;

  if (target === "ghostty") {
    switch (platform) {
      case "darwin":
        return (options.isMacApplicationAvailable ?? isMacApplicationAvailable)("Ghostty");
      case "linux":
        return isCommandAvailable("ghostty", { platform, env });
      default:
        return false;
    }
  }

  const command = resolveWorkspaceTargetCommand(target, platform);
  if (!command) return false;
  return isCommandAvailable(command, { platform, env });
}

export function resolveAvailableOpenTargets(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  options: Omit<OpenTargetAvailabilityOptions, "platform" | "env"> = {},
): ReadonlyArray<WorkspaceOpenTargetId> {
  const available: WorkspaceOpenTargetId[] = [];

  for (const target of WORKSPACE_OPEN_TARGETS) {
    if (
      isWorkspaceTargetAvailable(target.id, {
        platform,
        env,
        ...options,
      })
    ) {
      available.push(target.id);
    }
  }

  return available;
}

function escapeAppleScriptString(value: string): string {
  return JSON.stringify(value);
}

function ghosttyAppleScript(cwd: string): string {
  return [
    'tell application "Ghostty"',
    "    activate",
    "    set cfg to new surface configuration",
    `    set initial working directory of cfg to ${escapeAppleScriptString(cwd)}`,
    "    new window with configuration cfg",
    "end tell",
  ].join("\n");
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

  /**
   * Open a workspace in a selected workspace launcher target.
   */
  readonly openWorkspace: (input: OpenWorkspaceInput) => Effect.Effect<void, OpenError>;
}

/**
 * Open - Service tag for browser/editor launch operations.
 */
export class Open extends ServiceMap.Service<Open, OpenShape>()("t3/open") {}

// ==============================
// Implementations
// ==============================

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

  if (editorDef.id !== "file-manager") {
    return yield* new OpenError({ message: `Unsupported editor: ${input.editor}` });
  }

  return { command: fileManagerCommandForPlatform(platform), args: [input.cwd] };
});

export const resolveWorkspaceLaunch = Effect.fnUntraced(function* (
  input: OpenWorkspaceInput,
  platform: NodeJS.Platform = process.platform,
): Effect.fn.Return<EditorLaunch, OpenError> {
  if (isWorkspaceEditorTarget(input.target)) {
    return yield* resolveEditorLaunch({ cwd: input.cwd, editor: input.target }, platform);
  }

  switch (platform) {
    case "darwin":
      return {
        command: "osascript",
        args: ["-e", ghosttyAppleScript(input.cwd)],
      };
    case "linux":
      return {
        command: "ghostty",
        args: ["+new-window", "--working-directory", input.cwd],
      };
    default:
      return yield* new OpenError({
        message: `Unsupported workspace target ${input.target} on platform ${platform}`,
      });
  }
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
    openWorkspace: (input) => Effect.flatMap(resolveWorkspaceLaunch(input), launchDetached),
  } satisfies OpenShape;
});

export const OpenLive = Layer.effect(Open, make);
