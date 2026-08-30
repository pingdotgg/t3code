import {
  TERMINAL_MCP_DEFAULT_LIST_LIMIT,
  TERMINAL_MCP_DEFAULT_OUTPUT_CHARS,
  type OrchestrationV2ThreadProjection,
  type Project,
  type TerminalMcpAcceptedInputResult,
  type TerminalMcpClearInput,
  type TerminalMcpCloseInput,
  type TerminalMcpCloseResult,
  TerminalMcpFailure,
  type TerminalMcpListInput,
  type TerminalMcpListResult,
  type TerminalMcpOpenInput,
  type TerminalMcpOpenResult,
  type TerminalMcpReadInput,
  type TerminalMcpReadResult,
  type TerminalMcpResizeInput,
  type TerminalMcpRestartInput,
  type TerminalMcpSession,
  type TerminalMcpStateResult,
  type TerminalMcpWriteInput,
  TerminalNotRunningError,
  TerminalSessionAlreadyExistsError,
  TerminalSessionLookupError,
  type TerminalSessionSnapshot,
  type ThreadId,
} from "@t3tools/contracts";
import { projectScriptRuntimeEnv } from "@t3tools/shared/projectScripts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type { KeyedSerialExecutor } from "../orchestration-v2/KeyedSerialExecutor.ts";
import { ThreadCommandExecutor } from "../orchestration-v2/ThreadCommandExecutor.ts";
import { ProjectionStoreThreadNotFoundError } from "../orchestration-v2/ProjectionStore.ts";
import {
  ThreadManagementService,
  ThreadManagementProjectionLoadError,
  ThreadManagementThreadNotFoundError,
} from "../orchestration-v2/ThreadManagementService.ts";
import { OrchestratorProjectionError } from "../orchestration-v2/Orchestrator.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as TerminalManager from "../terminal/Manager.ts";
import type { McpInvocationScope } from "./McpInvocationContext.ts";

const DEFAULT_COLS = 120;
const DEFAULT_ROWS = 30;

interface ScopedTerminalTarget {
  readonly caller: AwaitedProjection;
  readonly target: AwaitedProjection;
  readonly project: Project;
  readonly cwd: string;
  readonly worktreePath: string | null;
  readonly env: Record<string, string>;
}

export interface TerminalMcpOwnedSession {
  readonly terminal: TerminalMcpSession;
  readonly handle: TerminalManager.TerminalSessionHandle;
}

type AwaitedProjection = OrchestrationV2ThreadProjection;

function executionCwd(projection: OrchestrationV2ThreadProjection, project: Project): string {
  const activeProviderThread = projection.providerThreads.find(
    (candidate) => candidate.id === projection.thread.activeProviderThreadId,
  );
  const activeProviderSession = projection.providerSessions.find(
    (candidate) =>
      candidate.id === activeProviderThread?.providerSessionId &&
      candidate.status !== "stopped" &&
      candidate.status !== "error",
  );
  return activeProviderSession?.cwd ?? projection.thread.worktreePath ?? project.workspaceRoot;
}

export class TerminalMcpService extends Context.Service<
  TerminalMcpService,
  {
    readonly resolveTarget: (
      scope: McpInvocationScope,
      threadId?: ThreadId,
    ) => Effect.Effect<ScopedTerminalTarget, TerminalMcpFailure>;
    readonly list: (
      scope: McpInvocationScope,
      input: TerminalMcpListInput,
    ) => Effect.Effect<TerminalMcpListResult, TerminalMcpFailure>;
    readonly read: (
      scope: McpInvocationScope,
      input: TerminalMcpReadInput,
    ) => Effect.Effect<TerminalMcpReadResult, TerminalMcpFailure>;
    readonly open: (
      scope: McpInvocationScope,
      input: TerminalMcpOpenInput,
    ) => Effect.Effect<TerminalMcpOpenResult, TerminalMcpFailure>;
    readonly openFresh: (
      scope: McpInvocationScope,
      input: TerminalMcpOpenInput,
    ) => Effect.Effect<TerminalMcpSession, TerminalMcpFailure>;
    readonly openFreshOwned: (
      scope: McpInvocationScope,
      input: TerminalMcpOpenInput,
    ) => Effect.Effect<TerminalMcpOwnedSession, TerminalMcpFailure>;
    readonly write: (
      scope: McpInvocationScope,
      input: TerminalMcpWriteInput,
    ) => Effect.Effect<TerminalMcpAcceptedInputResult, TerminalMcpFailure>;
    readonly writeOwned: (
      scope: McpInvocationScope,
      input: TerminalMcpWriteInput & { readonly handle: TerminalManager.TerminalSessionHandle },
    ) => Effect.Effect<TerminalMcpAcceptedInputResult, TerminalMcpFailure>;
    readonly resize: (
      scope: McpInvocationScope,
      input: TerminalMcpResizeInput,
    ) => Effect.Effect<TerminalMcpStateResult, TerminalMcpFailure>;
    readonly clear: (
      scope: McpInvocationScope,
      input: TerminalMcpClearInput,
    ) => Effect.Effect<TerminalMcpStateResult, TerminalMcpFailure>;
    readonly restart: (
      scope: McpInvocationScope,
      input: TerminalMcpRestartInput,
    ) => Effect.Effect<TerminalMcpStateResult, TerminalMcpFailure>;
    readonly close: (
      scope: McpInvocationScope,
      input: TerminalMcpCloseInput,
    ) => Effect.Effect<TerminalMcpCloseResult, TerminalMcpFailure>;
    readonly closeOwned: (
      scope: McpInvocationScope,
      input: TerminalMcpCloseInput & { readonly handle: TerminalManager.TerminalSessionHandle },
    ) => Effect.Effect<boolean, TerminalMcpFailure>;
  }
>()("t3/mcp/TerminalMcpService") {}

const isTerminalSessionLookupError = Schema.is(TerminalSessionLookupError);
const isTerminalNotRunningError = Schema.is(TerminalNotRunningError);
const isTerminalSessionAlreadyExistsError = Schema.is(TerminalSessionAlreadyExistsError);
const isThreadManagementThreadNotFoundError = Schema.is(ThreadManagementThreadNotFoundError);
const isThreadManagementProjectionLoadError = Schema.is(ThreadManagementProjectionLoadError);
const isOrchestratorProjectionError = Schema.is(OrchestratorProjectionError);
const isProjectionStoreThreadNotFoundError = Schema.is(ProjectionStoreThreadNotFoundError);

function failure(code: TerminalMcpFailure["code"], message: string): TerminalMcpFailure {
  return new TerminalMcpFailure({ code, message });
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "object" && error !== null && "message" in error) {
    return String((error as { message: unknown }).message);
  }
  return String(error);
}

function terminalFailure(error: unknown): TerminalMcpFailure {
  if (isTerminalSessionLookupError(error)) {
    return failure("terminal_not_found", error.message);
  }
  if (isTerminalNotRunningError(error)) {
    return failure("terminal_not_running", error.message);
  }
  if (isTerminalSessionAlreadyExistsError(error)) {
    return failure("terminal_already_exists", error.message);
  }
  return failure("operation_failed", errorMessage(error));
}

function isThreadNotFound(error: unknown): boolean {
  if (isThreadManagementThreadNotFoundError(error)) return true;
  return (
    isThreadManagementProjectionLoadError(error) &&
    isOrchestratorProjectionError(error.cause) &&
    isProjectionStoreThreadNotFoundError(error.cause.cause)
  );
}

function outputWindow(history: string, maxChars: number) {
  let startOffset = Math.max(0, history.length - maxChars);
  if (
    startOffset > 0 &&
    startOffset < history.length &&
    history.charCodeAt(startOffset) >= 0xdc00 &&
    history.charCodeAt(startOffset) <= 0xdfff
  ) {
    startOffset += 1;
  }
  return {
    text: history.slice(startOffset),
    retainedChars: history.length,
    startOffset,
    endOffset: history.length,
    truncated: startOffset > 0,
  } as const;
}

function sessionResult(
  snapshot: TerminalSessionSnapshot & { readonly hasRunningSubprocess: boolean },
  maxChars = TERMINAL_MCP_DEFAULT_OUTPUT_CHARS,
): TerminalMcpSession {
  return {
    threadId: snapshot.threadId as ThreadId,
    terminalId: snapshot.terminalId,
    cwd: snapshot.cwd,
    worktreePath: snapshot.worktreePath,
    status: snapshot.status,
    pid: snapshot.pid,
    exitCode: snapshot.exitCode,
    exitSignal: snapshot.exitSignal,
    hasRunningSubprocess: snapshot.hasRunningSubprocess,
    label: snapshot.label,
    updatedAt: snapshot.updatedAt,
    sequence: snapshot.sequence ?? 0,
    output: outputWindow(snapshot.history, maxChars),
  };
}

export const make = Effect.gen(function* () {
  const threads = yield* ThreadManagementService;
  const threadDispatch = yield* ThreadCommandExecutor;
  const projects = yield* ProjectService.ProjectService;
  const terminals = yield* TerminalManager.TerminalManager;

  const requireCapability = (scope: McpInvocationScope) =>
    scope.capabilities.has("orchestration")
      ? Effect.void
      : Effect.fail(
          failure(
            "capability_denied",
            "This MCP credential does not grant orchestration capabilities.",
          ),
        );

  const loadCaller = (scope: McpInvocationScope) =>
    threads.getThreadProjection(scope.threadId).pipe(
      Effect.mapError((error) =>
        error._tag === "OrchestratorProjectionError" &&
        isProjectionStoreThreadNotFoundError(error.cause)
          ? failure("thread_not_found", `Thread '${scope.threadId}' was not found.`)
          : failure("operation_failed", errorMessage(error)),
      ),
      Effect.filterOrFail(
        (projection) => projection.thread.deletedAt === null,
        () => failure("thread_not_found", `Thread '${scope.threadId}' was not found.`),
      ),
    );

  const resolveTarget: TerminalMcpService["Service"]["resolveTarget"] = Effect.fn(
    "TerminalMcpService.resolveTarget",
  )(function* (scope, requestedThreadId) {
    yield* requireCapability(scope);
    const caller = yield* loadCaller(scope);
    const targetThreadId = requestedThreadId ?? scope.threadId;
    const target =
      targetThreadId === scope.threadId
        ? caller
        : yield* threads
            .getProjectThread({ projectId: caller.thread.projectId, threadId: targetThreadId })
            .pipe(
              Effect.mapError((error) =>
                isThreadNotFound(error)
                  ? failure("thread_not_found", error.message)
                  : failure("operation_failed", errorMessage(error)),
              ),
            );
    const projectOption = yield* projects
      .getById(target.thread.projectId)
      .pipe(Effect.mapError((error) => failure("operation_failed", errorMessage(error))));
    const project = yield* Option.match(projectOption, {
      onNone: () =>
        Effect.fail(
          failure(
            "project_not_found",
            `Project '${target.thread.projectId}' was not found for thread '${target.thread.id}'.`,
          ),
        ),
      onSome: Effect.succeed,
    });
    const worktreePath = target.thread.worktreePath;
    const cwd = executionCwd(target, project);
    return {
      caller,
      target,
      project,
      cwd,
      worktreePath,
      env: projectScriptRuntimeEnv({
        project: { cwd: project.workspaceRoot },
        worktreePath,
      }),
    };
  });

  const requireExecutionPolicy = (resolved: ScopedTerminalTarget) => {
    const callerAllowed =
      resolved.caller.thread.runtimeMode === "full-access" &&
      resolved.caller.thread.interactionMode === "default";
    const targetAllowed =
      resolved.target.thread.runtimeMode === "full-access" &&
      resolved.target.thread.interactionMode === "default";
    return callerAllowed && targetAllowed
      ? Effect.void
      : Effect.fail(
          failure(
            "execution_policy_denied",
            "Terminal mutations require both the calling thread and target thread to use full-access runtime mode and default interaction mode.",
          ),
        );
  };

  const compareThreadIds = (left: ThreadId, right: ThreadId) =>
    left === right ? 0 : left < right ? -1 : 1;

  const withThreadLocks = <A, E, R>(
    executor: KeyedSerialExecutor<ThreadId>,
    threadIds: ReadonlyArray<ThreadId>,
    effect: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E, R> =>
    [...new Set(threadIds)]
      .sort(compareThreadIds)
      .reduceRight((locked, threadId) => executor.withLock(threadId, locked), effect);

  const withMutationTarget = <A, E, R>(
    scope: McpInvocationScope,
    threadId: ThreadId | undefined,
    use: (resolved: ScopedTerminalTarget) => Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E | TerminalMcpFailure, R> => {
    const targetThreadId = threadId ?? scope.threadId;
    return requireCapability(scope).pipe(
      Effect.andThen(
        withThreadLocks(
          threadDispatch,
          [scope.threadId, targetThreadId],
          Effect.gen(function* () {
            const resolved = yield* resolveTarget(scope, targetThreadId);
            yield* requireExecutionPolicy(resolved);
            return yield* use(resolved);
          }),
        ),
      ),
    );
  };

  const readLoaded = Effect.fn("TerminalMcpService.readLoaded")(function* (
    threadId: ThreadId,
    terminalId: string,
    maxChars = TERMINAL_MCP_DEFAULT_OUTPUT_CHARS,
  ) {
    const snapshot = yield* terminals.inspectSession({ threadId, terminalId });
    if (snapshot === null) {
      return yield* failure(
        "terminal_not_found",
        `Terminal '${terminalId}' is not loaded for thread '${threadId}'. Persisted or evicted history is not loaded by MCP reads.`,
      );
    }
    return sessionResult(snapshot, maxChars);
  });

  const openInput = (resolved: ScopedTerminalTarget, input: TerminalMcpOpenInput) => ({
    threadId: resolved.target.thread.id,
    terminalId: input.terminalId,
    cwd: resolved.cwd,
    worktreePath: resolved.worktreePath,
    env: resolved.env,
    cols: input.cols ?? DEFAULT_COLS,
    rows: input.rows ?? DEFAULT_ROWS,
  });

  const restartInput = (resolved: ScopedTerminalTarget, input: TerminalMcpRestartInput) => ({
    threadId: resolved.target.thread.id,
    terminalId: input.terminalId,
    cwd: resolved.cwd,
    worktreePath: resolved.worktreePath,
    env: resolved.env,
    ...(input.cols !== undefined ? { cols: input.cols } : {}),
    ...(input.rows !== undefined ? { rows: input.rows } : {}),
  });

  const requireRunning = (snapshot: TerminalSessionSnapshot) =>
    snapshot.status === "running"
      ? Effect.succeed(snapshot)
      : Effect.fail(
          failure(
            "operation_failed",
            `Terminal '${snapshot.terminalId}' failed to start and is in '${snapshot.status}' state.`,
          ),
        );

  return TerminalMcpService.of({
    resolveTarget,
    list: (scope, input) =>
      Effect.gen(function* () {
        const resolved = yield* resolveTarget(scope, input.threadId);
        const all = yield* terminals.inspectThread(resolved.target.thread.id);
        const cursor = input.cursor ?? 0;
        const limit = input.limit ?? TERMINAL_MCP_DEFAULT_LIST_LIMIT;
        const page = all.slice(cursor, cursor + limit);
        return {
          threadId: resolved.target.thread.id,
          terminals: page.map(({ threadId: _, ...terminal }) => terminal),
          nextCursor: cursor + page.length < all.length ? cursor + page.length : null,
          total: all.length,
          historyAvailability: "loaded_sessions_only",
        };
      }),
    read: (scope, input) =>
      Effect.gen(function* () {
        const resolved = yield* resolveTarget(scope, input.threadId);
        return yield* readLoaded(
          resolved.target.thread.id,
          input.terminalId,
          input.maxChars ?? TERMINAL_MCP_DEFAULT_OUTPUT_CHARS,
        );
      }),
    open: (scope, input) =>
      withMutationTarget(scope, input.threadId, (resolved) =>
        Effect.gen(function* () {
          const opened = yield* terminals
            .openOrInspect(openInput(resolved, input))
            .pipe(Effect.mapError(terminalFailure));
          if (opened.created) yield* requireRunning(opened.snapshot);
          if (!opened.created && opened.snapshot.status !== "running") {
            return yield* failure(
              "terminal_not_running",
              `Terminal '${input.terminalId}' already exists with status '${opened.snapshot.status}'. Use restart explicitly.`,
            );
          }
          return {
            outcome: opened.created ? "opened" : "already_running",
            terminal: sessionResult(opened.snapshot),
          };
        }),
      ),
    openFresh: (scope, input) =>
      withMutationTarget(scope, input.threadId, (resolved) =>
        Effect.gen(function* () {
          const opened = yield* terminals
            .openFresh(openInput(resolved, input))
            .pipe(Effect.mapError(terminalFailure));
          yield* requireRunning(opened);
          return sessionResult({ ...opened, hasRunningSubprocess: false });
        }),
      ),
    openFreshOwned: (scope, input) =>
      withMutationTarget(scope, input.threadId, (resolved) =>
        Effect.gen(function* () {
          const opened = yield* terminals
            .openFreshWithHandle(openInput(resolved, input))
            .pipe(Effect.mapError(terminalFailure));
          yield* requireRunning(opened.snapshot);
          return {
            terminal: sessionResult({ ...opened.snapshot, hasRunningSubprocess: false }),
            handle: opened.handle,
          };
        }),
      ),
    write: (scope, input) =>
      withMutationTarget(scope, input.threadId, (resolved) =>
        Effect.gen(function* () {
          const before = yield* readLoaded(resolved.target.thread.id, input.terminalId);
          if (before.status !== "running") {
            return yield* failure(
              "terminal_not_running",
              `Terminal '${input.terminalId}' is not running.`,
            );
          }
          yield* terminals
            .writeStrict({
              threadId: resolved.target.thread.id,
              terminalId: input.terminalId,
              data: input.data,
            })
            .pipe(Effect.mapError(terminalFailure));
          return {
            threadId: resolved.target.thread.id,
            terminalId: input.terminalId,
            accepted: true,
            statusAtAcceptance: "running",
            lastObservedSequence: before.sequence,
          };
        }),
      ),
    writeOwned: (scope, input) =>
      withMutationTarget(scope, input.threadId, (resolved) =>
        Effect.gen(function* () {
          const before = yield* readLoaded(resolved.target.thread.id, input.terminalId);
          const accepted = yield* terminals
            .writeWithHandle({
              threadId: resolved.target.thread.id,
              terminalId: input.terminalId,
              data: input.data,
              handle: input.handle,
            })
            .pipe(Effect.mapError(terminalFailure));
          if (!accepted) {
            return yield* failure(
              "terminal_not_found",
              `Terminal '${input.terminalId}' no longer names the opened managed session.`,
            );
          }
          return {
            threadId: resolved.target.thread.id,
            terminalId: input.terminalId,
            accepted: true,
            statusAtAcceptance: "running",
            lastObservedSequence: before.sequence,
          };
        }),
      ),
    resize: (scope, input) =>
      withMutationTarget(scope, input.threadId, (resolved) =>
        Effect.gen(function* () {
          const resized = yield* terminals
            .resizeAndInspect({
              threadId: resolved.target.thread.id,
              terminalId: input.terminalId,
              cols: input.cols,
              rows: input.rows,
            })
            .pipe(Effect.mapError(terminalFailure));
          return { terminal: sessionResult(resized) };
        }),
      ),
    clear: (scope, input) =>
      withMutationTarget(scope, input.threadId, (resolved) =>
        Effect.gen(function* () {
          const cleared = yield* terminals
            .clearAndInspect({ threadId: resolved.target.thread.id, terminalId: input.terminalId })
            .pipe(Effect.mapError(terminalFailure));
          return { terminal: sessionResult(cleared) };
        }),
      ),
    restart: (scope, input) =>
      withMutationTarget(scope, input.threadId, (resolved) =>
        Effect.gen(function* () {
          const restarted = yield* terminals
            .restartExisting(restartInput(resolved, input))
            .pipe(Effect.mapError(terminalFailure));
          yield* requireRunning(restarted);
          return {
            terminal: sessionResult({ ...restarted, hasRunningSubprocess: false }),
          };
        }),
      ),
    close: (scope, input) =>
      withMutationTarget(scope, input.threadId, (resolved) =>
        Effect.gen(function* () {
          yield* readLoaded(resolved.target.thread.id, input.terminalId);
          yield* terminals
            .close({
              threadId: resolved.target.thread.id,
              terminalId: input.terminalId,
              deleteHistory: false,
            })
            .pipe(Effect.mapError(terminalFailure));
          return {
            threadId: resolved.target.thread.id,
            terminalId: input.terminalId,
            closed: true,
          };
        }),
      ),
    closeOwned: (scope, input) =>
      withMutationTarget(scope, input.threadId, (resolved) =>
        terminals
          .closeWithHandle({
            threadId: resolved.target.thread.id,
            terminalId: input.terminalId,
            handle: input.handle,
            deleteHistory: false,
          })
          .pipe(Effect.mapError(terminalFailure)),
      ),
  });
});

export const layer = Layer.effect(TerminalMcpService, make);
