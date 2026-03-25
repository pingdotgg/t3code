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
const CONFIGURED_EDITOR_ENV_KEYS = ["VISUAL", "EDITOR"] as const;
const SHELL_WORD_PATTERN = /"([^"]*)"|'([^']*)'|([^\s]+)/g;

interface ResolvedConfiguredEditor {
  readonly editorId: EditorId;
  readonly launch: EditorLaunch;
}

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

function stripWrappingQuotes(value: string): string {
  return value.replace(/^"+|"+$/g, "");
}

function resolvePathEnvironmentVariable(env: NodeJS.ProcessEnv): string {
  return env.PATH ?? env.Path ?? env.path ?? "";
}

function tokenizeCommand(value: string): ReadonlyArray<string> {
  const tokens: string[] = [];
  for (const match of value.matchAll(SHELL_WORD_PATTERN)) {
    const token = match[1] ?? match[2] ?? match[3];
    if (!token) {
      continue;
    }
    tokens.push(token);
  }
  return tokens;
}

function resolveCommandIdentity(command: string): string {
  const trimmed = command.trim();
  if (trimmed.length === 0) {
    return "";
  }
  const parts = trimmed.split(/[\\/]/);
  const lastSegment = parts[parts.length - 1] ?? trimmed;
  const extension = extname(lastSegment);
  const commandName = extension.length > 0 ? lastSegment.slice(0, -extension.length) : lastSegment;
  return commandName.toLowerCase();
}

function resolveConfiguredEditor(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): ResolvedConfiguredEditor | null {
  for (const envKey of CONFIGURED_EDITOR_ENV_KEYS) {
    const rawValue = env[envKey]?.trim();
    if (!rawValue) {
      continue;
    }

    const [command, ...args] = tokenizeCommand(rawValue);
    if (!command) {
      continue;
    }
    if (!isCommandAvailable(command, { platform, env })) {
      continue;
    }

    const builtInEditor = EDITORS.find(
      (editor) =>
        editor.command &&
        resolveCommandIdentity(editor.command) === resolveCommandIdentity(command),
    );
    return {
      editorId: builtInEditor?.id ?? "system-editor",
      launch: {
        command,
        args,
      },
    };
  }

  return null;
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
  const configuredEditor = resolveConfiguredEditor(env, platform);

  for (const editor of EDITORS) {
    if (editor.id === "system-editor") {
      continue;
    }

    const command =
      editor.id === "file-manager" ? fileManagerCommandForPlatform(platform) : editor.command;
    const isConfiguredEditor = configuredEditor?.editorId === editor.id;
    if ((command && isCommandAvailable(command, { platform, env })) || isConfiguredEditor) {
      available.push(editor.id);
    }
  }

  if (configuredEditor?.editorId === "system-editor") {
    available.push("system-editor");
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

export const resolveEditorLaunch = Effect.fnUntraced(function* (
  input: OpenInEditorInput,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): Effect.fn.Return<EditorLaunch, OpenError> {
  const editorDef = EDITORS.find((editor) => editor.id === input.editor);
  if (!editorDef) {
    return yield* new OpenError({ message: `Unknown editor: ${input.editor}` });
  }

  const configuredEditor = resolveConfiguredEditor(env, platform);
  if (configuredEditor && configuredEditor.editorId === input.editor) {
    return shouldUseGotoFlag(input.editor, input.cwd)
      ? {
          command: configuredEditor.launch.command,
          args: [...configuredEditor.launch.args, "--goto", input.cwd],
        }
      : {
          command: configuredEditor.launch.command,
          args: [...configuredEditor.launch.args, input.cwd],
        };
  }

  if (editorDef.id === "system-editor") {
    return yield* new OpenError({
      message: "System editor is not configured. Set VISUAL or EDITOR to use it.",
    });
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
