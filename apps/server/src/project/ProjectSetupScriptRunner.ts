import {
  ProjectId,
  ThreadId,
  type ProjectScript,
  type ProjectRunScriptInput,
  type ProjectRunScriptResult,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as KeyedLock from "@t3tools/shared/KeyedLock";
import {
  projectScriptRuntimeEnv,
  projectScriptCwd,
  projectScriptReservesPort,
  projectScriptTerminalId,
  projectScriptTerminalInput,
  resolveProjectScripts,
  settleProjectScript,
  setupProjectScript,
} from "@t3tools/shared/projectScripts";

import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as ServerSettings from "../serverSettings.ts";
import * as TerminalManager from "../terminal/Manager.ts";
import * as ProjectService from "./ProjectService.ts";
import * as ProjectScriptPorts from "./ProjectScriptPorts.ts";

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
  readonly async: boolean;
  readonly threadId?: string;
  readonly port?: number;
  /**
   * The exit code is null when the terminal exited or was closed before the sentinel arrived.
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
  readonly worktreePath: string | null;
  readonly preferredTerminalId?: string;
  readonly trigger?: "setup" | "settle";
  readonly scriptId?: string;
  readonly project?: {
    readonly id: ProjectId;
    readonly workspaceRoot: string;
    readonly scripts: ReadonlyArray<ProjectScript>;
  };
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
    worktreePath: Schema.NullOr(Schema.String),
    operation: Schema.Literals([
      "resolveProject",
      "readSettings",
      "reservePort",
      "openTerminal",
      "writeCommand",
    ]),
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
    worktreePath: Schema.NullOr(Schema.String),
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
    readonly runScript: (
      input: ProjectRunScriptInput,
    ) => Effect.Effect<ProjectRunScriptResult, ProjectSetupScriptRunnerError>;
  }
>()("t3/project/ProjectSetupScriptRunner") {}

/** @public Service construction is part of the canonical Effect module API. */
/**
 * Each run gets its own random token so script output cannot spoof completion, and the sentinel
 * pattern is built per run from it.
 */
const COMPLETION_SENTINEL_PREFIX = "__T3_SETUP_DONE__";
const OUTPUT_LINE_MAX_LENGTH = 400;
const PARTIAL_LINE_MAX_LENGTH = 4_096;

function completionSentinel(token: string): string {
  return `${COMPLETION_SENTINEL_PREFIX}_${token}:`;
}

function completionSentinelPattern(token: string): RegExp {
  return new RegExp(`${COMPLETION_SENTINEL_PREFIX}_${token}:(-?\\d+)`);
}

function stripTerminalControl(text: string): string {
  return (
    text
      .replace(
        // eslint-disable-next-line no-control-regex -- ANSI escape sequences start with ESC.
        /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][A-Za-z0-9]|\x1b[=>]/g,
        "",
      )
      // eslint-disable-next-line no-control-regex -- removing control characters is the point.
      .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "")
  );
}

type CompletionShell = "posix" | "fish" | "powershell";

function resolveCompletionShell(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
): CompletionShell {
  if (platform === "win32") return "powershell";
  const shell = env.SHELL ?? "";
  const name = shell.split("/").at(-1) ?? shell;
  if (name === "fish") return "fish";
  if (name === "pwsh" || name === "powershell") return "powershell";
  return "posix";
}

/**
 * The command runs inside a block and the block closes on its own line, so a trailing `# comment`
 * or a heredoc terminator in the command cannot swallow the sentinel. The shell reads the whole
 * block before running any of it, so a script that reads stdin cannot consume the sentinel line
 * either. Completion must also survive Ctrl+C, which skips trailing commands in interactive shells.
 */
function wrapCommandForCompletion(
  command: string,
  shell: CompletionShell,
  sentinel: string,
): string {
  const body = command.replace(/\r?\n/g, "\r");
  switch (shell) {
    case "powershell":
      return `$global:LASTEXITCODE = $null; $__t3c = 130; try { & {\r${body}\r}; if ($null -ne $LASTEXITCODE) { $__t3c = $LASTEXITCODE } elseif ($?) { $__t3c = 0 } else { $__t3c = 1 } } finally { Write-Host "${sentinel}$__t3c" }`;
    case "fish": {
      const completionFunction = sentinel.slice(0, -1);
      return `begin\rfunction ${completionFunction} --on-event fish_postexec\rprintf '\\n${sentinel}%s\\n' 130\rfunctions -e ${completionFunction}\rend\rbegin\r${body}\rend\rset -l __t3c $status\rfunctions -e ${completionFunction}\rprintf '\\n${sentinel}%s\\n' $__t3c\rend`;
    }
    case "posix":
      return `(\rtrap 'exit 130' INT\rtrap 'printf "\\n${sentinel}%s\\n" "$?"' EXIT\r( ${body}\r)\r)`;
  }
}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const projects = yield* ProjectService.ProjectService;
  const terminalManager = yield* TerminalManager.TerminalManager;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const scriptPorts = yield* ProjectScriptPorts.ProjectScriptPorts;
  const crypto = yield* Crypto.Crypto;
  const scope = yield* Effect.scope;
  const launchLocks = yield* KeyedLock.make<number>();
  const activeRuns = new Map<number, ProjectSetupScriptRunnerResultStarted>();
  const completionShell = resolveCompletionShell(
    yield* HostProcess.Platform,
    yield* HostProcess.Environment,
  );

  const observeTerminalCompletion = Effect.fn("ProjectSetupScriptRunner.observeTerminalCompletion")(
    function* (input: {
      readonly threadId: string;
      readonly terminalId: string;
      readonly sentinel: string;
      readonly sentinelPattern: RegExp;
      /** The shell echoes typed input; lines ending with these are the wrapper, not output. */
      readonly echoedWrapperLines: ReadonlyArray<string>;
      readonly onOutputLine: ((line: string) => Effect.Effect<void>) | undefined;
    }) {
      const startedAtMs = yield* Clock.currentTimeMillis;
      const done = yield* Deferred.make<ProjectSetupScriptCompletion>();
      // The shell redraws its prompt just after the sentinel. Closing before
      // that would read the redraw as new activity and keep an idle shell.
      const promptReturned = yield* Deferred.make<void>();
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
          const sentinel = input.sentinelPattern.exec(rawLine);
          if (sentinel) {
            const parsed = Number(sentinel[1]);
            return settle(Number.isFinite(parsed) ? parsed : null);
          }
          const cleaned = stripTerminalControl(rawLine).trimEnd();
          if (
            cleaned.length === 0 ||
            cleaned.includes(input.sentinel) ||
            input.echoedWrapperLines.some((echoed) => cleaned.endsWith(echoed)) ||
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
          // A bare carriage return is how installers redraw a progress line in
          // place; each redraw becomes a short line of its own instead of being
          // glued into one long one.
          const lines = lineBuffer.split(/\r\n|\r|\n/);
          lineBuffer = lines.pop() ?? "";
          // A script that never prints a newline must not grow this forever.
          // The sentinel is always on its own line, so keeping the tail is safe.
          if (lineBuffer.length > PARTIAL_LINE_MAX_LENGTH) {
            lineBuffer = lineBuffer.slice(-PARTIAL_LINE_MAX_LENGTH);
          }
          return Effect.forEach(lines, handleLine, { discard: true }).pipe(
            Effect.andThen(
              Effect.suspend(() =>
                settled && lineBuffer.length > 0
                  ? Deferred.succeed(promptReturned, undefined).pipe(Effect.asVoid)
                  : Effect.void,
              ),
            ),
          );
        }
        if (
          event.type === "exited" ||
          event.type === "closed" ||
          event.type === "error" ||
          event.type === "started" ||
          event.type === "restarted"
        ) {
          return settle(null).pipe(Effect.andThen(Deferred.succeed(promptReturned, undefined)));
        }
        return Effect.void;
      });

      const completion = Deferred.await(done).pipe(
        // A shell with an empty prompt never prints one; do not wait forever.
        Effect.tap(() => Deferred.await(promptReturned).pipe(Effect.timeoutOption("1 second"))),
        Effect.ensuring(Effect.sync(() => unsubscribe())),
      );
      return { completion, unsubscribe };
    },
  );

  const runForThread: ProjectSetupScriptRunner["Service"]["runForThread"] = Effect.fn(
    "ProjectSetupScriptRunner.runForThread",
  )(function* (input) {
    const errorContext = {
      threadId: input.threadId,
      worktreePath: input.worktreePath,
      ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
      ...(input.projectCwd === undefined ? {} : { projectCwd: input.projectCwd }),
    };
    const suppliedProject = input.project;
    const projectById =
      suppliedProject ??
      (input.projectId
        ? yield* projects.getById(ProjectId.make(input.projectId)).pipe(
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
    const project =
      suppliedProject ??
      projectById ??
      (input.projectCwd
        ? yield* projects.getByWorkspaceRoot(input.projectCwd).pipe(
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
    const trigger = input.trigger ?? "setup";
    const scripts = resolveProjectScripts(settings, project);
    const script = input.scriptId
      ? scripts.find((candidate) => candidate.id === input.scriptId)
      : trigger === "settle"
        ? settleProjectScript(scripts)
        : setupProjectScript(scripts);
    if (!script || (input.scriptId !== undefined && !projectScriptReservesPort(script))) {
      return {
        status: "no-script",
      } as const;
    }

    const cwd = projectScriptCwd({
      project: { cwd: project.workspaceRoot },
      worktreePath: input.worktreePath,
    });
    const port = projectScriptReservesPort(script)
      ? yield* scriptPorts.reserve({ cwd, scriptId: script.id }).pipe(
          Effect.mapError(
            (cause) =>
              new ProjectSetupScriptOperationError({
                ...errorContext,
                operation: "reservePort",
                cause,
              }),
          ),
        )
      : undefined;
    const launch = Effect.gen(function* () {
      const active = port === undefined ? undefined : activeRuns.get(port);
      if (active) {
        return input.scriptId !== undefined || active.threadId === input.threadId
          ? active
          : ({ status: "no-script" } as const);
      }

      const terminalId =
        port !== undefined
          ? projectScriptTerminalId(port)
          : (input.preferredTerminalId ??
            (trigger === "settle"
              ? `settle-${script.id}-${(yield* crypto.randomUUIDv4().pipe(Effect.orDie)).slice(0, 8)}`
              : `setup-${script.id}`));
      const result = {
        status: "started",
        scriptId: script.id,
        scriptName: script.name,
        scriptCommand: script.command,
        terminalId,
        cwd,
        async: script.async !== false,
      } as const;
      const env = {
        ...projectScriptRuntimeEnv({
          project: { cwd: project.workspaceRoot },
          worktreePath: input.worktreePath,
          ...(port === undefined ? {} : { extraEnv: { T3CODE_PREVIEW_PORT: String(port) } }),
        }),
        // Setup can run before a client attaches. Truecolor probes in tools such
        // as Vite+ wait for terminal replies that nobody can send at that point.
        ...(input.scriptId === undefined ? { COLORTERM: "", NO_COLOR: "1", FORCE_COLOR: "0" } : {}),
      };
      const observe = input.observeCompletion ?? (port === undefined ? undefined : {});
      const completionToken = observe
        ? (yield* crypto.randomUUIDv4().pipe(Effect.orDie)).replaceAll("-", "")
        : null;
      const commandLine =
        observe && completionToken
          ? wrapCommandForCompletion(
              script.command,
              completionShell,
              completionSentinel(completionToken),
            )
          : script.command;

      const opened = yield* terminalManager
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
      const expectedPid = opened.pid;
      if (expectedPid === null || opened.status !== "running") {
        return yield* new ProjectSetupScriptOperationError({
          ...errorContext,
          operation: "openTerminal",
          cause: new TerminalManager.TerminalNotRunningError({
            threadId: input.threadId,
            terminalId,
          }),
        });
      }
      // Once written, a reserved command must retain its owner even if the caller disconnects.
      return yield* Effect.uninterruptible(
        Effect.gen(function* () {
          const observed =
            observe && completionToken
              ? yield* observeTerminalCompletion({
                  threadId: input.threadId,
                  terminalId,
                  sentinel: completionSentinel(completionToken),
                  sentinelPattern: completionSentinelPattern(completionToken),
                  echoedWrapperLines: commandLine.split("\r").filter((line) => line.length > 0),
                  onOutputLine: observe.onOutputLine,
                })
              : undefined;

          yield* terminalManager
            .write({
              threadId: input.threadId,
              terminalId,
              expectedPid,
              data: projectScriptTerminalInput(commandLine),
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
              Effect.onError(() => Effect.sync(() => observed?.unsubscribe())),
            );

          const completion = observed?.completion.pipe(
            Effect.tap(({ exitCode }) =>
              exitCode === 0 && input.observeCompletion !== undefined
                ? terminalManager.closeIdle({ threadId: input.threadId, terminalId })
                : Effect.void,
            ),
          );

          if (port !== undefined && completion) {
            const done = yield* Deferred.make<ProjectSetupScriptCompletion>();
            const started = {
              ...result,
              threadId: input.threadId,
              port,
              completion: Deferred.await(done),
            };
            activeRuns.set(port, started);
            yield* Deferred.complete(
              done,
              completion.pipe(Effect.ensuring(Effect.sync(() => activeRuns.delete(port)))),
            ).pipe(Effect.interruptible, Effect.forkIn(scope, { startImmediately: true }));
            return started;
          }

          return {
            ...result,
            ...(completion ? { completion } : {}),
          } as const;
        }),
      );
    });
    return yield* port === undefined ? launch : launchLocks.withLock(port, launch);
  });

  const runScript: ProjectSetupScriptRunner["Service"]["runScript"] = Effect.fn(
    "ProjectSetupScriptRunner.runScript",
  )(function* (input) {
    const result = yield* runForThread(input);
    return result.status === "started" && result.port !== undefined
      ? {
          status: "started" as const,
          threadId: ThreadId.make(result.threadId ?? input.threadId),
          terminalId: result.terminalId,
          port: result.port,
        }
      : { status: "no-script" as const };
  });

  return ProjectSetupScriptRunner.of({ runForThread, runScript });
});

export const layer = Layer.effect(ProjectSetupScriptRunner, make);
