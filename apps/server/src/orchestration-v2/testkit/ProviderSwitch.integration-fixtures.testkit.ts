import { vi } from "vite-plus/test";
import { historyResponseItems } from "@t3tools/provider-core/server/handoffBudget";
import { assert, describe, it } from "@effect/vitest";
import {
  CommandId,
  type ChatAttachment,
  EventId,
  MessageId,
  type ModelSelection,
  type OrchestrationV2Command,
  type OrchestrationV2ProviderCapabilities,
  type OrchestrationV2ProviderSession,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2ProviderTurnTokenUsage,
  type OrchestrationV2ThreadProjection,
  ProjectId,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  ProviderTurnId,
  ThreadId,
  TurnItemId,
  ProviderDriverKind,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import { CommandPolicyCapabilityUnsupportedError } from "../CommandPolicy.ts";
import {
  ClaudeAgentSdkQueryRunnerError,
  ClaudeAppendSystemPromptFileError,
  ClaudeBackgroundWorkBlocksQueryReplacementError,
  ClaudeProviderCapabilitiesV2,
} from "../Adapters/ClaudeAdapterV2.ts";
import {
  CodexProviderCapabilitiesV2,
  canReuseCodexContextUsage,
} from "../Adapters/CodexAdapterV2.ts";
import { AcpProviderCapabilitiesV2 } from "@t3tools/provider-acp/server/adapter";
import * as EventSink from "../EventSink.ts";
import * as EventStore from "../EventStore.ts";
import * as LegacyV1ThreadImporter from "../legacy/LegacyV1ThreadImporter.ts";
import * as Orchestrator from "../Orchestrator.ts";
import * as EffectWorker from "../EffectWorker.ts";
import * as EffectOutbox from "../EffectOutbox.ts";
import * as ProjectionReplay from "./ProjectionReplay.ts";
import * as ProjectionStore from "../ProjectionStore.ts";
import * as ProviderAdapterRegistry from "../ProviderAdapterRegistry.ts";
import { makeProviderFailure } from "@t3tools/provider-core/server/failure";
import {
  CLAUDE_MODEL_SELECTION,
  CODEX_MODEL_SELECTION,
  GROK_MODEL_SELECTION,
} from "./fixtures/shared.ts";
import * as ProviderReplayHarness from "./ProviderReplayHarness.ts";
import { checkpointWorkspace } from "@t3tools/provider-testing/replayWorkspace";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";

export const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

export const threadId = ThreadId.make("thread:provider-switch");

export const projectId = ProjectId.make("project:provider-switch");

export const CODEX_DRIVER = ProviderDriverKind.make("codex");

export const CLAUDE_DRIVER = ProviderDriverKind.make("claudeAgent");

export const GROK_DRIVER = ProviderDriverKind.make("acp");

export interface CapturedTurn {
  readonly driver: ProviderDriverKind;
  readonly threadId: ThreadId;
  readonly providerThreadId: ProviderThreadId;
  readonly text: string;
  readonly modelSelection: ModelSelection;
  readonly attachments: ReadonlyArray<ChatAttachment>;
  readonly nativeThreadId?: string | null;
  readonly providerTurnOrdinal?: number;
  readonly nativeThreadHasTurns?: boolean;
}

export function unimplemented(driver: ProviderDriverKind, detail: string) {
  return Effect.fail(new ProviderAdapter.ProviderAdapterProtocolError({ driver, detail }));
}

export function makeTestAdapter(input: {
  readonly instanceId: ProviderInstanceId;
  readonly driver: ProviderDriverKind;
  readonly capabilities: OrchestrationV2ProviderCapabilities;
  readonly modelSelection: ModelSelection;
  readonly responseByRunOrdinal: Readonly<Record<number, string>>;
  readonly responseByThreadId?: Readonly<Record<string, Readonly<Record<number, string>>>>;
  readonly capturedTurns: Ref.Ref<ReadonlyArray<CapturedTurn>>;
  readonly injectedHistory?: Ref.Ref<ReadonlyArray<unknown>>;
  readonly failStartOnce?: Ref.Ref<boolean>;
  readonly refuseStarts?: Ref.Ref<number>;
  readonly refusalCause?: unknown;
  readonly failInjectionOnce?: Ref.Ref<boolean>;
  readonly nativeThreadGeneration?: Ref.Ref<number>;
  readonly failResume?: boolean;
  readonly failResumeOnce?: Ref.Ref<boolean>;
  readonly initialContextUsage?: OrchestrationV2ProviderThread["contextUsage"];
  readonly getModelContextWindow?: (selection: ModelSelection) => number | undefined;
  readonly canReuseContextUsage?: ProviderAdapter.ProviderAdapterV2SessionRuntime["canReuseContextUsage"];
  readonly tokenUsageByRunOrdinal?: Readonly<
    Record<number, Omit<OrchestrationV2ProviderTurnTokenUsage, "updatedAt">>
  >;
  readonly failure?: ReturnType<typeof makeProviderFailure>;
  readonly failedRunOrdinals?: ReadonlySet<number>;
  readonly interruptedRunOrdinals?: ReadonlySet<number>;
  readonly holdRunOrdinal?: number;
  readonly pendingBackgroundWork?: Ref.Ref<boolean>;
  readonly subagentOnlyBackgroundWork?: boolean;
  readonly holdFirstTurn?: Deferred.Deferred<void>;
  readonly releaseFirstTurn?: Deferred.Deferred<void>;
  readonly backgroundWork?: Ref.Ref<boolean>;
  readonly closedSessions?: Ref.Ref<ReadonlyArray<string>>;
}): ProviderAdapter.ProviderAdapterV2["Service"] {
  return {
    instanceId: input.instanceId,
    driver: input.driver,
    getCapabilities: () => Effect.succeed(input.capabilities),
    planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
    openSession: (sessionInput) =>
      Effect.gen(function* () {
        const events = yield* PubSub.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
        if (input.closedSessions !== undefined) {
          const closedSessions = input.closedSessions;
          yield* Effect.addFinalizer(() =>
            Ref.update(closedSessions, (ids) => [...ids, sessionInput.providerSessionId]),
          );
        }
        const now = yield* DateTime.now;
        const providerSession: OrchestrationV2ProviderSession = {
          id: sessionInput.providerSessionId,
          driver: input.driver,
          providerInstanceId: input.instanceId,
          status: "ready",
          cwd: sessionInput.runtimePolicy.cwd ?? process.cwd(),
          model: input.modelSelection.model,
          capabilities: input.capabilities,
          createdAt: now,
          updatedAt: now,
          lastError: null,
        };

        const runtime: ProviderAdapter.ProviderAdapterV2SessionRuntime = {
          instanceId: input.instanceId,
          driver: input.driver,
          providerSessionId: sessionInput.providerSessionId,
          providerSession,
          events: Stream.fromPubSub(events),
          ...(input.pendingBackgroundWork === undefined
            ? {}
            : {
                hasPendingBackgroundWorkForThread: (_thread, options) =>
                  input.subagentOnlyBackgroundWork && options?.includeSubagents !== true
                    ? Effect.succeed(false)
                    : Ref.get(input.pendingBackgroundWork!),
              }),
          ...(input.getModelContextWindow === undefined
            ? {}
            : { getModelContextWindow: input.getModelContextWindow }),
          ...(input.canReuseContextUsage === undefined
            ? {}
            : { canReuseContextUsage: input.canReuseContextUsage }),
          ...(input.backgroundWork === undefined
            ? {}
            : {
                // Like Claude: native subagents are visible only to the session-wide
                // probe, never to the per-thread roster probe.
                hasPendingBackgroundWork: Ref.get(input.backgroundWork),
                hasPendingBackgroundWorkForThread: () => Effect.succeed(false),
              }),
          ensureThread: (threadInput) =>
            Effect.gen(function* () {
              const createdAt = yield* DateTime.now;
              const generation =
                input.nativeThreadGeneration === undefined
                  ? ""
                  : `:${yield* Ref.getAndUpdate(input.nativeThreadGeneration, (value) => value + 1)}`;
              const nativeThreadId = `${input.driver}:${threadInput.threadId}${generation}`;
              return {
                id: ProviderThreadId.make(`provider-thread:${nativeThreadId}`),
                driver: input.driver,
                providerInstanceId: input.instanceId,
                providerSessionId: sessionInput.providerSessionId,
                appThreadId: threadInput.threadId,
                ownerNodeId: null,
                nativeThreadRef: {
                  driver: input.driver,
                  nativeId: nativeThreadId,
                  strength: "strong",
                },
                nativeConversationHeadRef: null,
                status: "idle",
                firstRunOrdinal: null,
                lastRunOrdinal: null,
                handoffIds: [],
                contextUsage: input.initialContextUsage ?? null,
                forkedFrom: null,
                createdAt,
                updatedAt: createdAt,
              } satisfies OrchestrationV2ProviderThread;
            }),
          resumeThread: ({ providerThread }) =>
            Effect.gen(function* () {
              if (
                input.failResume ||
                (input.failResumeOnce !== undefined &&
                  (yield* Ref.getAndSet(input.failResumeOnce, false)))
              )
                return yield* unimplemented(input.driver, "simulated native resume failure");
              return providerThread;
            }),
          ...(input.injectedHistory === undefined
            ? {}
            : {
                injectHistory: (history: ProviderAdapter.ProviderAdapterV2HistoricalContext) =>
                  Ref.update(input.injectedHistory!, (current) => [
                    ...current,
                    ...historyResponseItems(history.messages, history.context),
                  ]).pipe(
                    Effect.andThen(
                      Effect.gen(function* () {
                        if (
                          input.failInjectionOnce !== undefined &&
                          (yield* Ref.getAndSet(input.failInjectionOnce, false))
                        )
                          return yield* unimplemented(
                            input.driver,
                            "lost injection acknowledgement",
                          );
                        return true;
                      }),
                    ),
                  ),
              }),
          compactThread: (turnInput) => runtime.startTurn(turnInput),
          startTurn: (turnInput) =>
            Effect.gen(function* () {
              if (
                input.failStartOnce !== undefined &&
                (yield* Ref.getAndSet(input.failStartOnce, false))
              )
                return yield* unimplemented(input.driver, "turn start failed after injection");
              if (
                input.refuseStarts !== undefined &&
                (yield* Ref.getAndUpdate(input.refuseStarts, (left) => Math.max(0, left - 1))) > 0
              )
                return yield* new ProviderAdapter.ProviderAdapterTurnStartError({
                  driver: input.driver,
                  threadId: turnInput.threadId,
                  providerThreadId: turnInput.providerThread.id,
                  runId: turnInput.runId,
                  cause:
                    input.refusalCause ?? new ClaudeBackgroundWorkBlocksQueryReplacementError(),
                });
              yield* Effect.yieldNow;
              yield* Ref.update(input.capturedTurns, (turns) => [
                ...turns,
                {
                  driver: input.driver,
                  threadId: turnInput.threadId,
                  providerThreadId: turnInput.providerThread.id,
                  text: turnInput.message.text,
                  modelSelection: turnInput.modelSelection,
                  attachments: turnInput.message.attachments,
                  nativeThreadId: turnInput.providerThread.nativeThreadRef?.nativeId ?? null,
                  providerTurnOrdinal: turnInput.providerTurnOrdinal,
                  ...(turnInput.nativeThreadHasTurns === undefined
                    ? {}
                    : { nativeThreadHasTurns: turnInput.nativeThreadHasTurns }),
                },
              ]);
              if (
                turnInput.runOrdinal === (input.holdRunOrdinal ?? 1) &&
                input.holdFirstTurn !== undefined
              ) {
                yield* Deferred.succeed(input.holdFirstTurn, undefined);
                if (input.releaseFirstTurn === undefined) return;
                yield* Deferred.await(input.releaseFirstTurn);
              }
              const eventTime = yield* DateTime.now;
              const providerTurnId = ProviderTurnId.make(
                `provider-turn:${input.driver}:${turnInput.threadId}:${turnInput.runOrdinal}`,
              );
              const terminalStatus = input.failedRunOrdinals?.has(turnInput.runOrdinal)
                ? "failed"
                : input.interruptedRunOrdinals?.has(turnInput.runOrdinal)
                  ? "interrupted"
                  : "completed";
              const response =
                input.responseByThreadId?.[turnInput.threadId]?.[turnInput.runOrdinal] ??
                input.responseByRunOrdinal[turnInput.runOrdinal] ??
                `${input.driver} response for run ${turnInput.runOrdinal}`;
              const providerEvents: ReadonlyArray<ProviderAdapter.ProviderAdapterV2Event> = [
                {
                  type: "provider_turn.updated",
                  driver: input.driver,
                  providerTurn: {
                    id: providerTurnId,
                    providerThreadId: turnInput.providerThread.id,
                    nodeId: turnInput.rootNodeId,
                    runAttemptId: turnInput.attemptId,
                    nativeTurnRef: {
                      driver: input.driver,
                      nativeId: `native-turn:${turnInput.threadId}:${turnInput.runOrdinal}`,
                      strength: "strong",
                    },
                    ordinal: turnInput.runOrdinal,
                    status: terminalStatus,
                    startedAt: eventTime,
                    completedAt: eventTime,
                  },
                },
                {
                  type: "turn_item.updated",
                  driver: input.driver,
                  turnItem: {
                    id: TurnItemId.make(
                      `turn-item:${input.driver}:${turnInput.threadId}:${turnInput.runOrdinal}:assistant`,
                    ),
                    threadId: turnInput.threadId,
                    runId: turnInput.runId,
                    nodeId: turnInput.rootNodeId,
                    providerThreadId: turnInput.providerThread.id,
                    providerTurnId,
                    nativeItemRef: null,
                    parentItemId: null,
                    ordinal: turnInput.runOrdinal * 100 + 1,
                    status: terminalStatus,
                    title: null,
                    startedAt: eventTime,
                    completedAt: eventTime,
                    updatedAt: eventTime,
                    type: "assistant_message",
                    messageId: MessageId.make(
                      `message:${input.driver}:${turnInput.threadId}:${turnInput.runOrdinal}:assistant`,
                    ),
                    text: response,
                    streaming: false,
                  },
                },
                {
                  type: "turn.terminal",
                  driver: input.driver,
                  providerThreadId: turnInput.providerThread.id,
                  providerTurnId,
                  runOrdinal: turnInput.runOrdinal,
                  ...(terminalStatus === "failed"
                    ? {
                        status: terminalStatus,
                        failureItemOrdinal: turnInput.runOrdinal * 100 + 2,
                        failure:
                          input.failure ??
                          makeProviderFailure({
                            message: "Simulated provider failure.",
                            code: "simulated_failure",
                            class: "provider_error",
                          }),
                      }
                    : { status: terminalStatus, failure: null }),
                  threadDisposition: "reusable",
                },
              ];
              const reportedUsage = input.tokenUsageByRunOrdinal?.[turnInput.runOrdinal];
              const turnEvent = providerEvents[0];
              if (reportedUsage && turnEvent?.type === "provider_turn.updated") {
                yield* PubSub.publish(events, {
                  ...turnEvent,
                  providerTurn: {
                    ...turnEvent.providerTurn,
                    status: "running",
                    completedAt: null,
                    tokenUsage: { ...reportedUsage, updatedAt: DateTime.formatIso(eventTime) },
                  },
                });
              }
              for (const event of providerEvents) {
                yield* PubSub.publish(events, event);
              }
            }),
          steerTurn: () => Effect.void,
          interruptTurn: () => Effect.void,
          respondToRuntimeRequest: () => Effect.void,
          readThreadSnapshot: () =>
            unimplemented(input.driver, "readThreadSnapshot unused in provider switch test"),
          rollbackThread: () =>
            unimplemented(input.driver, "rollbackThread unused in provider switch test"),
          forkThread: () =>
            unimplemented(input.driver, "forkThread unused in provider switch test"),
        };
        return runtime;
      }),
  };
}

export const waitForIdle = Effect.fn("ProviderSwitchTest.waitForIdle")(function* (
  targetThreadId: ThreadId,
) {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const eventSink = yield* EventSink.EventSinkV2;
  const isIdle = (projection: OrchestrationV2ThreadProjection) =>
    projection.runs.every(
      (run) => !["queued", "starting", "running", "waiting"].includes(run.status),
    );
  const afterSequence = yield* eventSink.latestSequence();
  const current = yield* orchestrator.getThreadProjection(targetThreadId);
  if (isIdle(current)) {
    return current;
  }
  // Projections commit with their events, so each later event is the only time to re-read.
  const [idle] = yield* eventSink.stream({ afterSequence }).pipe(
    Stream.mapEffect(() => orchestrator.getThreadProjection(targetThreadId)),
    Stream.filter(isIdle),
    Stream.take(1),
    Stream.runCollect,
  );
  if (idle === undefined) {
    return yield* Effect.die(
      new Error("Provider switch test event stream ended before the thread went idle"),
    );
  }
  return idle;
});

export class ClaudeMcpRegistrationTimeoutError extends Schema.TaggedError<ClaudeMcpRegistrationTimeoutError>()(
  "ClaudeMcpRegistrationTimeoutError",
  {},
) {}
