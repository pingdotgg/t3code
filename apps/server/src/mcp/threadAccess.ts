import type { ProjectionRecordField } from "../orchestration-v2/ProjectionStore.ts";
import {
  CommandId,
  OrchestratorMcpFailure,
  type ProjectId,
  type ProviderInteractionMode,
  type RuntimeMode,
  type ThreadId,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";

import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as OrchestrationMcp from "./OrchestratorMcpService.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";

export const unavailable = () =>
  new OrchestratorMcpFailure({
    code: "orchestration_error",
    message: "The operation could not be completed.",
  });

/**
 * The most a caller may hand to the threads it targets. A thread caller is
 * capped by its own thread's modes; an OAuth client by the ceiling chosen
 * when it was approved.
 */
export interface CallerLimits {
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
}

export interface Caller {
  readonly scope: McpInvocationContext.McpInvocationScope;
  readonly threads: ThreadManagement.ThreadManagementService["Service"];
  /** The calling thread, absent for a client signed in from outside T3. */
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
  const threads = yield* ThreadManagement.ThreadManagementService;
  if (scope.thread === undefined) {
    return {
      scope,
      threads,
      caller: undefined,
      limits: {
        runtimeMode: scope.client?.runtimeModeCeiling ?? "approval-required",
        interactionMode: "default",
      },
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
 * A caller may change another thread only if that thread runs within the
 * caller's own modes. Its own thread is always within them.
 */
export const assertTargetWithinLimits = (
  limits: CallerLimits,
  target: { readonly runtimeMode: RuntimeMode; readonly interactionMode: ProviderInteractionMode },
) =>
  OrchestrationMcp.resolveRuntimeMode(limits.runtimeMode, target.runtimeMode).pipe(
    Effect.andThen(
      OrchestrationMcp.resolveInteractionMode(limits.interactionMode, target.interactionMode),
    ),
    Effect.asVoid,
  );

function assertLiveCaller({ caller, scope }: Caller) {
  if (caller === undefined) return Effect.void;
  return caller.archivedAt !== null ||
    caller.activeRunId === null ||
    caller.providerInstanceId !== scope.thread?.providerInstanceId
    ? Effect.fail(
        new OrchestratorMcpFailure({
          code: "parent_not_active",
          message: "The calling provider no longer owns an active thread run.",
        }),
      )
    : Effect.void;
}

/**
 * Mutations from a thread need that thread's live run, so an agent whose turn
 * ended cannot keep acting. An OAuth client has no run; its session and
 * ceiling are its authority.
 */
export const readMutationCaller = Effect.fn("mcp.readMutationCaller")(function* () {
  const context = yield* readCaller();
  yield* assertLiveCaller(context);
  return context;
});

/**
 * Actions that change the environment itself (projects, preferences, launching
 * outside a project) need full access: a thread caller in full-access/default
 * mode, or a client approved with a full-access ceiling.
 */
export const readFullAccessCaller = Effect.fn("mcp.readFullAccessCaller")(function* (
  message: string,
) {
  const context = yield* readMutationCaller();
  if (
    (context.caller !== undefined && context.caller.archivedAt !== null) ||
    context.limits.runtimeMode !== "full-access" ||
    context.limits.interactionMode !== "default"
  ) {
    return yield* new OrchestratorMcpFailure({ code: "capability_denied", message });
  }
  return context;
});

/** A target project: the one passed, else the calling thread's. */
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

/** A target thread: the one passed, else the calling thread. */
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

/** Load a target thread anywhere in the environment; an omitted id means the calling thread. */
export const readThread = Effect.fn("mcp.readThread")(function* <
  K extends ProjectionRecordField = never,
>(threadId?: ThreadId, fields: ReadonlyArray<K> = []) {
  const context = yield* readCaller();
  const targetId = yield* resolveThreadId(context, threadId);
  const shell = yield* context.threads.getThreadShell(targetId).pipe(Effect.mapError(unavailable));
  if (shell === null || shell.deletedAt !== null) {
    return yield* new OrchestratorMcpFailure({
      code: "thread_not_found",
      message: "The thread was not found.",
    });
  }
  const projection = yield* context.threads
    .getProjectThreadRecords({ projectId: shell.projectId, threadId: targetId }, fields, {
      turnItemTypes: ["user_input_request", "approval_request"],
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

export const readWritableThread = Effect.fn("mcp.readWritableThread")(function* <
  K extends ProjectionRecordField = never,
>(threadId?: ThreadId, fields: ReadonlyArray<K> = []) {
  const context = yield* readThread(threadId, fields);
  yield* assertLiveCaller(context);
  yield* assertTargetWithinLimits(context.limits, context.projection.thread);
  return context;
});

export const newCommandId = Effect.fn("mcp.newCommandId")(function* () {
  const crypto = yield* Crypto.Crypto;
  return CommandId.make(`mcp:${yield* crypto.randomUUIDv4.pipe(Effect.orDie)}`);
});
