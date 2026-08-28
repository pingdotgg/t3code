import { ProjectId } from "@t3tools/contracts";
import { HostProcessEnvironment } from "@t3tools/shared/hostProcess";
import { projectScriptRuntimeEnv, setupProjectScript } from "@t3tools/shared/projectScripts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SynchronizedRef from "effect/SynchronizedRef";

import * as ServerConfig from "../config.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as TerminalManager from "../terminal/Manager.ts";
import * as ProjectSetupScriptProcess from "./ProjectSetupScriptProcess.ts";

export const DEFAULT_SETUP_SCRIPT_TIMEOUT = Duration.minutes(10);
export const MAX_SETUP_SCRIPT_LOG_BYTES = 1_048_576;

export interface ProjectSetupScriptRunnerResultNoScript {
  readonly status: "no-script";
}

export interface ProjectSetupScriptRunnerResultCompleted {
  readonly status: "succeeded" | "failed";
  readonly scriptId: string;
  readonly scriptName: string;
  readonly terminalId: string;
  readonly cwd: string;
  readonly exitCode: number | null;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly logPath: string;
}

export type ProjectSetupScriptRunnerResult =
  | ProjectSetupScriptRunnerResultNoScript
  | ProjectSetupScriptRunnerResultCompleted;

export interface ProjectSetupScriptRunnerInput {
  readonly threadId: string;
  readonly projectId?: string;
  readonly projectCwd?: string;
  readonly worktreePath: string;
  readonly preferredTerminalId?: string;
  readonly onSpawn?: (info: {
    readonly scriptId: string;
    readonly scriptName: string;
    readonly terminalId: string;
    readonly cwd: string;
    readonly logPath: string;
    readonly startedAt: string;
  }) => Effect.Effect<void, never, never>;
}

export class ProjectSetupScriptOperationError extends Schema.TaggedErrorClass<ProjectSetupScriptOperationError>()(
  "ProjectSetupScriptOperationError",
  {
    threadId: Schema.String,
    projectId: Schema.optional(Schema.String),
    projectCwd: Schema.optional(Schema.String),
    worktreePath: Schema.String,
    operation: Schema.Literals(["resolveProject", "spawn", "writeLog"]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Project setup script operation '${this.operation}' failed for thread '${this.threadId}' in '${this.worktreePath}'.`;
  }
}

export class ProjectSetupScriptProjectNotFoundError extends Schema.TaggedErrorClass<ProjectSetupScriptProjectNotFoundError>()(
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

type InFlight = Effect.Effect<ProjectSetupScriptRunnerResult, ProjectSetupScriptRunnerError, never>;

type Claimed = {
  readonly role: "join" | "start";
  readonly wait: InFlight;
};

export class ProjectSetupScriptRunner extends Context.Service<
  ProjectSetupScriptRunner,
  {
    readonly runForThread: (
      input: ProjectSetupScriptRunnerInput,
    ) => Effect.Effect<ProjectSetupScriptRunnerResult, ProjectSetupScriptRunnerError>;
  }
>()("t3/project/ProjectSetupScriptRunner") {}

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

const toStringEnv = (env: NodeJS.ProcessEnv): Record<string, string> => {
  const next: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) {
      next[key] = value;
    }
  }
  return next;
};

export const make = Effect.gen(function* () {
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const terminalManager = yield* TerminalManager.TerminalManager;
  const setupProcess = yield* ProjectSetupScriptProcess.ProjectSetupScriptProcess;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const serverConfig = yield* ServerConfig.ServerConfig;
  const hostEnv = yield* HostProcessEnvironment;
  const inFlight = yield* SynchronizedRef.make(new Map<string, InFlight>());

  const runExclusive: ProjectSetupScriptRunner["Service"]["runForThread"] = Effect.fn(
    "ProjectSetupScriptRunner.runExclusive",
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

    const script = setupProjectScript(project.scripts);
    if (!script) {
      return {
        status: "no-script",
      } as const;
    }

    const terminalId = input.preferredTerminalId ?? `setup-${script.id}`;
    const cwd = input.worktreePath;
    const env = {
      ...toStringEnv(hostEnv),
      ...projectScriptRuntimeEnv({
        project: { cwd: project.workspaceRoot },
        worktreePath: input.worktreePath,
      }),
    };
    const logDir = path.join(serverConfig.logsDir, "setup-scripts");
    const logPath = path.join(logDir, `${input.threadId}_${script.id}.log`);
    yield* fileSystem.makeDirectory(logDir, { recursive: true }).pipe(
      Effect.mapError(
        (cause) =>
          new ProjectSetupScriptOperationError({
            ...errorContext,
            operation: "writeLog",
            cause,
          }),
      ),
    );
    yield* fileSystem.writeFileString(logPath, "").pipe(
      Effect.mapError(
        (cause) =>
          new ProjectSetupScriptOperationError({
            ...errorContext,
            operation: "writeLog",
            cause,
          }),
      ),
    );

    yield* terminalManager
      .open({
        threadId: input.threadId,
        terminalId,
        cwd,
        worktreePath: input.worktreePath,
        env: projectScriptRuntimeEnv({
          project: { cwd: project.workspaceRoot },
          worktreePath: input.worktreePath,
        }),
      })
      .pipe(Effect.ignore);

    const startedAt = yield* nowIso;
    return yield* Effect.scoped(
      Effect.gen(function* () {
        const handle = yield* setupProcess
          .spawn({
            command: script.command,
            cwd,
            env,
          })
          .pipe(
            Effect.mapError(
              (cause) =>
                new ProjectSetupScriptOperationError({
                  ...errorContext,
                  operation: "spawn",
                  cause,
                }),
            ),
          );

        if (input.onSpawn) {
          yield* input.onSpawn({
            scriptId: script.id,
            scriptName: script.name,
            terminalId,
            cwd,
            logPath,
            startedAt,
          });
        }

        const logBytes = yield* Ref.make(0);
        const logTruncated = yield* Ref.make(false);
        const persistChunk = (text: string) =>
          Effect.gen(function* () {
            if (text.length === 0) {
              return;
            }
            const written = yield* Ref.get(logBytes);
            if (written >= MAX_SETUP_SCRIPT_LOG_BYTES) {
              const alreadyTruncated = yield* Ref.get(logTruncated);
              if (!alreadyTruncated) {
                yield* Ref.set(logTruncated, true);
                yield* fileSystem.writeFileString(logPath, "\n[truncated]\n", { flag: "a" }).pipe(
                  Effect.catch((cause) =>
                    Effect.logWarning("failed to persist setup script log", {
                      threadId: input.threadId,
                      logPath,
                      cause,
                    }),
                  ),
                );
              }
              return;
            }
            const remaining = MAX_SETUP_SCRIPT_LOG_BYTES - written;
            const slice = text.length > remaining ? text.slice(0, remaining) : text;
            yield* Ref.set(logBytes, written + slice.length);
            yield* fileSystem.writeFileString(logPath, slice, { flag: "a" }).pipe(
              Effect.catch((cause) =>
                Effect.logWarning("failed to persist setup script log", {
                  threadId: input.threadId,
                  logPath,
                  cause,
                }),
              ),
            );
            if (slice.length < text.length) {
              yield* Ref.set(logTruncated, true);
              yield* fileSystem.writeFileString(logPath, "\n[truncated]\n", { flag: "a" }).pipe(
                Effect.catch((cause) =>
                  Effect.logWarning("failed to persist setup script log", {
                    threadId: input.threadId,
                    logPath,
                    cause,
                  }),
                ),
              );
            }
          });
        const consume = (stream: Stream.Stream<Uint8Array>) => {
          const decoder = new TextDecoder("utf-8");
          return stream.pipe(
            Stream.catchCause(() => Stream.empty),
            Stream.runForEach((chunk) =>
              Effect.gen(function* () {
                const text = decoder.decode(chunk, { stream: true });
                if (text.length === 0) {
                  return;
                }
                yield* persistChunk(text);
                yield* terminalManager
                  .appendOutput({
                    threadId: input.threadId,
                    terminalId,
                    data: text,
                  })
                  .pipe(Effect.ignore);
              }),
            ),
            Effect.flatMap(() =>
              Effect.gen(function* () {
                const flushed = decoder.decode();
                if (flushed.length === 0) {
                  return;
                }
                yield* persistChunk(flushed);
                yield* terminalManager
                  .appendOutput({
                    threadId: input.threadId,
                    terminalId,
                    data: flushed,
                  })
                  .pipe(Effect.ignore);
              }),
            ),
          );
        };

        const timeoutMs = script.setupScriptTimeoutMs;
        const timeout =
          typeof timeoutMs === "number" ? Duration.millis(timeoutMs) : DEFAULT_SETUP_SCRIPT_TIMEOUT;
        const waitForExit = Effect.all(
          [consume(handle.stdout), consume(handle.stderr), handle.exitCode],
          { concurrency: "unbounded" },
        ).pipe(Effect.map(([, , exitCode]) => exitCode));

        const timed = yield* waitForExit.pipe(Effect.timeoutOption(timeout));
        const finishedAt = yield* nowIso;

        const completed = (
          status: "succeeded" | "failed",
          exitCode: number | null,
        ): ProjectSetupScriptRunnerResultCompleted => ({
          status,
          scriptId: script.id,
          scriptName: script.name,
          terminalId,
          cwd,
          exitCode,
          startedAt,
          finishedAt,
          logPath,
        });

        if (Option.isNone(timed)) {
          yield* handle.kill.pipe(Effect.ignore);
          yield* Effect.logError("Project setup script timed out", {
            threadId: input.threadId,
            worktreePath: input.worktreePath,
            command: script.command,
            logPath,
          });
          return completed("failed", null);
        }

        const exitCode = timed.value;
        if (exitCode !== 0) {
          yield* Effect.logError("Project setup script exited with a non-zero status", {
            threadId: input.threadId,
            worktreePath: input.worktreePath,
            command: script.command,
            exitCode,
            logPath,
          });
          return completed("failed", exitCode);
        }

        return completed("succeeded", exitCode);
      }),
    );
  });

  const runForThread: ProjectSetupScriptRunner["Service"]["runForThread"] = Effect.fn(
    "ProjectSetupScriptRunner.runForThread",
  )(function* (input) {
    const waiter = yield* Deferred.make<
      ProjectSetupScriptRunnerResult,
      ProjectSetupScriptRunnerError
    >();
    const claimed = yield* SynchronizedRef.modify(
      inFlight,
      (current): readonly [Claimed, Map<string, InFlight>] => {
        const existing = current.get(input.worktreePath);
        if (existing !== undefined) {
          return [{ role: "join", wait: existing }, current];
        }
        const wait = Deferred.await(waiter);
        const next = new Map(current);
        next.set(input.worktreePath, wait);
        return [{ role: "start", wait }, next];
      },
    );

    if (claimed.role === "join") {
      return yield* claimed.wait;
    }

    const exit = yield* runExclusive(input).pipe(Effect.exit);
    yield* Deferred.done(waiter, exit);
    yield* SynchronizedRef.update(inFlight, (current) => {
      const next = new Map(current);
      next.delete(input.worktreePath);
      return next;
    });
    if (Exit.isSuccess(exit)) {
      return exit.value;
    }
    return yield* Effect.failCause(exit.cause);
  });

  return ProjectSetupScriptRunner.of({ runForThread });
});

export const layer = Layer.effect(ProjectSetupScriptRunner, make);
