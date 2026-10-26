import { ProjectId, type ProjectScript } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import {
  projectScriptRuntimeEnv,
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
  /** Null exit code means the terminal exited or closed before the sentinel. */
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
  readonly trigger?: "setup" | "settle";
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
    worktreePath: Schema.String,
    operation: Schema.Literals(["resolveProject", "readSettings", "openTerminal"]),
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

/** @public */
// Random per-run tokens prevent script output from spoofing completion.
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
  return text
    .replace(
      /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][A-Za-z0-9]|\x1b[=>]/g,
      "",
    )
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
}

// Line editors (zsh, fish, bash 5.1+) enable bracketed paste when they start reading a command.
const BRACKETED_PASTE_ON = "\x1b[?2004h";
const BRACKETED_PASTE_OFF = "\x1b[?2004l";
// Longer than one subprocess poll plus its ps timeout, so a startup prompt is seen as busy first.
const SHELL_QUIET_FALLBACK = "3 seconds";

function lineEditorReading(text: string, previous: boolean): boolean {
  const on = text.lastIndexOf(BRACKETED_PASTE_ON);
  const off = text.lastIndexOf(BRACKETED_PASTE_OFF);
  return on === off ? previous : on > off;
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

// A block with its own closing line protects the sentinel from trailing comments, heredocs and scripts reading stdin.
function wrapCommandForCompletion(
  command: string,
  shell: CompletionShell,
  sentinel: string,
): string {
  const body = command.replace(/\r?\n/g, "\r");
  switch (shell) {
    case "powershell":
      return `$global:LASTEXITCODE = $null; & {\r${body}\r}; if ($null -ne $LASTEXITCODE) { $__t3c = $LASTEXITCODE } elseif ($?) { $__t3c = 0 } else { $__t3c = 1 }; Write-Host "${sentinel}$__t3c"`;
    case "fish":
      return `begin\r${body}\rend; printf '\\n${sentinel}%s\\n' $status`;
    case "posix":
      return `( ${body}\r); printf '\\n${sentinel}%s\\n' "$?"`;
  }
}

/** @public */
export const make = Effect.gen(function* () {
  const projects = yield* ProjectService.ProjectService;
  const terminalManager = yield* TerminalManager.TerminalManager;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const crypto = yield* Crypto.Crypto;
  const serviceScope = yield* Effect.scope;
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
      // Wait for the prompt redraw; closing earlier mistakes it for activity and preserves an idle shell.
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
          // Bare CR redraws progress in place; split redraws instead of growing one line.
          const lines = lineBuffer.split(/\r\n|\r|\n/);
          lineBuffer = lines.pop() ?? "";
          // Bound newline-free output; the sentinel has its own line, so retaining the tail is safe.
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
        if (event.type === "exited" || event.type === "closed") {
          return settle(null).pipe(Effect.andThen(Deferred.succeed(promptReturned, undefined)));
        }
        return Effect.void;
      });

      const completion = Deferred.await(done).pipe(
        // A shell with an empty prompt never prints one; do not wait forever.
        Effect.tap(() => Deferred.await(promptReturned).pipe(Effect.timeoutOption("1 second"))),
        Effect.ensuring(Effect.sync(() => unsubscribe())),
      );
      // A startup prompt waits for input on a line that has no newline yet.
      const flushPartialLine = Effect.suspend(() => {
        const partial = lineBuffer;
        lineBuffer = "";
        return handleLine(partial);
      });
      const abandon = settle(null).pipe(
        Effect.andThen(Deferred.succeed(promptReturned, undefined)),
      );
      return { completion, unsubscribe, flushPartialLine, abandon };
    },
  );

  // Input typed during shell startup can be read by an rc-file prompt (fnm, nvm) instead of the
  // shell, which loses the command. Subscribe before the terminal opens so no activity is missed.
  const watchShellReadiness = Effect.fn("ProjectSetupScriptRunner.watchShellReadiness")(
    function* (input: {
      readonly threadId: string;
      readonly terminalId: string;
      readonly onStartupPrompt: Effect.Effect<void>;
    }) {
      const outcome = yield* Deferred.make<"ready" | "exited">();
      let reading = false;
      let carry = "";
      let busy = false;
      let activity = 0;
      const unsubscribe = yield* terminalManager.subscribe((event) => {
        if (event.threadId !== input.threadId || event.terminalId !== input.terminalId) {
          return Effect.void;
        }
        activity += 1;
        // A new shell process starts idle; the manager resets its subprocess state without an event.
        if (event.type === "started" || event.type === "restarted") {
          busy = false;
          reading = false;
          carry = "";
        }
        if (event.type === "activity") busy = event.hasRunningSubprocess;
        if (event.type === "output") {
          const text = carry + event.data;
          carry = text.slice(-(BRACKETED_PASTE_ON.length - 1));
          reading = lineEditorReading(text, reading);
        }
        if (event.type === "exited" || event.type === "closed") {
          return Deferred.succeed(outcome, "exited").pipe(Effect.asVoid);
        }
        return reading ? Deferred.succeed(outcome, "ready").pipe(Effect.asVoid) : Effect.void;
      });
      // A startup prompt runs as a child process, so a busy shell keeps waiting for the user.
      const quiet = Effect.gen(function* () {
        while (true) {
          const seen = activity;
          yield* Effect.sleep(SHELL_QUIET_FALLBACK);
          if (activity !== seen) continue;
          if (!busy) return "ready" as const;
          yield* input.onStartupPrompt;
        }
      });
      // Restored history can hold a previous shell's line editor state, so only live output counts.
      const wait = Deferred.await(outcome).pipe(Effect.raceFirst(quiet));
      return { wait, unsubscribe };
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
    const script =
      trigger === "settle" ? settleProjectScript(scripts) : setupProjectScript(scripts);
    if (!script) {
      return {
        status: "no-script",
      } as const;
    }

    // Earlier settle shells may still run foreground programs; do not type resumed settles into them.
    const terminalId =
      input.preferredTerminalId ??
      (trigger === "settle"
        ? `settle-${script.id}-${(yield* crypto.randomUUIDv4().pipe(Effect.orDie)).slice(0, 8)}`
        : `setup-${script.id}`);
    const cwd = input.worktreePath;
    const env = {
      ...projectScriptRuntimeEnv({
        project: { cwd: project.workspaceRoot },
        worktreePath: input.worktreePath,
      }),
      // Before client attachment, truecolor probes wait for terminal replies nobody can send.
      COLORTERM: "",
    };
    const observe = input.observeCompletion;
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

    // Subscribe before opening so neither startup activity nor the sentinel can race the listeners.
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
    // PowerShell has no line-editor signal; keep its immediate write.
    const readiness =
      completionShell === "powershell"
        ? undefined
        : yield* watchShellReadiness({
            threadId: input.threadId,
            terminalId,
            onStartupPrompt: observed?.flushPartialLine ?? Effect.void,
          });

    yield* terminalManager
      .open({
        threadId: input.threadId,
        terminalId,
        cwd,
        worktreePath: input.worktreePath,
        env: { ...env, NO_COLOR: "1", FORCE_COLOR: "0" },
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
        Effect.onError(() =>
          Effect.sync(() => {
            observed?.unsubscribe();
            readiness?.unsubscribe();
          }),
        ),
      );

    // Return once the terminal exists so callers can show it while a startup prompt waits.
    yield* (readiness?.wait ?? Effect.succeed("ready" as const)).pipe(
      Effect.flatMap((shell) =>
        shell === "exited"
          ? Effect.void
          : terminalManager.write({
              threadId: input.threadId,
              terminalId,
              data: projectScriptTerminalInput(commandLine),
            }),
      ),
      Effect.catchCause((cause) =>
        Effect.logWarning("project script command was not written", {
          ...errorContext,
          terminalId,
          cause,
        }).pipe(Effect.andThen(observed?.abandon ?? Effect.void)),
      ),
      Effect.ensuring(Effect.sync(() => readiness?.unsubscribe())),
      Effect.forkIn(serviceScope),
    );

    const completion = observed?.completion.pipe(
      Effect.tap(({ exitCode }) =>
        exitCode === 0
          ? terminalManager.closeIdle({ threadId: input.threadId, terminalId })
          : Effect.void,
      ),
    );

    return {
      status: "started",
      scriptId: script.id,
      scriptName: script.name,
      scriptCommand: script.command,
      terminalId,
      cwd,
      async: script.async !== false,
      ...(completion ? { completion } : {}),
    } as const;
  });

  return ProjectSetupScriptRunner.of({ runForThread });
});

export const layer = Layer.effect(ProjectSetupScriptRunner, make);
