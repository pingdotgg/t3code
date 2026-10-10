import {
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2ProviderCapabilities,
  type OrchestrationV2ProviderSession,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2ProviderTurn,
  type ProviderDriverKind,
  type ProviderInstanceId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import { makeProviderFailure } from "@t3tools/provider-core/server/failure";
import { randomUuidV4 } from "@t3tools/provider-core/server/randomUuid";
import { turnScopedSelectionTransition } from "@t3tools/provider-core/server/selectionTransition";

import type { CloudBackend, CloudTask } from "./backends.ts";

/**
 * Cloud runs are unattended remote tasks: T3 sees when one starts and how it
 * ends, never its tool calls, approvals, or streamed text.
 */
const CloudProviderCapabilities = {
  runtimePolicy: { enforcement: "native" },
  sessions: {
    supportsMultipleProviderThreadsPerSession: false,
    supportsModelSwitchInSession: true,
    supportsProviderSwitchingViaHandoff: true,
    supportsRuntimeModeSwitchInSession: true,
    pendingRequestsSurviveRestart: false,
  },
  threads: {
    canCreateEmptyThread: true,
    canReadThreadSnapshot: false,
    canRollbackThread: false,
    canForkThread: false,
    canForkFromTurn: false,
    canForkFromSubagentThread: false,
    exposesNativeThreadId: false,
  },
  turns: {
    exposesNativeTurnId: false,
    emitsTurnStarted: true,
    emitsTurnCompleted: true,
    supportsInterrupt: true,
    supportsActiveSteering: false,
    supportsSteeringByInterruptRestart: false,
    supportsQueuedMessages: true,
    terminalStatusQuality: "strong",
  },
  streaming: {
    streamsAssistantText: false,
    streamsReasoning: false,
    streamsToolOutput: false,
    streamsPlanText: false,
    emitsMessageCompleted: true,
  },
  tools: {
    exposesToolItemIds: false,
    emitsToolStarted: false,
    emitsToolCompleted: false,
    emitsToolOutput: false,
    supportsMcpTools: false,
    supportsDynamicToolCallbacks: false,
  },
  approvals: {
    supportsCommandApproval: false,
    supportsFileReadApproval: false,
    supportsFileChangeApproval: false,
    supportsApplyPatchApproval: false,
    approvalsHaveNativeRequestIds: false,
    approvalCallbacksAreLiveOnly: false,
    approvalsCanOriginateFromSubagents: false,
  },
  planning: {
    emitsPlanUpdated: false,
    emitsTodoList: false,
    emitsProposedPlan: false,
    supportsStructuredQuestions: false,
    planDeltasHaveItemIds: false,
  },
  subagents: {
    supportsSubagents: false,
    exposesSubagentThreadIds: false,
    emitsSubagentLifecycle: false,
    canWaitForSubagents: false,
    canCloseSubagents: false,
    canForkSubagentThread: false,
  },
  context: {
    acceptsSystemContext: false,
    acceptsDeveloperContext: false,
    acceptsSyntheticUserContext: true,
    canGenerateSummaries: false,
    canConsumeHandoffSummaries: true,
    supportsDeltaHandoff: true,
    supportsFullThreadHandoff: true,
    maxRecommendedHandoffChars: null,
  },
  checkpointing: {
    appCanCheckpointFilesystem: true,
    supportsNestedCheckpointScopes: false,
    providerCanRollbackConversation: false,
    providerRollbackReturnsSnapshot: false,
    providerCanReadConversationSnapshot: false,
  },
  identity: {
    nativeThreadIds: "weak",
    nativeTurnIds: "weak",
    nativeItemIds: "weak",
    nativeRequestIds: "weak",
  },
} satisfies OrchestrationV2ProviderCapabilities;

export interface CloudAdapterOptions {
  readonly instanceId: ProviderInstanceId;
  readonly driver: ProviderDriverKind;
  readonly backend: CloudBackend;
}

interface ActiveRun {
  readonly input: ProviderAdapter.ProviderAdapterV2TurnInput;
  readonly nativeId: string;
  readonly startedAt: DateTime.Utc;
  providerTurn: OrchestrationV2ProviderTurn;
  task: CloudTask | undefined;
  fiber: Fiber.Fiber<void> | undefined;
}

/**
 * One adapter for every cloud runtime. A turn starts the backend's remote
 * task in the background and settles when the backend reports how it ended;
 * Stop only stops waiting, because the remote task belongs to the cloud.
 */
export const makeCloudAdapterV2 = Effect.fn("makeCloudAdapterV2")(function* (
  options: CloudAdapterOptions,
) {
  const idAllocator = yield* IdAllocator.IdAllocatorV2;
  const providerHost = yield* ProviderHost.ProviderHost;
  const { driver, instanceId } = options;
  const nativeRef = (nativeId: string) => ({ driver, nativeId, strength: "weak" as const });
  const protocolError = (detail: string) =>
    new ProviderAdapter.ProviderAdapterProtocolError({ driver, detail });

  return ProviderAdapter.ProviderAdapterV2.of({
    instanceId,
    driver,
    getCapabilities: () => Effect.succeed(CloudProviderCapabilities),
    planSelectionTransition: () => Effect.succeed(turnScopedSelectionTransition()),
    openSession: Effect.fn("CloudAdapterV2.openSession")(function* (
      input: ProviderAdapter.ProviderAdapterV2OpenSessionInput,
    ) {
      const scope = yield* Effect.scope;
      const cwd = input.runtimePolicy.cwd ?? providerHost.paths.cwd;
      const now = yield* DateTime.now;
      let session: OrchestrationV2ProviderSession = {
        id: input.providerSessionId,
        driver,
        providerInstanceId: instanceId,
        status: "ready",
        cwd,
        model: input.modelSelection.model,
        capabilities: CloudProviderCapabilities,
        createdAt: now,
        updatedAt: now,
        lastError: null,
      };
      const events = yield* Queue.unbounded<
        ProviderAdapter.ProviderAdapterV2Event,
        ProviderAdapter.ProviderAdapterV2Error
      >();
      const emit = (event: ProviderAdapter.ProviderAdapterV2Event) =>
        Queue.offer(events, event).pipe(Effect.asVoid);
      let thread: OrchestrationV2ProviderThread | undefined;
      let active: ActiveRun | undefined;

      const updateSession = Effect.fnUntraced(function* (
        status: OrchestrationV2ProviderSession["status"],
        lastError: string | null = null,
      ) {
        session = { ...session, status, lastError, updatedAt: yield* DateTime.now };
        yield* emit({ type: "provider_session.updated", driver, providerSession: session });
      });
      const updateThread = Effect.fnUntraced(function* (
        patch: Partial<OrchestrationV2ProviderThread>,
      ) {
        if (!thread) return;
        thread = { ...thread, ...patch, updatedAt: yield* DateTime.now };
        yield* emit({ type: "provider_thread.updated", driver, providerThread: thread });
      });

      // Each run shows one assistant message that follows the remote task.
      const publishMessage = Effect.fnUntraced(function* (
        run: ActiveRun,
        text: string,
        streaming: boolean,
      ) {
        const time = yield* DateTime.now;
        const nativeItemId = `${instanceId}:${run.nativeId}:reply`;
        const nodeId = idAllocator.derive.nodeFromProviderItem({ driver, nativeItemId });
        const messageId = idAllocator.derive.messageFromProviderItem({ driver, nativeItemId });
        const { startedAt } = run;
        const status = streaming ? "running" : "completed";
        const message: OrchestrationV2ConversationMessage = {
          id: messageId,
          threadId: run.input.threadId,
          runId: run.input.runId,
          nodeId,
          role: "assistant",
          text,
          attachments: [],
          streaming,
          createdBy: "agent",
          creationSource: "provider",
          createdAt: startedAt,
          updatedAt: time,
        };
        yield* emit({ type: "message.updated", driver, message });
        yield* emit({
          type: "node.updated",
          driver,
          node: {
            id: nodeId,
            threadId: run.input.threadId,
            runId: run.input.runId,
            parentNodeId: run.input.rootNodeId,
            rootNodeId: run.input.rootNodeId,
            kind: "assistant_message",
            status,
            countsForRun: false,
            providerThreadId: run.input.providerThread.id,
            providerTurnId: run.providerTurn.id,
            nativeItemRef: nativeRef(nativeItemId),
            runtimeRequestId: null,
            checkpointScopeId: null,
            startedAt,
            completedAt: streaming ? null : time,
          },
        });
        yield* emit({
          type: "turn_item.updated",
          driver,
          turnItem: {
            id: idAllocator.derive.turnItemFromProviderItem({ driver, nativeItemId }),
            nodeId,
            threadId: run.input.threadId,
            runId: run.input.runId,
            providerThreadId: run.input.providerThread.id,
            providerTurnId: run.providerTurn.id,
            nativeItemRef: nativeRef(nativeItemId),
            parentItemId: null,
            ordinal: run.input.providerTurnOrdinal * 100 + 1,
            startedAt,
            updatedAt: time,
            completedAt: streaming ? null : time,
            title: null,
            status,
            type: "assistant_message",
            messageId,
            text,
            streaming,
          },
        });
      });

      const finish = Effect.fnUntraced(function* (
        run: ActiveRun,
        outcome:
          | { readonly status: "completed"; readonly session?: string }
          | { readonly status: "interrupted" }
          | { readonly status: "failed"; readonly detail: string },
      ) {
        if (active !== run) return;
        active = undefined;
        const completedAt = yield* DateTime.now;
        run.providerTurn = { ...run.providerTurn, status: outcome.status, completedAt };
        yield* emit({
          type: "provider_turn.updated",
          driver,
          threadId: run.input.threadId,
          providerTurn: run.providerTurn,
        });
        yield* updateThread({
          status: "idle",
          ...(outcome.status === "completed" && outcome.session
            ? { nativeConversationHeadRef: nativeRef(outcome.session) }
            : {}),
        });
        yield* updateSession("ready", outcome.status === "failed" ? outcome.detail : null);
        const terminal = {
          type: "turn.terminal" as const,
          driver,
          providerThreadId: run.providerTurn.providerThreadId,
          providerTurnId: run.providerTurn.id,
          runOrdinal: run.input.runOrdinal,
          threadDisposition: "reusable" as const,
        };
        if (outcome.status !== "failed") {
          yield* emit({ ...terminal, status: outcome.status, failure: null });
          return;
        }
        const failure = makeProviderFailure({ class: "provider_error", message: outcome.detail });
        const nativeItemId = `${instanceId}:${run.nativeId}:failure`;
        const ordinal = run.input.providerTurnOrdinal * 100 + 2;
        yield* emit({
          type: "turn_item.updated",
          driver,
          turnItem: {
            id: idAllocator.derive.turnItemFromProviderItem({ driver, nativeItemId }),
            nodeId: idAllocator.derive.nodeFromProviderItem({ driver, nativeItemId }),
            threadId: run.input.threadId,
            runId: run.input.runId,
            providerThreadId: run.input.providerThread.id,
            providerTurnId: run.providerTurn.id,
            nativeItemRef: nativeRef(nativeItemId),
            parentItemId: null,
            ordinal,
            startedAt: completedAt,
            updatedAt: completedAt,
            completedAt,
            title: null,
            status: "failed",
            type: "error",
            failure,
          },
        });
        yield* emit({ ...terminal, status: "failed", failure, failureItemOrdinal: ordinal });
      });

      const execute = (run: ActiveRun, prompt: string) =>
        Effect.gen(function* () {
          const { backend } = options;
          yield* publishMessage(run, `Starting in ${backend.label}…`, true);
          const result = yield* backend.run({
            cwd,
            prompt,
            session: thread?.nativeConversationHeadRef?.nativeId ?? undefined,
            onTask: (task) => {
              run.task = task;
              return publishMessage(run, `Working in ${backend.label}: ${task.url}`, true);
            },
          });
          yield* publishMessage(run, result.text, false);
          yield* finish(run, {
            status: "completed",
            ...(result.session ? { session: result.session } : {}),
          });
        }).pipe(
          Effect.catchCause((cause) => {
            if (Cause.hasInterruptsOnly(cause)) return Effect.void;
            const error = Cause.squash(cause);
            return finish(run, {
              status: "failed",
              detail: error instanceof Error ? error.message : "The cloud task failed.",
            });
          }),
          Effect.onInterrupt(() =>
            Effect.gen(function* () {
              const { label } = options.backend;
              yield* publishMessage(
                run,
                run.task
                  ? `Stopped waiting. The task keeps running in ${label}: ${run.task.url}`
                  : `Stopped before ${label} confirmed the task. It may still have started.`,
                false,
              );
              yield* finish(run, { status: "interrupted" });
            }),
          ),
        );

      const register = Effect.fnUntraced(function* (
        threadId: OrchestrationV2ProviderThread["appThreadId"],
        existing: OrchestrationV2ProviderThread | undefined,
      ) {
        if (existing && (existing.driver !== driver || existing.providerInstanceId !== instanceId))
          return yield* protocolError("This thread belongs to another provider instance");
        if (thread && (!existing || existing.id === thread.id)) return thread;
        if (active) return yield* protocolError("Cannot switch threads during an active run");
        const time = yield* DateTime.now;
        const nativeId = existing?.nativeThreadRef?.nativeId ?? (yield* randomUuidV4);
        thread = existing
          ? { ...existing, providerSessionId: input.providerSessionId, status: "idle" }
          : {
              id: idAllocator.derive.providerThread({
                driver,
                providerInstanceId: instanceId,
                nativeThreadId: nativeId,
              }),
              driver,
              providerInstanceId: instanceId,
              providerSessionId: input.providerSessionId,
              appThreadId: threadId,
              ownerNodeId: null,
              nativeThreadRef: nativeRef(nativeId),
              nativeConversationHeadRef: null,
              status: "idle",
              firstRunOrdinal: null,
              lastRunOrdinal: null,
              handoffIds: [],
              forkedFrom: null,
              createdAt: time,
              updatedAt: time,
            };
        yield* emit({ type: "provider_thread.updated", driver, providerThread: thread });
        return thread;
      });

      const start = Effect.fnUntraced(function* (
        turnInput: ProviderAdapter.ProviderAdapterV2TurnInput,
      ) {
        if (active) return yield* protocolError("A cloud run is already active");
        if (turnInput.message.attachments.length > 0)
          return yield* protocolError("Cloud runs take text only; remove the attachments");
        if (!turnInput.message.text.trim())
          return yield* protocolError("Cloud runs need a message");
        // Keep this session's copy when it is the same thread: it already has the
        // cloud session an earlier turn started, which the orchestrator may not have yet.
        if (thread?.id !== turnInput.providerThread.id) thread = turnInput.providerThread;
        const nativeId = `${turnInput.runId}:${turnInput.attemptId}`;
        const startedAt = yield* DateTime.now;
        const run: ActiveRun = {
          input: turnInput,
          nativeId,
          startedAt,
          task: undefined,
          fiber: undefined,
          providerTurn: {
            id: idAllocator.derive.providerTurn({
              driver,
              nativeTurnId: `${instanceId}:${nativeId}`,
            }),
            providerThreadId: turnInput.providerThread.id,
            nodeId: turnInput.rootNodeId,
            runAttemptId: turnInput.attemptId,
            nativeTurnRef: nativeRef(nativeId),
            ordinal: turnInput.providerTurnOrdinal,
            status: "running",
            startedAt,
            completedAt: null,
          },
        };
        active = run;
        yield* emit({
          type: "provider_turn.updated",
          driver,
          threadId: turnInput.threadId,
          providerTurn: run.providerTurn,
        });
        yield* updateThread({
          status: "active",
          firstRunOrdinal: thread.firstRunOrdinal ?? turnInput.runOrdinal,
          lastRunOrdinal: turnInput.runOrdinal,
        });
        yield* updateSession("running");
        run.fiber = yield* execute(run, turnInput.message.text).pipe(Effect.forkIn(scope));
      });

      const runtime: ProviderAdapter.ProviderAdapterV2SessionRuntime = {
        instanceId,
        driver,
        providerSessionId: input.providerSessionId,
        providerSession: session,
        events: Stream.fromQueue(events),
        ensureThread: (args) =>
          register(args.threadId, args.existingProviderThread).pipe(
            Effect.mapError(
              (cause) =>
                new ProviderAdapter.ProviderAdapterEnsureThreadError({
                  driver,
                  threadId: args.threadId,
                  cause,
                }),
            ),
          ),
        resumeThread: (args) =>
          register(args.threadId ?? args.providerThread.appThreadId, args.providerThread).pipe(
            Effect.mapError(
              (cause) =>
                new ProviderAdapter.ProviderAdapterResumeThreadError({
                  driver,
                  providerSessionId: input.providerSessionId,
                  providerThreadId: args.providerThread.id,
                  cause,
                }),
            ),
          ),
        startTurn: (args) =>
          start(args).pipe(
            Effect.mapError(
              (cause) =>
                new ProviderAdapter.ProviderAdapterTurnStartError({
                  driver,
                  threadId: args.threadId,
                  providerThreadId: args.providerThread.id,
                  runId: args.runId,
                  cause,
                }),
            ),
          ),
        steerTurn: (args) =>
          Effect.fail(
            new ProviderAdapter.ProviderAdapterSteerRunUnsupportedError({
              driver,
              providerThreadId: args.providerThread.id,
            }),
          ),
        interruptTurn: (args) =>
          Effect.gen(function* () {
            const run = active;
            if (!run || run.providerTurn.id !== args.providerTurnId)
              return yield* protocolError("This cloud run is no longer active");
            if (run.fiber) yield* Fiber.interrupt(run.fiber);
          }).pipe(
            Effect.mapError(
              (cause) =>
                new ProviderAdapter.ProviderAdapterInterruptError({
                  driver,
                  providerThreadId: args.providerThread.id,
                  providerTurnId: args.providerTurnId,
                  cause,
                }),
            ),
          ),
        respondToRuntimeRequest: (args) =>
          Effect.fail(
            new ProviderAdapter.ProviderAdapterRuntimeRequestResponseError({
              driver,
              requestId: args.requestId,
              cause: "Cloud runs never ask for approval.",
            }),
          ),
        // T3 keeps the transcript; the cloud keeps its own on its website.
        readThreadSnapshot: (args) =>
          Effect.succeed({
            providerThread: args.providerThread,
            providerTurns: [],
            messages: [],
            runtimeRequests: [],
          }),
        rollbackThread: (args) =>
          Effect.fail(
            new ProviderAdapter.ProviderAdapterRollbackThreadError({
              driver,
              providerThreadId: args.providerThread.id,
              checkpointId: args.target.checkpointId,
              cause: "Cloud sessions cannot be rewound from T3 Code.",
            }),
          ),
        forkThread: (args) =>
          Effect.fail(
            new ProviderAdapter.ProviderAdapterForkThreadError({
              driver,
              providerThreadId: args.sourceProviderThread.id,
              cause: "Cloud sessions cannot be forked from T3 Code.",
            }),
          ),
      };
      return runtime;
    }),
  });
});
