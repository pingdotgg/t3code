import type { ProjectionRecordField } from "../orchestration-v2/ProjectionStore.ts";
import {
  CommandId,
  OrchestratorMcpFailure,
  type ProjectId,
  type ProviderInstanceId,
  type ProviderInteractionMode,
  type RuntimeMode,
  ThreadId,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";

import type { OrchestratorV2Error } from "../orchestration-v2/Orchestrator.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import { interactionModeRank, runtimeModeRank } from "./delegatedTaskModes.ts";
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

/**
 * A thread write is not delegated work: it has no parent, and its reader is an
 * agent that cannot narrow anything. A refusal therefore names the thread, both
 * modes, and the two ways out, so it is not retried unchanged. Child and
 * interaction wording stays in `delegatedTaskModes` for the calls that start work.
 */
export const assertTargetWithinLimits = (
  limits: CallerLimits,
  target: {
    readonly id: ThreadId;
    readonly runtimeMode: RuntimeMode;
    readonly interactionMode: ProviderInteractionMode;
  },
): Effect.Effect<void, OrchestratorMcpFailure> => {
  // The codes are shared with peer forwarding (RemoteDelegation.isModeRefusal),
  // so only the message is thread-specific.
  const runtimeAbove = runtimeModeRank(target.runtimeMode) > runtimeModeRank(limits.runtimeMode);
  const interactionAbove =
    interactionModeRank(target.interactionMode) > interactionModeRank(limits.interactionMode);
  if (!runtimeAbove && !interactionAbove) return Effect.void;
  return Effect.fail(
    new OrchestratorMcpFailure({
      code: runtimeAbove ? "runtime_mode_escalation_denied" : "interaction_mode_escalation_denied",
      message: `Thread ${target.id} runs in ${target.runtimeMode}/${target.interactionMode}, above the modes this agent may write at (${limits.runtimeMode}/${limits.interactionMode}). A tool that changes another thread may not target one broader than its own. Ask the user to lower that thread's permission mode, or use delegate_task, which starts its own thread at the caller's modes.`,
    }),
  );
};

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

/** Thread callers need a live run or its background subagent in an unarchived thread. OAuth clients rely on their session and ceiling. */
export function assertLiveCaller({ caller, scope }: Caller) {
  if (caller === undefined) return Effect.void;
  return isLiveCallerShell(caller, scope.thread?.providerInstanceId)
    ? Effect.void
    : Effect.fail(
        new OrchestratorMcpFailure({
          code: "parent_not_active",
          message: "The calling provider no longer owns an active thread run.",
        }),
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
