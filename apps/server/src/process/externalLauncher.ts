/**
 * ExternalLauncher - external application launch service interface.
 *
 * Owns process launch helpers for workspace paths in configured editor integrations.
 *
 * @module ExternalLauncher
 */
import {
  EDITORS,
  ExternalLauncherError,
  ExternalLauncherCommandNotFoundError,
  ExternalLauncherEditorSpawnError,
  ExternalLauncherUnknownEditorError,
  ExternalLauncherUnsupportedEditorError,
  type EditorId,
  type LaunchEditorInput,
} from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { isCommandAvailable, resolveSpawnCommand } from "@t3tools/shared/shell";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

// ==============================
// Definitions
// ==============================

export {
  ExternalLauncherError,
  ExternalLauncherCommandNotFoundError,
  ExternalLauncherEditorSpawnError,
  ExternalLauncherUnknownEditorError,
  ExternalLauncherUnsupportedEditorError,
  isExternalLauncherError,
} from "@t3tools/contracts";
export type { LaunchEditorInput };
interface EditorLaunch {
  readonly editor: EditorId;
  readonly target: string;
  readonly command: string;
  readonly args: ReadonlyArray<string>;
}

interface ProcessLaunch {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly options: ChildProcess.CommandOptions;
}

interface TargetPathAndPosition {
  readonly path: string;
  readonly line: string;
  readonly column: Option.Option<string>;
}

const TARGET_WITH_POSITION_PATTERN = /^(.*?):(\d+)(?::(\d+))?$/;
const compactEnv = (input: Record<string, Option.Option<string>>): NodeJS.ProcessEnv =>
  Object.fromEntries(
    Object.entries(input).flatMap(([key, value]) =>
      Option.match(value, {
        onNone: () => [],
        onSome: (resolved) => [[key, resolved]],
      }),
    ),
  );

const CommandLookupEnvConfig = Config.all({
  PATH: Config.string("PATH").pipe(Config.option),
  Path: Config.string("Path").pipe(Config.option),
  path: Config.string("path").pipe(Config.option),
  PATHEXT: Config.string("PATHEXT").pipe(Config.option),
}).pipe(Config.map(compactEnv));

const readCommandLookupEnv = CommandLookupEnvConfig.pipe(Effect.orElseSucceed(() => ({})));

function parseTargetPathAndPosition(target: string): Option.Option<TargetPathAndPosition> {
  const match = TARGET_WITH_POSITION_PATTERN.exec(target);
  if (!match?.[1] || !match[2]) {
    return Option.none();
  }

  return Option.some({
    path: match[1],
    line: match[2],
    column: Option.fromUndefinedOr(match[3]),
  });
}

function resolveCommandEditorArgs(
  editor: (typeof EDITORS)[number],
  target: string,
): ReadonlyArray<string> {
  const parsedTarget = parseTargetPathAndPosition(target);

  switch (editor.launchStyle) {
    case "direct-path":
      return [target];
    case "goto":
      return Option.isSome(parsedTarget) ? ["--goto", target] : [target];
    case "line-column":
      return Option.match(parsedTarget, {
        onNone: () => [target],
        onSome: ({ path, line, column }) => [
          "--line",
          line,
          ...Option.match(column, {
            onNone: () => [],
            onSome: (value) => ["--column", value],
          }),
          path,
        ],
      });
  }
}

function resolveEditorArgs(
  editor: (typeof EDITORS)[number],
  target: string,
): ReadonlyArray<string> {
  const baseArgs = "baseArgs" in editor ? editor.baseArgs : [];
  return [...baseArgs, ...resolveCommandEditorArgs(editor, target)];
}

const resolveAvailableCommand = Effect.fn("externalLauncher.resolveAvailableCommand")(function* (
  commands: ReadonlyArray<string>,
  env: NodeJS.ProcessEnv,
): Effect.fn.Return<Option.Option<string>, never, FileSystem.FileSystem | Path.Path> {
  for (const command of commands) {
    if (yield* isCommandAvailable(command, { env })) {
      return Option.some(command);
    }
  }
  return Option.none();
});

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

const buildAvailableEditors = Effect.fn("externalLauncher.buildAvailableEditors")(function* (
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
): Effect.fn.Return<ReadonlyArray<EditorId>, never, FileSystem.FileSystem | Path.Path> {
  const available: EditorId[] = [];

  for (const editor of EDITORS) {
    if (editor.commands === null) {
      const command = fileManagerCommandForPlatform(platform);
      if (yield* isCommandAvailable(command, { env })) {
        available.push(editor.id);
      }
      continue;
    }

    const command = yield* resolveAvailableCommand(editor.commands, env);
    if (Option.isSome(command)) {
      available.push(editor.id);
    }
  }

  return available;
});

const resolveAvailableEditors = Effect.fn("externalLauncher.resolveAvailableEditors")(function* () {
  const platform = yield* HostProcessPlatform;
  const env = yield* readCommandLookupEnv;
  return yield* buildAvailableEditors(platform, env);
});

/**
 * ExternalLauncher - Service tag for editor launch operations.
 */
export class ExternalLauncher extends Context.Service<
  ExternalLauncher,
  {
    readonly resolveAvailableEditors: () => Effect.Effect<ReadonlyArray<EditorId>>;
    /**
     * Launch a workspace path in a selected editor integration.
     *
     * Launches the editor as a detached process so server startup is not blocked.
     */
    readonly launchEditor: (input: LaunchEditorInput) => Effect.Effect<void, ExternalLauncherError>;
  }
>()("t3/process/externalLauncher") {}

// ==============================
// Implementations
// ==============================

const resolveEditorLaunch = Effect.fn("resolveEditorLaunch")(function* (
  input: LaunchEditorInput,
): Effect.fn.Return<EditorLaunch, ExternalLauncherError, FileSystem.FileSystem | Path.Path> {
  const platform = yield* HostProcessPlatform;
  const env = yield* readCommandLookupEnv;
  yield* Effect.annotateCurrentSpan({
    "externalLauncher.editor": input.editor,
    "externalLauncher.cwd": input.cwd,
    "externalLauncher.platform": platform,
  });
  const editorDef = EDITORS.find((editor) => editor.id === input.editor);
  if (!editorDef) {
    return yield* new ExternalLauncherUnknownEditorError({ editor: input.editor });
  }

  if (editorDef.commands) {
    const command = Option.getOrElse(
      yield* resolveAvailableCommand(editorDef.commands, env),
      () => editorDef.commands[0],
    );
    return {
      editor: editorDef.id,
      target: input.cwd,
      command,
      args: resolveEditorArgs(editorDef, input.cwd),
    };
  }

  if (editorDef.id !== "file-manager") {
    return yield* new ExternalLauncherUnsupportedEditorError({ editor: input.editor });
  }

  return {
    editor: editorDef.id,
    target: input.cwd,
    command: fileManagerCommandForPlatform(platform),
    args: [input.cwd],
  };
});

const launchAndUnref = Effect.fn("externalLauncher.launchAndUnref")(function* (
  launch: ProcessLaunch,
  onError: (cause: unknown) => ExternalLauncherError,
): Effect.fn.Return<void, ExternalLauncherError, ChildProcessSpawner.ChildProcessSpawner> {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const command = ChildProcess.make(launch.command, launch.args, launch.options);

  yield* spawner.spawn(command).pipe(
    Effect.flatMap((handle) => handle.unref),
    Effect.asVoid,
    Effect.scoped,
    Effect.mapError(onError),
  );
});

const launchEditorProcess = Effect.fn("externalLauncher.launchEditorProcess")(function* (
  launch: EditorLaunch,
): Effect.fn.Return<
  void,
  ExternalLauncherError,
  ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path
> {
  const env = yield* readCommandLookupEnv;
  if (!(yield* isCommandAvailable(launch.command, { env }))) {
    return yield* new ExternalLauncherCommandNotFoundError({
      editor: launch.editor,
      command: launch.command,
    });
  }

  const spawnCommand = yield* resolveSpawnCommand(launch.command, launch.args, { env });
  yield* launchAndUnref(
    {
      command: spawnCommand.command,
      args: spawnCommand.args,
      options: {
        detached: true,
        shell: spawnCommand.shell,
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
      },
    },
    (cause) =>
      new ExternalLauncherEditorSpawnError({
        editor: launch.editor,
        target: launch.target,
        command: spawnCommand.command,
        args: spawnCommand.args,
        cause,
      }),
  );
});

export const make = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const provideCommandResolutionServices = <A, E, R>(
    effect: Effect.Effect<A, E, R | FileSystem.FileSystem | Path.Path>,
  ) =>
    effect.pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
    );

  return ExternalLauncher.of({
    resolveAvailableEditors: () => provideCommandResolutionServices(resolveAvailableEditors()),
    launchEditor: (input) =>
      provideCommandResolutionServices(
        Effect.flatMap(resolveEditorLaunch(input), (launch) =>
          launchEditorProcess(launch).pipe(
            Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          ),
        ),
      ),
  });
});

export const layer = Layer.effect(ExternalLauncher, make);
