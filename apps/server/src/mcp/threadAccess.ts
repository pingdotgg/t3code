import type { ProjectionRecordField } from "../orchestration-v2/ProjectionStore.ts";
import {
  CommandId,
  OrchestratorMcpFailure,
  type OrchestrationV2ThreadProjection,
  type ProjectId,
  type ProviderInstanceId,
  type ProviderInteractionMode,
  type RuntimeMode,
  ThreadId,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as ProviderContinuationRequests from "@t3tools/provider-core/server/ProviderContinuationRequests";

import type { OrchestratorV2Error } from "../orchestration-v2/Orchestrator.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import { resolveInteractionMode, resolveRuntimeMode } from "./delegatedTaskModes.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";

/**
 * Threads an agent starts over MCP are `mcp:<uuid>`, and agents often paste the
 * bare uuid. The id is never rewritten, so permission checks keyed on it still
 * hold; the miss only names a live thread the caller could read by its full id.
 */
export const threadNotFound = Effect.fn("OrchestratorMcpService.threadNotFound")(function* (
  threads: Pick<ThreadManagement.ThreadManagementService["Service"], "getThreadShell">,
  threadId: ThreadId,
  message: string,
) {
  const prefixed = ThreadId.make(`mcp:${threadId}`);
  const shell = yield* threads.getThreadShell(prefixed).pipe(Effect.orElseSucceed(() => null));
  return yield* new OrchestratorMcpFailure({
    code: "thread_not_found",
    message:
      shell === null || shell.deletedAt !== null
        ? message
        : `${message} Did you mean \`${prefixed}\`?`,
  });
});

export const unavailable = () =>
  new OrchestratorMcpFailure({
    code: "orchestration_error",
    message: "The operation could not be completed.",
  });

export const dispatchFailure = (
  error: OrchestratorV2Error | ThreadManagement.ThreadManagementProviderInstanceDisabledError,
) =>
  error._tag === "ThreadManagementProviderInstanceDisabledError" ||
  error._tag === "OrchestratorRuntimeModeAboveCeilingError"
    ? new OrchestratorMcpFailure({ code: "invalid_request", message: error.message })
    : (error._tag === "OrchestratorDispatchError" ||
          error._tag === "OrchestratorCommandRejectedError") &&
        typeof error.cause === "string" &&
        error.cause.length > 0
      ? new OrchestratorMcpFailure({
          code: "orchestration_error",
          message: Array.from(error.cause).slice(0, 1000).join(""),
        })
      : unavailable();

export interface CallerLimits {
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
}

export interface Caller {
  readonly scope: McpInvocationContext.McpInvocationScope;
  readonly threads: ThreadManagement.ThreadManagementService["Service"];
  readonly caller: OrchestrationV2ThreadShell | undefined;
  readonly limits: CallerLimits;
}

export const readCaller = Effect.fn("mcp.readCaller")(function* () {
  const scope = yield* McpInvocationContext.McpInvocationContext;
  if (!scope.capabilities.has("orchestration")) {
    return yield* new OrchestratorMcpFailure({
      code: "capability_denied",
      message: "This credential cannot control threads.",
    });
  }
  return yield* loadCaller();
});

export const loadCaller = Effect.fn("mcp.loadCaller")(function* () {
  const scope = yield* McpInvocationContext.McpInvocationContext;
  const threads = yield* ThreadManagement.ThreadManagementService;
  if (scope.thread === undefined) {
    return {
      scope,
      threads,
      caller: undefined,
      limits: McpInvocationContext.clientModeCeiling(scope.client),
    } satisfies Caller;
  }
  const caller = yield* threads
    .getThreadShell(scope.thread.threadId)
    .pipe(Effect.mapError(unavailable));
  if (caller === null || caller.deletedAt !== null) {
    return yield* new OrchestratorMcpFailure({
      code: "thread_not_found",
      message: "The calling thread was not found.",
    });
  }
  return {
    scope,
    threads,
    caller,
    limits: { runtimeMode: caller.runtimeMode, interactionMode: caller.interactionMode },
  } satisfies Caller;
});

export const assertTargetWithinLimits = (
  limits: CallerLimits,
  target: { readonly runtimeMode: RuntimeMode; readonly interactionMode: ProviderInteractionMode },
) =>
  resolveRuntimeMode(limits.runtimeMode, target.runtimeMode).pipe(
    Effect.andThen(resolveInteractionMode(limits.interactionMode, target.interactionMode)),
    Effect.asVoid,
  );

/** Background subagents retain credentials until provider exit; archived threads and other instances cannot act. */
export const isLiveCallerShell = (
  shell: Pick<
    OrchestrationV2ThreadShell,
    "archivedAt" | "activeRunId" | "providerInstanceId" | "pendingBackgroundTasks"
  > | null,
  providerInstanceId: ProviderInstanceId | undefined,
) =>
  shell !== null &&
  shell.archivedAt === null &&
  shell.providerInstanceId === providerInstanceId &&
  (shell.activeRunId !== null ||
    (shell.pendingBackgroundTasks?.some(
      (task) => task.kind === "subagent" && task.providerInstanceId === providerInstanceId,
    ) ??
      false));

const isOrchestratorMcpFailure = Schema.is(OrchestratorMcpFailure);

/** True when a continuation for the thread was pending and has since dispatched or failed. */
const awaitProviderContinuation = (threadId: ThreadId): Effect.Effect<boolean> =>
  ProviderContinuationRequests.ProviderContinuationRequests.pipe(
    Effect.flatMap((continuations) => continuations.awaitSettled(threadId)),
    Effect.timeoutOption("60 seconds"),
    Effect.map(Option.getOrElse(() => false)),
  );

/**
 * A provider-started wake turn calls tools before its continuation dispatch commits the run.
 * When `self` fails with parent_not_active while one is pending, wait for it once and run `recheck`.
 */
export const recheckAfterProviderContinuation =
  <A2, E2, R2>(threadId: ThreadId, recheck: Effect.Effect<A2, E2, R2>) =>
  <A, E, R>(self: Effect.Effect<A, E, R>) =>
    self.pipe(
      Effect.catchIf(
        (error): error is E & OrchestratorMcpFailure =>
          isOrchestratorMcpFailure(error) && error.code === "parent_not_active",
        (notActive) =>
          Effect.gen(function* () {
            if (!(yield* awaitProviderContinuation(threadId))) return yield* notActive;
            return yield* recheck;
          }),
      ),
    );

/** The caller's latest active run with its root node, rereading once if a wake turn's run is pending. */
export const requireOwnedRun = <E, R>(
  scope: McpInvocationContext.McpThreadInvocationScope,
  parent: Pick<OrchestrationV2ThreadProjection, "runs">,
  rereadRuns: Effect.Effect<Pick<OrchestrationV2ThreadProjection, "runs">, E, R>,
  message: string,
) => {
  const owned = (projection: Pick<OrchestrationV2ThreadProjection, "runs">) => {
    const run = ThreadManagement.latestActiveRun(projection);
    return run === undefined ||
      run.rootNodeId === null ||
      run.providerInstanceId !== scope.thread.providerInstanceId
      ? Effect.fail(new OrchestratorMcpFailure({ code: "parent_not_active", message }))
      : Effect.succeed({ ...run, rootNodeId: run.rootNodeId });
  };
  return owned(parent).pipe(
    recheckAfterProviderContinuation(scope.thread.threadId, rereadRuns.pipe(Effect.flatMap(owned))),
  );
};

/** Thread callers need a live run or its background subagent in an unarchived thread. OAuth clients rely on their session and ceiling. */
export function assertLiveCaller({ caller, scope, threads }: Caller) {
  if (caller === undefined) return Effect.void;
  const check = (shell: OrchestrationV2ThreadShell | null) =>
    isLiveCallerShell(shell, scope.thread?.providerInstanceId)
      ? Effect.void
      : Effect.fail(
          new OrchestratorMcpFailure({
            code: "parent_not_active",
            message: "The calling provider no longer owns an active thread run.",
          }),
        );
  return check(caller).pipe(
    recheckAfterProviderContinuation(
      caller.id,
      threads.getThreadShell(caller.id).pipe(Effect.mapError(unavailable), Effect.flatMap(check)),
    ),
  );
}

export const assertFullAccess = (context: Caller, message: string) =>
  context.limits.runtimeMode === "full-access" && context.limits.interactionMode === "default"
    ? Effect.void
    : Effect.fail(new OrchestratorMcpFailure({ code: "capability_denied", message }));

export const resolveProjectId = (context: Caller, projectId: ProjectId | undefined) =>
  projectId !== undefined
    ? Effect.succeed(projectId)
    : context.caller !== undefined
      ? Effect.succeed(context.caller.projectId)
      : Effect.fail(
          new OrchestratorMcpFailure({
            code: "target_required",
            message: "Pass projectId: this MCP client is not running inside a T3 thread.",
          }),
        );

const resolveThreadId = (context: Caller, threadId: ThreadId | undefined) =>
  threadId !== undefined
    ? Effect.succeed(threadId)
    : context.caller !== undefined
      ? Effect.succeed(context.caller.id)
      : Effect.fail(
          new OrchestratorMcpFailure({
            code: "target_required",
            message: "Pass threadId: this MCP client is not running inside a T3 thread.",
          }),
        );

export const readThread = Effect.fn("mcp.readThread")(function* <
  K extends ProjectionRecordField = never,
>(threadId?: ThreadId, fields: ReadonlyArray<K> = []) {
  const context = yield* readCaller();
  const targetId = yield* resolveThreadId(context, threadId);
  const shell = yield* context.threads.getThreadShell(targetId).pipe(Effect.mapError(unavailable));
  if (shell === null || shell.deletedAt !== null) {
    return yield* threadNotFound(context.threads, targetId, "The thread was not found.");
  }
  const projection = yield* context.threads
    .getProjectThreadRecords({ projectId: shell.projectId, threadId: targetId }, fields, {
      turnItemTypes: ["user_input_request"],
    })
    .pipe(
      Effect.mapError((error) =>
        error._tag === "ThreadManagementThreadNotFoundError"
          ? new OrchestratorMcpFailure({
              code: "thread_not_found",
              message: "The thread was not found.",
            })
          : unavailable(),
      ),
    );
  return { ...context, projection };
});

export const newCommandId = Effect.fn("mcp.newCommandId")(function* () {
  const random = yield* SecureRandom.SecureRandom;
  return CommandId.make(`mcp:${yield* random.uuidV4()}`);
});
