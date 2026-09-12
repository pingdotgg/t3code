import { ProjectId } from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import {
  projectScriptRuntimeEnv,
  resolveProjectScripts,
  setupProjectScript,
} from "@t3tools/shared/projectScripts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TerminalManager from "../terminal/Manager.ts";

export interface ProjectSetupScriptRunnerResultNoScript {
  readonly status: "no-script";
}

export interface ProjectSetupScriptRunnerResultStarted {
  readonly status: "started";
  readonly scriptId: string;
  readonly scriptName: string;
  readonly scriptCommand: string;
  readonly terminalId: string;
  readonly cwd: string;
  /**
   * Resolves when the script's shell prints the completion sentinel. The
   * exit code is null when the terminal exited or was closed before the
   * sentinel arrived. Only present when `observeCompletion` was requested.
   */
  readonly completion?: Effect.Effect<ProjectSetupScriptCompletion>;
}

export interface ProjectSetupScriptCompletion {
  readonly exitCode: number | null;
  readonly durationMs: number;
}

export interface ProjectSetupScriptOutputLine {
  readonly line: string;
}

export type ProjectSetupScriptRunnerResult =
  | ProjectSetupScriptRunnerResultNoScript
  | ProjectSetupScriptRunnerResultStarted;

export interface ProjectSetupScriptRunnerInput {
  readonly threadId: string;
  readonly projectId?: string;
  readonly projectCwd?: string;
  readonly worktreePath: string;
  readonly preferredTerminalId?: string;
  /**
   * Wrap the command so the shell reports its exit code back through the
   * terminal stream, and forward cleaned output lines while it runs. The
   * bootstrap flow uses this to drive the worktree setup card.
   */
  readonly observeCompletion?: {
    readonly onOutputLine?: (line: string) => Effect.Effect<void>;
  };
}

export class ProjectSetupScriptOperationError extends Schema.TaggedError<ProjectSetupScriptOperationError>()(
  "ProjectSetupScriptOperationError",
  {
    threadId: Schema.String,
    projectId: Schema.optional(Schema.String),
    projectCwd: Schema.optional(Schema.String),
    worktreePath: Schema.String,
    operation: Schema.Literals(["resolveProject", "readSettings", "openTerminal", "writeCommand"]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Project setup script operation '${this.operation}' failed for thread '${this.threadId}' in '${this.worktreePath}'.`;
  }
}

export class ProjectSetupScriptProjectNotFoundError extends Schema.TaggedError<ProjectSetupScriptProjectNotFoundError>()(
  "ProjectSetupScriptProjectNotFoundError",
  {
    threadId: Schema.String,
    projectId: Schema.optional(Schema.String),
    projectCwd: Schema.optional(Schema.String),
    worktreePath: Schema.String,
  },
) {
  override get message(): string {
    return `Project was not found for setup script execution for thread '${this.threadId}' in '${this.worktreePath}'.`;
  }
}

export const ProjectSetupScriptRunnerError = Schema.Union([
  ProjectSetupScriptOperationError,
  ProjectSetupScriptProjectNotFoundError,
]);
export type ProjectSetupScriptRunnerError = typeof ProjectSetupScriptRunnerError.Type;

export class ProjectSetupScriptRunner extends Context.Service<
  ProjectSetupScriptRunner,
  {
    readonly runForThread: (
      input: ProjectSetupScriptRunnerInput,
    ) => Effect.Effect<ProjectSetupScriptRunnerResult, ProjectSetupScriptRunnerError>;
  }
>()("t3/project/ProjectSetupScriptRunner") {}

/** @public Service construction is part of the canonical Effect module API. */
/** Marker the wrapped setup command echoes so the exit code can be read from the PTY stream. */
const COMPLETION_SENTINEL_PREFIX = "__T3_SETUP_DONE__:";
const COMPLETION_SENTINEL_PATTERN = /__T3_SETUP_DONE__:(-?\d+)/;
const OUTPUT_LINE_MAX_LENGTH = 400;

/** Removes ANSI escape sequences and cursor controls so lines can be shown as plain text. */
function stripTerminalControl(text: string): string {
  return (
    text
      .replace(
        // eslint-disable-next-line no-control-regex
        /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][A-Za-z0-9]|\x1b[=>]/g,
        "",
      )
      // eslint-disable-next-line no-control-regex
      .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "")
  );
}

/**
 * Builds the shell line for the setup script. On POSIX shells the user's
 * command runs in a subshell so `&&` chains and `cd` cannot leak, then the
 * exit status is echoed. PowerShell reports `$LASTEXITCODE` or falls back to
 * the success flag.
 */
function wrapCommandForCompletion(command: string, platform: NodeJS.Platform): string {
  if (platform === "win32") {
    return `& { ${command} }; if ($null -ne $LASTEXITCODE) { $__t3c = $LASTEXITCODE } elseif ($?) { $__t3c = 0 } else { $__t3c = 1 }; Write-Host "${COMPLETION_SENTINEL_PREFIX}$__t3c"`;
  }
  return `( ${command} ); printf '\\n${COMPLETION_SENTINEL_PREFIX}%s\\n' "$?"`;
}

export const make = Effect.gen(function* () {
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const terminalManager = yield* TerminalManager.TerminalManager;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const platform = yield* HostProcessPlatform;

  /**
   * Watches the setup terminal for the completion sentinel. Terminal output is
   * a byte stream, so partial lines are buffered until a newline. The
   * subscription is torn down once the sentinel, an exit, or a close arrives.
   */
  const observeTerminalCompletion = (input: {
    readonly threadId: string;
    readonly terminalId: string;
    readonly onOutputLine: ((line: string) => Effect.Effect<void>) | undefined;
  }) =>
    Effect.gen(function* () {
      const startedAtMs = yield* Clock.currentTimeMillis;
      const done = yield* Deferred.make<ProjectSetupScriptCompletion>();
      let lineBuffer = "";
      let settled = false;

      const settle = (exitCode: number | null) =>
        Effect.suspend(() => {
          if (settled) return Effect.void;
          settled = true;
          return Clock.currentTimeMillis.pipe(
            Effect.flatMap((nowMs) =>
              Deferred.succeed(done, { exitCode, durationMs: nowMs - startedAtMs }),
            ),
            Effect.asVoid,
          );
        });

      const handleLine = (rawLine: string) =>
        Effect.suspend(() => {
          const sentinel = COMPLETION_SENTINEL_PATTERN.exec(rawLine);
          if (sentinel) {
            const parsed = Number(sentinel[1]);
            return settle(Number.isFinite(parsed) ? parsed : null);
          }
          const cleaned = stripTerminalControl(rawLine).trimEnd();
          // The echoed command line itself contains the sentinel prefix; hide it.
          if (
            cleaned.length === 0 ||
            cleaned.includes(COMPLETION_SENTINEL_PREFIX) ||
            input.onOutputLine === undefined
          ) {
            return Effect.void;
          }
          return input.onOutputLine(cleaned.slice(0, OUTPUT_LINE_MAX_LENGTH));
        });

      const unsubscribe = yield* terminalManager.subscribe((event) => {
        if (event.threadId !== input.threadId || event.terminalId !== input.terminalId) {
          return Effect.void;
        }
        if (event.type === "output") {
          lineBuffer += event.data;
          const lines = lineBuffer.split(/\r?\n/);
          lineBuffer = lines.pop() ?? "";
          return Effect.forEach(lines, handleLine, { discard: true });
        }
        if (event.type === "exited" || event.type === "closed") {
          return settle(null);
        }
        return Effect.void;
      });

      const completion = Deferred.await(done).pipe(
        Effect.ensuring(Effect.sync(() => unsubscribe())),
      );
      return completion;
    });

  const runForThread: ProjectSetupScriptRunner["Service"]["runForThread"] = Effect.fn(
    "ProjectSetupScriptRunner.runForThread",
  )(function* (input) {
    const errorContext = {
      threadId: input.threadId,
      worktreePath: input.worktreePath,
      ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
      ...(input.projectCwd === undefined ? {} : { projectCwd: input.projectCwd }),
    };
    const projectById = input.projectId
      ? yield* projectionSnapshotQuery.getProjectShellById(ProjectId.make(input.projectId)).pipe(
          Effect.map(Option.getOrUndefined),
          Effect.mapError(
            (cause) =>
              new ProjectSetupScriptOperationError({
                ...errorContext,
                operation: "resolveProject",
                cause,
              }),
          ),
        )
      : null;
    const project =
      projectById ??
      (input.projectCwd
        ? yield* projectionSnapshotQuery.getActiveProjectByWorkspaceRoot(input.projectCwd).pipe(
            Effect.map(Option.getOrUndefined),
            Effect.mapError(
              (cause) =>
                new ProjectSetupScriptOperationError({
                  ...errorContext,
                  operation: "resolveProject",
                  cause,
                }),
            ),
          )
        : null);

    if (!project) {
      return yield* new ProjectSetupScriptProjectNotFoundError(errorContext);
    }

    const settings = yield* serverSettings.getSettings.pipe(
      Effect.mapError(
        (cause) =>
          new ProjectSetupScriptOperationError({
            ...errorContext,
            operation: "readSettings",
            cause,
          }),
      ),
    );
    const script = setupProjectScript(resolveProjectScripts(settings, project));
    if (!script) {
      return {
        status: "no-script",
      } as const;
    }

    const terminalId = input.preferredTerminalId ?? `setup-${script.id}`;
    const cwd = input.worktreePath;
    const env = projectScriptRuntimeEnv({
      project: { cwd: project.workspaceRoot },
      worktreePath: input.worktreePath,
    });
    const observe = input.observeCompletion;
    const commandLine = observe
      ? wrapCommandForCompletion(script.command, platform)
      : script.command;

    yield* terminalManager
      .open({
        threadId: input.threadId,
        terminalId,
        cwd,
        worktreePath: input.worktreePath,
        env,
      })
      .pipe(
        Effect.mapError(
          (cause) =>
            new ProjectSetupScriptOperationError({
              ...errorContext,
              operation: "openTerminal",
              cause,
            }),
        ),
      );
    // Subscribe before writing so the sentinel cannot race past the listener.
    const completion = observe
      ? yield* observeTerminalCompletion({
          threadId: input.threadId,
          terminalId,
          onOutputLine: observe.onOutputLine,
        })
      : undefined;

    yield* terminalManager
      .write({
        threadId: input.threadId,
        terminalId,
        data: `${commandLine}\r`,
      })
      .pipe(
        Effect.mapError(
          (cause) =>
            new ProjectSetupScriptOperationError({
              ...errorContext,
              operation: "writeCommand",
              cause,
            }),
        ),
      );

    return {
      status: "started",
      scriptId: script.id,
      scriptName: script.name,
      scriptCommand: script.command,
      terminalId,
      cwd,
      ...(completion ? { completion } : {}),
    } as const;
  });

  return ProjectSetupScriptRunner.of({ runForThread });
});

export const layer = Layer.effect(ProjectSetupScriptRunner, make);
