import {
  CommandId,
  type ConversationForkInput,
  type ConversationForkNativeEligibility,
  type ConversationForkResult,
  type ConversationTransferListInput,
  type ConversationTransferListResult,
  type ConversationTransferReceipt,
  type OrchestrationV2ContextTransfer,
  type OrchestrationV2Run,
  type OrchestrationV2ThreadForkSourcePoint,
  type OrchestrationV2ThreadProjection,
  OrchestratorMcpFailure,
  type ProviderInteractionMode,
  type RuntimeMode,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type { OrchestratorV2DispatchResult } from "../orchestration-v2/Orchestrator.ts";
import {
  ThreadManagementService,
  ThreadManagementThreadNotFoundError,
} from "../orchestration-v2/ThreadManagementService.ts";
import type { McpInvocationScope } from "./McpInvocationContext.ts";

export class ConversationTransferMcpService extends Context.Service<
  ConversationTransferMcpService,
  {
    readonly list: (
      scope: McpInvocationScope,
      input: ConversationTransferListInput,
    ) => Effect.Effect<ConversationTransferListResult, OrchestratorMcpFailure>;
    readonly fork: (
      scope: McpInvocationScope,
      input: ConversationForkInput,
    ) => Effect.Effect<ConversationForkResult, OrchestratorMcpFailure>;
  }
>()("t3/mcp/ConversationTransferMcpService") {}

const isThreadNotFound = Schema.is(ThreadManagementThreadNotFoundError);

function failure(code: OrchestratorMcpFailure["code"], message: string): OrchestratorMcpFailure {
  return new OrchestratorMcpFailure({ code, message });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function runtimeModeRank(mode: RuntimeMode): number {
  switch (mode) {
    case "approval-required":
      return 0;
    case "auto-accept-edits":
      return 1;
    case "auto":
      return 2;
    case "full-access":
      return 3;
  }
}

function interactionModeRank(mode: ProviderInteractionMode): number {
  return mode === "plan" ? 0 : 1;
}

function stablePart(value: string): string {
  return encodeURIComponent(value);
}

function targetThreadId(scope: McpInvocationScope, requestKey: string): ThreadId {
  return ThreadId.make(
    `thread:mcp:${stablePart(scope.providerSessionId)}:conversation-fork:target:${stablePart(requestKey)}`,
  );
}

function forkCommandId(scope: McpInvocationScope, requestKey: string): CommandId {
  return CommandId.make(
    `command:mcp:${stablePart(scope.providerSessionId)}:thread-fork:${stablePart(requestKey)}`,
  );
}

function sourceRun(
  projection: OrchestrationV2ThreadProjection,
  point: OrchestrationV2ThreadForkSourcePoint,
): OrchestrationV2Run | undefined {
  switch (point.type) {
    case "latest_stable":
      return projection.runs
        .filter((run) => run.status === "completed" && run.checkpointId !== null)
        .toSorted((left, right) => right.ordinal - left.ordinal)[0];
    case "run":
      return projection.runs.find((run) => run.id === point.runId);
    case "checkpoint":
      const checkpoint = projection.checkpoints.find(
        (candidate) => candidate.id === point.checkpointId,
      );
      return checkpoint?.runId === null || checkpoint === undefined
        ? undefined
        : projection.runs.find((run) => run.id === checkpoint.runId);
  }
}

export function conversationForkNativeEligibility(
  projection: OrchestrationV2ThreadProjection,
  run: OrchestrationV2Run,
): ConversationForkNativeEligibility {
  const providerThread = projection.providerThreads.find(
    (candidate) => candidate.id === run.providerThreadId,
  );
  const session = projection.providerSessions.find(
    (candidate) => candidate.id === providerThread?.providerSessionId,
  );
  if (session === undefined) return "source_provider_session_unavailable";
  if (!session.capabilities.threads.canForkThread) return "provider_does_not_support_fork";
  if (!session.capabilities.threads.canForkFromTurn) {
    return "provider_does_not_support_turn_fork";
  }
  if (
    providerThread?.nativeThreadRef?.strength !== "strong" ||
    session.capabilities.identity.nativeThreadIds !== "strong"
  ) {
    return "strong_native_source_unavailable";
  }
  return "eligible";
}

function receipt(result: OrchestratorV2DispatchResult, commandId: CommandId) {
  return {
    commandId,
    commandType: "thread.fork",
    sequence: result.sequence,
    eventIds: result.storedEvents.map((stored) => stored.event.id),
  } satisfies ConversationTransferReceipt;
}

function forkTransfer(
  result: OrchestratorV2DispatchResult,
  targetThreadId: ThreadId,
): OrchestrationV2ContextTransfer | undefined {
  for (const stored of result.storedEvents) {
    if (
      stored.event.type === "context-transfer.created" &&
      stored.event.payload.type === "fork" &&
      stored.event.payload.targetThreadId === targetThreadId
    ) {
      return stored.event.payload;
    }
  }
  return undefined;
}

export const make = Effect.gen(function* () {
  const threads = yield* ThreadManagementService;

  const requireCapability = (scope: McpInvocationScope) =>
    scope.capabilities.has("orchestration")
      ? Effect.void
      : Effect.fail(failure("capability_denied", "This MCP credential cannot control threads."));

  const loadScoped = Effect.fn("ConversationTransferMcpService.loadScoped")(function* (
    scope: McpInvocationScope,
    requestedThreadId: ThreadId | undefined,
  ) {
    yield* requireCapability(scope);
    const parent = yield* threads
      .getThreadProjection(scope.threadId)
      .pipe(
        Effect.mapError((error) =>
          failure(
            "orchestration_error",
            `Unable to load the calling thread: ${errorMessage(error)}`,
          ),
        ),
      );
    const threadId = requestedThreadId ?? scope.threadId;
    const target = yield* threads
      .getProjectThread({ projectId: parent.thread.projectId, threadId })
      .pipe(
        Effect.mapError((error) =>
          isThreadNotFound(error)
            ? failure(
                "thread_not_found",
                `Thread ${threadId} was not found in the calling project.`,
              )
            : failure(
                "orchestration_error",
                `Unable to load thread ${threadId}: ${errorMessage(error)}`,
              ),
        ),
      );
    return { parent, target };
  });

  const resultFromDispatch = Effect.fn("ConversationTransferMcpService.resultFromDispatch")(
    function* (input: {
      readonly request: ConversationForkInput;
      readonly commandId: CommandId;
      readonly targetThreadId: ThreadId;
      readonly dispatched: OrchestratorV2DispatchResult;
      readonly source: OrchestrationV2ThreadProjection | undefined;
    }) {
      const transfer = forkTransfer(input.dispatched, input.targetThreadId);
      if (transfer === undefined) {
        return yield* failure(
          "orchestration_error",
          "The fork command committed without returning its context-transfer event.",
        );
      }
      const run =
        input.source === undefined || transfer.sourcePoint.runId === undefined
          ? undefined
          : input.source.runs.find((candidate) => candidate.id === transfer.sourcePoint.runId);
      return {
        sourceThreadId: transfer.sourceThreadId,
        targetThreadId: input.targetThreadId,
        scope: "conversation_through_source_point",
        requestedSourcePoint: input.request.sourcePoint,
        canonicalSourcePoint: transfer.sourcePoint,
        transfer,
        providerSupport: {
          sourceProviderInstanceId: transfer.sourceProviderInstanceId,
          nativeForkEligibility:
            input.source === undefined || run === undefined
              ? "source_provider_session_unavailable"
              : conversationForkNativeEligibility(input.source, run),
          resolutionTiming: "first_target_turn",
          fallback: "provider_context_capabilities_checked_on_first_target_turn",
        },
        receipt: receipt(input.dispatched, input.commandId),
      } satisfies ConversationForkResult;
    },
  );

  return ConversationTransferMcpService.of({
    list: (scope, input) =>
      Effect.gen(function* () {
        const { target } = yield* loadScoped(scope, input.threadId);
        const limit = input.limit ?? 50;
        const matching = target.contextTransfers
          .filter((transfer) => input.type === undefined || transfer.type === input.type)
          .toSorted(
            (left, right) =>
              DateTime.toEpochMillis(right.updatedAt) - DateTime.toEpochMillis(left.updatedAt),
          );
        return {
          threadId: target.thread.id,
          scope: "current_project",
          transfers: matching.slice(0, limit),
          hasMore: matching.length > limit,
        };
      }),
    fork: (scope, input) =>
      Effect.gen(function* () {
        yield* requireCapability(scope);
        const commandId = forkCommandId(scope, input.clientRequestId);
        const targetId = targetThreadId(scope, input.clientRequestId);
        const existingTarget = yield* Effect.option(threads.getThreadProjection(targetId));
        const existingTransfer = Option.isSome(existingTarget)
          ? existingTarget.value.contextTransfers.find(
              (transfer) => transfer.type === "fork" && transfer.targetThreadId === targetId,
            )
          : undefined;
        if (existingTransfer !== undefined) {
          const replayed = yield* threads
            .dispatch({
              type: "thread.fork",
              createdBy: "agent",
              creationSource: "mcp",
              commandId,
              sourceThreadId: input.sourceThreadId ?? scope.threadId,
              targetThreadId: targetId,
              sourcePoint: input.sourcePoint,
              ...(input.title === undefined ? {} : { title: input.title }),
            })
            .pipe(
              Effect.mapError((error) =>
                failure(
                  "orchestration_error",
                  `Unable to replay the fork receipt: ${errorMessage(error)}`,
                ),
              ),
            );
          const replaySource = yield* Effect.option(
            threads.getThreadProjection(existingTransfer.sourceThreadId),
          );
          return yield* resultFromDispatch({
            request: input,
            commandId,
            targetThreadId: targetId,
            dispatched: replayed,
            source: Option.getOrUndefined(replaySource),
          });
        }

        const { parent, target: source } = yield* loadScoped(scope, input.sourceThreadId);
        if (
          runtimeModeRank(source.thread.runtimeMode) > runtimeModeRank(parent.thread.runtimeMode)
        ) {
          return yield* failure(
            "runtime_mode_escalation_denied",
            `The source thread's ${source.thread.runtimeMode} runtime mode exceeds the calling thread's ${parent.thread.runtimeMode} ceiling.`,
          );
        }
        if (
          interactionModeRank(source.thread.interactionMode) >
          interactionModeRank(parent.thread.interactionMode)
        ) {
          return yield* failure(
            "interaction_mode_escalation_denied",
            `The source thread's ${source.thread.interactionMode} interaction mode exceeds the calling thread's ${parent.thread.interactionMode} ceiling.`,
          );
        }
        const run = sourceRun(source, input.sourcePoint);
        if (run === undefined) {
          return yield* failure(
            "run_not_found",
            `No run in thread ${source.thread.id} matches source point ${input.sourcePoint.type}.`,
          );
        }
        if (run.status !== "completed") {
          return yield* failure(
            "invalid_request",
            `Fork source run ${run.id} is ${run.status}; only completed runs are stable fork sources.`,
          );
        }

        const dispatched = yield* threads
          .dispatch({
            type: "thread.fork",
            createdBy: "agent",
            creationSource: "mcp",
            commandId,
            sourceThreadId: source.thread.id,
            targetThreadId: targetId,
            sourcePoint: input.sourcePoint,
            ...(input.title === undefined ? {} : { title: input.title }),
            policyCeiling: {
              callerThreadId: parent.thread.id,
              runtimeMode: parent.thread.runtimeMode,
              interactionMode: parent.thread.interactionMode,
            },
          })
          .pipe(
            Effect.mapError((error) =>
              failure("orchestration_error", `Unable to fork the thread: ${errorMessage(error)}`),
            ),
          );
        return yield* resultFromDispatch({
          request: input,
          commandId,
          targetThreadId: targetId,
          dispatched,
          source,
        });
      }),
  });
});

export const layer: Layer.Layer<ConversationTransferMcpService, never, ThreadManagementService> =
  Layer.effect(ConversationTransferMcpService, make);
