// @effect-diagnostics nodeBuiltinImport:off -- the SDK takes a Node ChildProcess for the CLI.
import { makeProviderTextDeltaCoalescer } from "./ProviderTextDeltaCoalescer.ts";

import { text } from "../unknownField.ts";

import type { WorkflowAgentMetadata } from "../workflowAgentAnswers.ts";

import type { WorkflowAgentTranscriptCursor } from "../workflowAgentTranscript.ts";

import type { ClaudeLedgerUsage } from "../../provider/ClaudeTurnTokenUsage.ts";

import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";

import { OrchestrationV2ProviderGoal } from "@t3tools/contracts";
import type {
  OrchestrationV2PlanArtifact,
  OrchestrationV2PendingBackgroundTask,
  OrchestrationV2ProviderThread,
  OrchestrationV2ProviderTurn,
  OrchestrationV2Subagent,
  ProviderThreadId,
  ThreadId,
} from "@t3tools/contracts";

import * as DateTime from "effect/DateTime";

import * as Deferred from "effect/Deferred";

import * as Effect from "effect/Effect";

import * as Fiber from "effect/Fiber";

import * as Option from "effect/Option";

import * as Queue from "effect/Queue";

import * as Ref from "effect/Ref";

import * as Semaphore from "effect/Semaphore";

import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";

import type { BackgroundWorkReport } from "@t3tools/provider-core/server/notification";
import type { ClaudeAdapterEnv } from "./ClaudeAdapterEnv.ts";
import { CLAUDE_PROVIDER } from "./ClaudeProviderIdentity.ts";
import { claudeRuntimeQueryPolicyForRuntimePolicy } from "./ClaudeRuntimePolicy.ts";
import { makeClaudeAttachmentBudget } from "./ClaudeUserMessage.ts";
import { permissionModeForClaudeRuntimePolicy } from "./ClaudeRuntimePolicy.ts";
import { providerSession } from "./ClaudeProviderMessages.ts";
import type { ActiveClaudeProviderRetry } from "./ClaudeAssistantArtifacts.ts";
import type { ActiveClaudeSubagent } from "./ClaudeAssistantArtifacts.ts";
import type { ActiveClaudeToolCall } from "./ClaudeAssistantArtifacts.ts";
import type { ActiveClaudeTurnContext } from "./ClaudeAssistantArtifacts.ts";
import type { ClaudeBypassAvailability } from "./ClaudeRuntimePolicy.ts";
import type { ClaudeLiveQueryContext } from "./ClaudeAssistantArtifacts.ts";
import type { ClaudeTaskList } from "./ClaudeSessionTypes.ts";
import type { PendingClaudeRuntimeRequest } from "./ClaudeSessionTypes.ts";
import type { PendingClaudeSubagentLaunch } from "./ClaudeSessionTypes.ts";

export type ClaudeSessionEnv = ClaudeAdapterEnv & {
  readonly input: import("@t3tools/provider-core/server/ProviderAdapter").ProviderAdapterV2OpenSessionInput;
};

/** Mutable per-session state shared by every installed session module. */
export const makeClaudeSessionState = Effect.fn("ClaudeSessionState.make")(function* (
  env: ClaudeSessionEnv,
) {
  const { adapterOptions, idAllocator, resolveBypassAvailability, input } = env;
  const sessionScope = yield* Effect.scope;
  const now = yield* DateTime.now;
  const session = providerSession({
    providerSessionId: input.providerSessionId,
    providerInstanceId: adapterOptions.instanceId,
    cwd: input.runtimePolicy.cwd,
    model: input.modelSelection.model,
    now,
  });
  const events = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
  const activeTurn = yield* Ref.make<ActiveClaudeTurnContext | null>(null);
  const taskOutputTails = new Map<
    string,
    { readonly fiber: Fiber.Fiber<void>; readonly stop: Deferred.Deferred<void> }
  >();
  // Waits for the tail's last read so its output lands before the call settles.
  const stopTaskOutputTail = (toolUseId: string) =>
    Effect.suspend(() => {
      const tail = taskOutputTails.get(toolUseId);
      if (tail === undefined) return Effect.void;
      taskOutputTails.delete(toolUseId);
      return Deferred.succeed(tail.stop, undefined).pipe(
        Effect.andThen(Fiber.await(tail.fiber)),
        Effect.asVoid,
      );
    });
  const sdkMessageLock = yield* Semaphore.make(1);
  // Members can finish after the launching turn; retain state to emit each transition once.
  const workflowMemberStates = yield* Ref.make(
    new Map<
      string,
      {
        readonly status: OrchestrationV2Subagent["status"];
        readonly attempt: number;
        readonly transcriptReadAttempts: number;
        readonly finalTranscriptRead: boolean;
        readonly agentId: string | undefined;
        readonly transcriptCursor: WorkflowAgentTranscriptCursor;
        readonly transcriptMetadata: WorkflowAgentMetadata;
        readonly nextItemOrdinal: number;
        readonly toolCalls: Map<string, ActiveClaudeToolCall>;
        readonly textShown: boolean;
        readonly turnEnded: boolean;
        readonly resultShown: boolean;
        readonly result: string | undefined;
        readonly label: string;
        readonly prompt: string;
        readonly model: string;
        readonly createdAt: DateTime.Utc;
        readonly startedAt: DateTime.Utc | null;
        readonly completedAt: DateTime.Utc | null;
      }
    >(),
  );
  const interruptedTurns = yield* Ref.make(new Set<OrchestrationV2ProviderTurn["id"]>());
  const steeredTurns = yield* Ref.make(new Set<OrchestrationV2ProviderTurn["id"]>());
  const queryContext = yield* Ref.make<ClaudeLiveQueryContext | null>(null);
  // Wake buffers replay result frames, so ledger growth is measured once on arrival.
  const resultLedgerUsage = new WeakMap<SDKMessage, ClaudeLedgerUsage>();
  const resultsReportingNewContextWindow = new WeakSet<SDKMessage>();
  // A worktree handoff changes the project settings even within one session.
  let bypassCache: { cwd: string | null; availability: ClaudeBypassAvailability } | null = null;
  const queryPolicyForTurn = Effect.fnUntraced(function* (
    turnInput: ProviderAdapter.ProviderAdapterV2TurnInput,
  ) {
    if (permissionModeForClaudeRuntimePolicy(turnInput.runtimePolicy) !== "bypassPermissions") {
      return claudeRuntimeQueryPolicyForRuntimePolicy(turnInput.runtimePolicy);
    }
    const cwd = turnInput.runtimePolicy.cwd;
    if (bypassCache === null || bypassCache.cwd !== cwd) {
      const resolved = yield* resolveBypassAvailability(cwd).pipe(Effect.option);
      if (Option.isNone(resolved)) {
        return claudeRuntimeQueryPolicyForRuntimePolicy(turnInput.runtimePolicy, {
          bypassDisabled: true,
          autoDisabled: false,
        });
      }
      bypassCache = { cwd, availability: resolved.value };
    }
    return claudeRuntimeQueryPolicyForRuntimePolicy(
      turnInput.runtimePolicy,
      bypassCache.availability,
    );
  });
  const openedNativeThreads = yield* Ref.make(new Set<string>());
  const pdfBudgets = new Map<string, ReturnType<typeof makeClaudeAttachmentBudget>>();
  const latestPlanByKind = yield* Ref.make(new Map<string, OrchestrationV2PlanArtifact>());
  // Claude 5 task tools edit one list per native session, across turns.
  const taskListsByNativeThread = yield* Ref.make(new Map<string, ClaudeTaskList | undefined>());
  const planIdsByNativeItem = yield* Ref.make(new Map<string, OrchestrationV2PlanArtifact["id"]>());
  const providerRetries = yield* Ref.make(
    new Map<OrchestrationV2ProviderTurn["id"], ActiveClaudeProviderRetry>(),
  );
  const pendingRuntimeRequests = yield* Ref.make(new Map<string, PendingClaudeRuntimeRequest>());
  // Background local_bash tasks can trigger wake turns on the query stream with no active provider turn.
  const lastTurnRouteByNativeThread = yield* Ref.make(
    new Map<string, { readonly threadId: ThreadId; readonly providerThreadId: ProviderThreadId }>(),
  );
  const pendingBackgroundTasksByNativeThread = yield* Ref.make(
    new Map<string, Map<string, OrchestrationV2PendingBackgroundTask>>(),
  );
  // Survives roster REPLACE levels, which rebuild every entry without the agent's mark.
  const awaitedBackgroundTasksByNativeThread = yield* Ref.make(new Map<string, Set<string>>());
  // Wake eligibility is separate from the Waiting roster. It survives empty
  // background_tasks_changed levels (SDK: empty level can precede task_notification) and
  // is consumed when the first idle notification is buffered/offered so duplicates cannot
  // re-buffer.
  const wakeEligibleBackgroundTasksByNativeThread = yield* Ref.make(new Map<string, Set<string>>());
  const opaqueBackgroundTaskReplayTombstonesByNativeThread = yield* Ref.make(
    new Map<string, Set<string>>(),
  );
  const lastProviderThreadByNativeThread = yield* Ref.make(
    new Map<string, OrchestrationV2ProviderThread>(),
  );
  const goalsByNativeThread = new Map<string, OrchestrationV2ProviderGoal | null>();
  const goalCheckedTurns = new Set<string>();
  // Background subagents can finish after root settlement; retain their registry for wake evidence and hydration.
  const sessionSubagentsByTaskId = yield* Ref.make(new Map<string, ActiveClaudeSubagent>());
  const sessionSubagentTaskIdsByToolUseId = yield* Ref.make(new Map<string, string>());
  // Claude may never answer a background move; later steers must wait on the same request.
  const backgroundMovesByToolUseId = new Map<string, Fiber.Fiber<void>>();
  const subagentToolCalls = new Map<string, ActiveClaudeToolCall>();
  const pendingSubagentLaunchesByToolUseId = new Map<string, PendingClaudeSubagentLaunch>();
  const settledTurnByNativeThread = new Map<string, ActiveClaudeTurnContext>();
  const subagentStopOutcomes = new Map<
    string,
    Deferred.Deferred<ProviderAdapter.ProviderAdapterV2SubagentOutcome>
  >();
  // Buffered idle outcomes must not settle a resumed child again.
  const appliedSubagentOutcomes = new WeakSet<SDKMessage>();
  // Subagent frames can precede the task_started that registers their owner.
  const pendingSubagentFramesByToolUseId = yield* Ref.make(
    new Map<string, ReadonlyArray<SDKMessage>>(),
  );
  // A gateway's relative reset counts from the result's arrival, not its replay.
  const bufferedResultArrivals = new WeakMap<SDKMessage, DateTime.Utc>();
  const wakeBuffers = yield* Ref.make(
    new Map<
      string,
      { readonly messages: ReadonlyArray<SDKMessage>; readonly detail: string | null }
    >(),
  );
  // Wake results lack task ids and can follow queued prompts; retain reports for one user turn.
  // Keep report stamps atomic with turn changes.
  const wakeReportsByNativeThread = yield* Ref.make<{
    readonly userTurns: ReadonlyMap<string, number>;
    readonly reports: ReadonlyMap<
      string,
      ReadonlyMap<string, { readonly report: BackgroundWorkReport; readonly turn: number }>
    >;
  }>({ userTurns: new Map(), reports: new Map() });
  const backgroundedSubagentTaskIds = yield* Ref.make<ReadonlySet<string>>(new Set());
  // Nested subagent completions notify their owner and never wake the root.
  const nestedSubagentTaskIds = yield* Ref.make<ReadonlySet<string>>(new Set());
  const isNestedSubagentTask = (taskId: string) =>
    Ref.get(nestedSubagentTaskIds).pipe(Effect.map((ids) => ids.has(taskId)));
  // Empty roster levels can precede notifications; retain tasks for wake attribution.
  const lastKnownOpaqueTasks = yield* Ref.make(
    new Map<string, OrchestrationV2PendingBackgroundTask>(),
  );
  const claudeMonitors = yield* Ref.make<{
    readonly calls: ReadonlySet<string>;
    readonly tasks: ReadonlyMap<
      string,
      { readonly toolUseId: string; readonly nativeThreadId: string }
    >;
  }>({ calls: new Set(), tasks: new Map() });
  const requestedContinuations = yield* Ref.make(new Set<string>());
  const absorbedWakes = yield* Ref.make(new Set<string>());
  const heldProposedPlansByToolUseId = new Map<string, string>();
  const runtimeContext = yield* Effect.context<never>();
  const runPromise = Effect.runPromiseWith(runtimeContext);

  const emitProviderEvent = (event: ProviderAdapter.ProviderAdapterV2Event) => {
    if (event.type === "provider_thread.updated") {
      const budget = pdfBudgets.get(event.providerThread.nativeThreadRef?.nativeId ?? "");
      if (budget !== undefined) {
        event = {
          ...event,
          providerThread: {
            ...event.providerThread,
            nativeMetadata: {
              ...event.providerThread.nativeMetadata,
              claudeAttachmentBudget: {
                bytesUsed: budget.committed.bytes,
                pagesUsed: budget.committed.pages,
              },
            },
          },
        };
      }
    }
    return Queue.offer(events, event).pipe(Effect.asVoid);
  };

  const reasoningDeltas = yield* makeProviderTextDeltaCoalescer({
    flushIntervalMs: 50,
    emit:
      /* Provider events include streaming deltas; avoid a span for each update. */
      Effect.fnUntraced(function* (update) {
        const context = yield* Ref.get(activeTurn);
        if (context === null || context.nativeTurnId !== update.turnId) return;
        const block = context.reasoning.blocks.get(update.itemId);
        if (block === undefined || update.text.length === 0) return;
        block.text = update.text;
        const now = yield* DateTime.now;
        yield* emitProviderEvent({
          type: "turn_item.updated",
          driver: CLAUDE_PROVIDER,
          turnItem: {
            id: idAllocator.derive.turnItemFromProviderItem({
              driver: CLAUDE_PROVIDER,
              nativeItemId: update.itemId,
            }),
            threadId: context.input.threadId,
            runId: context.input.runId,
            nodeId: context.input.rootNodeId,
            providerThreadId: context.input.providerThread.id,
            providerTurnId: context.providerTurnId,
            nativeItemRef: {
              driver: CLAUDE_PROVIDER,
              nativeId: update.itemId,
              strength: "strong",
            },
            parentItemId: null,
            ordinal: block.ordinal,
            type: "reasoning",
            title: "Thinking",
            text: update.text,
            streaming: !update.completed,
            status: update.completed ? "completed" : "running",
            startedAt: block.startedAt,
            completedAt: update.completed ? now : null,
            updatedAt: now,
          },
        });
      }),
  });

  return {
    env,
    sessionScope,
    now,
    session,
    events,
    activeTurn,
    taskOutputTails,
    stopTaskOutputTail,
    sdkMessageLock,
    workflowMemberStates,
    interruptedTurns,
    steeredTurns,
    queryContext,
    resultLedgerUsage,
    resultsReportingNewContextWindow,
    bypassCache,
    queryPolicyForTurn,
    openedNativeThreads,
    pdfBudgets,
    latestPlanByKind,
    taskListsByNativeThread,
    planIdsByNativeItem,
    providerRetries,
    pendingRuntimeRequests,
    lastTurnRouteByNativeThread,
    pendingBackgroundTasksByNativeThread,
    awaitedBackgroundTasksByNativeThread,
    wakeEligibleBackgroundTasksByNativeThread,
    opaqueBackgroundTaskReplayTombstonesByNativeThread,
    lastProviderThreadByNativeThread,
    goalsByNativeThread,
    goalCheckedTurns,
    sessionSubagentsByTaskId,
    sessionSubagentTaskIdsByToolUseId,
    backgroundMovesByToolUseId,
    subagentToolCalls,
    pendingSubagentLaunchesByToolUseId,
    settledTurnByNativeThread,
    subagentStopOutcomes,
    appliedSubagentOutcomes,
    pendingSubagentFramesByToolUseId,
    bufferedResultArrivals,
    wakeBuffers,
    wakeReportsByNativeThread,
    backgroundedSubagentTaskIds,
    nestedSubagentTaskIds,
    isNestedSubagentTask,
    lastKnownOpaqueTasks,
    claudeMonitors,
    requestedContinuations,
    absorbedWakes,
    heldProposedPlansByToolUseId,
    runtimeContext,
    runPromise,
    emitProviderEvent,
    reasoningDeltas,
  };
});

export type ClaudeSessionState = Effect.Success<ReturnType<typeof makeClaudeSessionState>>;
