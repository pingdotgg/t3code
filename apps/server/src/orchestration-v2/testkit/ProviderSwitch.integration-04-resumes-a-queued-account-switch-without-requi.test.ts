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

import {
  CLAUDE_DRIVER,
  CODEX_DRIVER,
  ClaudeMcpRegistrationTimeoutError,
  GROK_DRIVER,
  encodeJson,
  makeTestAdapter,
  projectId,
  threadId,
  unimplemented,
  waitForIdle,
} from "./ProviderSwitch.integration-fixtures.testkit.ts";
import type { CapturedTurn } from "./ProviderSwitch.integration-fixtures.testkit.ts";

describe("orchestration v2 provider switching", () => {
  it.live("resumes a queued account switch without requiring a portable handoff", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const cwd = yield* checkpointWorkspace("queued-account-switch");
        const capturedTurns = yield* Ref.make<ReadonlyArray<CapturedTurn>>([]);
        const started = yield* Deferred.make<void>();
        const alternateSelection: ModelSelection = {
          ...CODEX_MODEL_SELECTION,
          instanceId: ProviderInstanceId.make("codex-alternate"),
        };
        const alternateCapabilities = {
          ...CodexProviderCapabilitiesV2,
          canConsumeHandoffSummaries: false,
        };
        const adapters = [
          makeTestAdapter({
            instanceId: CODEX_MODEL_SELECTION.instanceId,
            driver: CODEX_DRIVER,
            capabilities: CodexProviderCapabilitiesV2,
            modelSelection: CODEX_MODEL_SELECTION,
            responseByRunOrdinal: {},
            capturedTurns,
            holdFirstTurn: started,
          }),
          makeTestAdapter({
            instanceId: alternateSelection.instanceId,
            driver: CODEX_DRIVER,
            capabilities: alternateCapabilities,
            modelSelection: alternateSelection,
            responseByRunOrdinal: { 2: "Alternate account complete" },
            capturedTurns,
          }),
        ];
        const layerRegistry = Layer.succeed(
          ProviderAdapterRegistry.ProviderAdapterRegistryV2,
          ProviderAdapterRegistry.ProviderAdapterRegistryV2.of({
            get: (instanceId) => {
              const adapter = adapters.find((candidate) => candidate.instanceId === instanceId);
              return adapter === undefined
                ? Effect.fail(
                    new ProviderAdapterRegistry.ProviderAdapterRegistryLookupError({ instanceId }),
                  )
                : Effect.succeed(adapter);
            },
            list: () => Effect.succeed(adapters.map((adapter) => adapter.instanceId)),
            getMetadata: (instanceId) => {
              const adapter = adapters.find((candidate) => candidate.instanceId === instanceId);
              return adapter === undefined
                ? Effect.fail(
                    new ProviderAdapterRegistry.ProviderAdapterRegistryLookupError({ instanceId }),
                  )
                : Effect.succeed({
                    driver: CODEX_DRIVER,
                    continuationKey: "codex:shared-native-account-history",
                    enabled: true,
                    capabilities:
                      instanceId === alternateSelection.instanceId
                        ? alternateCapabilities
                        : CodexProviderCapabilitiesV2,
                  });
            },
          }),
        );
        const queuedThreadId = ThreadId.make("thread:queued-account-switch");
        const projection = yield* Effect.gen(function* () {
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const eventSink = yield* EventSink.EventSinkV2;
          const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
          yield* orchestrator.dispatch({
            type: "thread.create",
            createdBy: "user",
            creationSource: "web",
            commandId: CommandId.make("command:queued-account-switch:create"),
            threadId: queuedThreadId,
            projectId: ProjectId.make("project:queued-account-switch"),
            title: "Queued account switch",
            modelSelection: CODEX_MODEL_SELECTION,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: cwd,
          });
          yield* orchestrator.dispatch({
            type: "message.dispatch",
            createdBy: "user",
            creationSource: "web",
            commandId: CommandId.make("command:queued-account-switch:first"),
            threadId: queuedThreadId,
            messageId: MessageId.make("message:queued-account-switch:first"),
            text: "First account turn",
            attachments: [],
            modelSelection: CODEX_MODEL_SELECTION,
            dispatchMode: { type: "start_immediately" },
          });
          yield* Deferred.await(started);
          yield* orchestrator.dispatch({
            type: "message.dispatch",
            createdBy: "user",
            creationSource: "web",
            commandId: CommandId.make("command:queued-account-switch:second"),
            threadId: queuedThreadId,
            messageId: MessageId.make("message:queued-account-switch:second"),
            text: "Alternate account turn",
            attachments: [],
            modelSelection: alternateSelection,
            dispatchMode: { type: "queue_after_active" },
          });
          const queued = yield* orchestrator.getThreadProjection(queuedThreadId);
          assert.deepEqual(
            queued.runs.map((run) => run.status),
            ["running", "queued"],
          );
          assert.equal(queued.thread.providerInstanceId, CODEX_MODEL_SELECTION.instanceId);
          const sourceNativeRef = queued.providerThreads.find(
            (providerThread) => providerThread.id === queued.runs[0]?.providerThreadId,
          )?.nativeThreadRef;
          assert.isNotNull(sourceNativeRef);
          const now = yield* DateTime.now;
          yield* eventSink.write({
            events: [
              {
                id: EventId.make("event:queued-account-switch:first-complete"),
                type: "run.updated",
                threadId: queuedThreadId,
                runId: queued.runs[0]!.id,
                providerInstanceId: CODEX_MODEL_SELECTION.instanceId,
                occurredAt: now,
                payload: { ...queued.runs[0]!, status: "completed", completedAt: now },
              },
            ],
          });
          yield* orchestrator.resumeQueuedRuns;
          yield* orchestrator.streamStoredEvents.pipe(
            Stream.filter(
              (event) =>
                event.event.type === "run.updated" &&
                event.event.runId === queued.runs[1]?.id &&
                event.event.payload.status === "completed",
            ),
            Stream.runHead,
          );
          yield* worker.drain();
          const delivered = yield* orchestrator.getThreadProjection(queuedThreadId);
          const targetNativeRef = delivered.providerThreads.find(
            (providerThread) => providerThread.id === delivered.runs[1]?.providerThreadId,
          )?.nativeThreadRef;
          assert.deepEqual(targetNativeRef, sourceNativeRef);
          return delivered;
        }).pipe(
          Effect.provide(
            ProviderReplayHarness.layerWithRegistry(
              {
                name: "queued-account-switch",
                runtimePolicyOverride: {
                  cwd,
                  approvalPolicy: "never",
                  sandboxPolicy: {
                    type: "readOnly",
                    access: { type: "fullAccess" },
                    networkAccess: false,
                  },
                },
              },
              layerRegistry,
            ),
          ),
        );
        assert.deepEqual(
          projection.runs.map((run) => [run.providerInstanceId, run.status]),
          [
            [CODEX_MODEL_SELECTION.instanceId, "completed"],
            [alternateSelection.instanceId, "completed"],
          ],
        );
        assert.lengthOf(projection.contextHandoffs, 0);
        assert.deepEqual(
          (yield* Ref.get(capturedTurns)).map((turn) => turn.text),
          ["First account turn", "Alternate account turn"],
        );
      }),
    ),
  );

  it.live("finishes earlier queued Codex turns before handing context to queued Claude", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const cwd = yield* checkpointWorkspace("queued-provider-switch");
        const capturedTurns = yield* Ref.make<ReadonlyArray<CapturedTurn>>([]);
        const started = yield* Deferred.make<void>();
        const layerRegistry = ProviderAdapterRegistry.layerFromAdapters([
          makeTestAdapter({
            instanceId: ProviderInstanceId.make("codex"),
            driver: CODEX_DRIVER,
            capabilities: CodexProviderCapabilitiesV2,
            modelSelection: CODEX_MODEL_SELECTION,
            responseByRunOrdinal: {
              1: "Codex current turn complete",
              2: "Codex first queued turn complete",
              3: "Codex second queued turn complete",
            },
            capturedTurns,
            holdFirstTurn: started,
          }),
          makeTestAdapter({
            instanceId: ProviderInstanceId.make("claudeAgent"),
            driver: CLAUDE_DRIVER,
            capabilities: ClaudeProviderCapabilitiesV2,
            modelSelection: CLAUDE_MODEL_SELECTION,
            responseByRunOrdinal: { 4: "Claude turn complete" },
            capturedTurns,
          }),
        ]);
        const queuedThreadId = ThreadId.make("thread:queued-provider-switch");
        const layerDatabase = SqlitePersistence.layerMemory;
        const layerOutboxProvided = EffectOutbox.layer.pipe(Layer.provide(layerDatabase));
        const projection = yield* Effect.gen(function* () {
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
          const eventSink = yield* EventSink.EventSinkV2;
          const effectOutbox = yield* EffectOutbox.EffectOutboxV2;
          const dispatch = (ordinal: number, modelSelection: ModelSelection) =>
            orchestrator.dispatch({
              type: "message.dispatch",
              createdBy: "user",
              creationSource: "web",
              commandId: CommandId.make(`command:queued-provider-switch:${ordinal}`),
              threadId: queuedThreadId,
              messageId: MessageId.make(`message:queued-provider-switch:${ordinal}`),
              text: `Prompt ${ordinal}`,
              attachments: [],
              modelSelection,
              dispatchMode: {
                type: ordinal === 1 ? "start_immediately" : "queue_after_active",
              },
            });
          yield* orchestrator.dispatch({
            type: "thread.create",
            createdBy: "user",
            creationSource: "web",
            commandId: CommandId.make("command:queued-provider-switch:create"),
            threadId: queuedThreadId,
            projectId: ProjectId.make("project:queued-provider-switch"),
            title: "Queued provider switch",
            modelSelection: CODEX_MODEL_SELECTION,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: cwd,
          });
          yield* dispatch(1, CODEX_MODEL_SELECTION);
          yield* Deferred.await(started);
          yield* dispatch(2, CODEX_MODEL_SELECTION);
          yield* dispatch(3, CODEX_MODEL_SELECTION);
          yield* dispatch(4, CLAUDE_MODEL_SELECTION);
          const queued = yield* orchestrator.getThreadProjection(queuedThreadId);
          assert.deepEqual(
            queued.runs.map((run) => run.status),
            ["running", "queued", "queued", "queued"],
          );
          assert.equal(queued.thread.activeProviderThreadId, queued.runs[0]?.providerThreadId);
          assert.equal(queued.thread.providerInstanceId, CODEX_MODEL_SELECTION.instanceId);
          assert.lengthOf(queued.contextHandoffs, 0);
          const activeSession = queued.providerSessions.find(
            (session) => session.providerInstanceId === CODEX_MODEL_SELECTION.instanceId,
          );
          assert.isDefined(activeSession);
          const now = yield* DateTime.now;
          yield* eventSink.write({
            events: [
              ...(["stopped", "error"] as const).map((status) => ({
                id: EventId.make(`event:queued-provider-switch:dead-session:${status}`),
                type: "provider-session.updated" as const,
                threadId: queuedThreadId,
                providerInstanceId: CODEX_MODEL_SELECTION.instanceId,
                occurredAt: now,
                payload: {
                  ...activeSession!,
                  id: ProviderSessionId.make(`provider-session:queued-provider-switch:${status}`),
                  status,
                },
              })),
              {
                id: EventId.make("event:queued-provider-switch:first-response"),
                type: "turn-item.updated",
                threadId: queuedThreadId,
                runId: queued.runs[0]!.id,
                nodeId: queued.runs[0]!.rootNodeId!,
                providerInstanceId: CODEX_MODEL_SELECTION.instanceId,
                occurredAt: now,
                payload: {
                  id: TurnItemId.make("turn-item:queued-provider-switch:first-response"),
                  threadId: queuedThreadId,
                  runId: queued.runs[0]!.id,
                  nodeId: queued.runs[0]!.rootNodeId!,
                  providerThreadId: queued.runs[0]!.providerThreadId,
                  providerTurnId: null,
                  nativeItemRef: null,
                  parentItemId: null,
                  ordinal: 101,
                  status: "completed",
                  title: null,
                  startedAt: now,
                  completedAt: now,
                  updatedAt: now,
                  type: "assistant_message",
                  messageId: MessageId.make("message:queued-provider-switch:first-response"),
                  text: "Codex current turn complete",
                  streaming: false,
                },
              },
              {
                id: EventId.make("event:queued-provider-switch:first-complete"),
                type: "run.updated",
                threadId: queuedThreadId,
                runId: queued.runs[0]!.id,
                providerInstanceId: CODEX_MODEL_SELECTION.instanceId,
                occurredAt: now,
                payload: { ...queued.runs[0]!, status: "completed", completedAt: now },
              },
            ],
          });
          yield* orchestrator.resumeQueuedRuns;
          yield* orchestrator.streamStoredEvents.pipe(
            Stream.filter(
              (event) =>
                event.event.type === "run.updated" &&
                event.event.runId === queued.runs[3]?.id &&
                event.event.payload.status === "completed",
            ),
            Stream.runHead,
          );
          yield* worker.drain();
          const detachEvents = yield* eventSink.stream({ threadId: queuedThreadId }).pipe(
            Stream.filter((stored) => stored.event.type === "provider-session.detached"),
            Stream.take(1),
            Stream.runCollect,
          );
          assert.equal(
            detachEvents[0]?.event.type === "provider-session.detached"
              ? detachEvents[0].event.payload.providerSessionId
              : null,
            activeSession?.id,
          );
          const startCommandId = CommandId.make(
            `command:system:start-queued:${queued.runs[3]!.id}`,
          );
          const detachEffects = (yield* effectOutbox.listByCommandId(startCommandId)).filter(
            (effect) => effect.request.type === "provider-session.detach",
          );
          assert.deepEqual(
            detachEffects.map((effect) =>
              effect.request.type === "provider-session.detach"
                ? effect.request.providerSessionId
                : null,
            ),
            [activeSession?.id],
          );
          return yield* orchestrator.getThreadProjection(queuedThreadId);
        }).pipe(
          Effect.provide(
            Layer.merge(
              ProviderReplayHarness.layerWithRegistry(
                {
                  name: "queued-provider-switch",
                  runtimePolicyOverride: {
                    cwd,
                    approvalPolicy: "never",
                    sandboxPolicy: {
                      type: "readOnly",
                      access: { type: "fullAccess" },
                      networkAccess: false,
                    },
                  },
                },
                layerRegistry,
                { databaseLayer: layerDatabase },
              ),
              layerOutboxProvided,
            ),
          ),
        );
        const turns = yield* Ref.get(capturedTurns);
        assert.deepEqual(
          projection.runs.map((run) => [run.providerInstanceId, run.status]),
          [
            ["codex", "completed"],
            ["codex", "completed"],
            ["codex", "completed"],
            ["claudeAgent", "completed"],
          ],
        );
        assert.deepEqual(
          turns.map((turn) => [turn.driver, turn.text.includes("Prompt 4")]),
          [
            ["codex", false],
            ["codex", false],
            ["codex", false],
            ["claudeAgent", true],
          ],
        );
        assert.lengthOf(projection.contextHandoffs, 1);
        assert.equal(projection.contextHandoffs[0]?.targetRunId, projection.runs[3]?.id);
        const handoffItem = projection.turnItems.find(
          (item) => item.type === "handoff" && item.runId === projection.runs[3]?.id,
        );
        assert.equal(
          handoffItem?.type === "handoff" ? handoffItem.contextHandoffId : null,
          projection.contextHandoffs[0]?.id,
        );
        const queuedUserItem = projection.turnItems.find(
          (item) => item.type === "user_message" && item.runId === projection.runs[3]?.id,
        );
        assert.isBelow(handoffItem?.ordinal ?? Infinity, queuedUserItem?.ordinal ?? -Infinity);
        assert.include(
          handoffItem?.type === "handoff" ? handoffItem.summary : "",
          "Codex second queued turn complete",
        );
        assert.include(turns[3]?.text ?? "", "Codex current turn complete");
        assert.include(turns[3]?.text ?? "", "Codex first queued turn complete");
        assert.include(turns[3]?.text ?? "", "Codex second queued turn complete");
      }),
    ),
  );

  it.live.each([
    [
      "detaches the previous instance's session when a send hands off to another instance",
      { background: false, queued: false, sharedHistory: false },
    ],
    [
      "refuses the hand-off while the previous instance still runs background work",
      { background: true, queued: false, sharedHistory: false },
    ],
    [
      "keeps a busy previous session running when a queued hand-off starts",
      { background: true, queued: true, sharedHistory: false },
    ],
    [
      "holds a queued account switch while the replaced session still runs background work",
      { background: true, queued: true, sharedHistory: true },
    ],
  ] as const)("%s", ([, { background, queued, sharedHistory }]) =>
    Effect.scoped(
      Effect.gen(function* () {
        const cwd = yield* checkpointWorkspace("handoff-releases-session");
        const capturedTurns = yield* Ref.make<ReadonlyArray<CapturedTurn>>([]);
        const backgroundWork = yield* Ref.make(background);
        const closedSessions = yield* Ref.make<ReadonlyArray<string>>([]);
        const firstStarted = yield* Deferred.make<void>();
        const releaseFirst = yield* Deferred.make<void>();
        const secondSelection: ModelSelection = {
          ...CLAUDE_MODEL_SELECTION,
          instanceId: ProviderInstanceId.make("claude-second-account"),
        };
        const adapters = [
          makeTestAdapter({
            instanceId: CLAUDE_MODEL_SELECTION.instanceId,
            driver: CLAUDE_DRIVER,
            capabilities: ClaudeProviderCapabilitiesV2,
            modelSelection: CLAUDE_MODEL_SELECTION,
            responseByRunOrdinal: { 1: "First account complete" },
            capturedTurns,
            backgroundWork,
            closedSessions,
            ...(queued ? { holdFirstTurn: firstStarted, releaseFirstTurn: releaseFirst } : {}),
          }),
          makeTestAdapter({
            instanceId: secondSelection.instanceId,
            driver: CLAUDE_DRIVER,
            capabilities: ClaudeProviderCapabilitiesV2,
            modelSelection: secondSelection,
            responseByRunOrdinal: { 2: "Second account complete" },
            capturedTurns,
          }),
        ];
        // Without a shared continuation key, each Claude instance owns its own native history.
        const layerRegistry = sharedHistory
          ? Layer.succeed(
              ProviderAdapterRegistry.ProviderAdapterRegistryV2,
              ProviderAdapterRegistry.ProviderAdapterRegistryV2.of({
                get: (instanceId) => {
                  const adapter = adapters.find((candidate) => candidate.instanceId === instanceId);
                  return adapter === undefined
                    ? Effect.fail(
                        new ProviderAdapterRegistry.ProviderAdapterRegistryLookupError({
                          instanceId,
                        }),
                      )
                    : Effect.succeed(adapter);
                },
                list: () => Effect.succeed(adapters.map((adapter) => adapter.instanceId)),
                getMetadata: () =>
                  Effect.succeed({
                    driver: CLAUDE_DRIVER,
                    continuationKey: "claude:shared-native-account-history",
                    enabled: true,
                    capabilities: ClaudeProviderCapabilitiesV2,
                  }),
              }),
            )
          : ProviderAdapterRegistry.layerFromAdapters(adapters);
        const handoffThreadId = ThreadId.make("thread:handoff-releases-session");
        yield* Effect.gen(function* () {
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
          const send = (ordinal: number, modelSelection: ModelSelection, attempt = "") =>
            orchestrator.dispatch({
              type: "message.dispatch",
              createdBy: "user",
              creationSource: "web",
              commandId: CommandId.make(`command:handoff-releases-session:${ordinal}${attempt}`),
              threadId: handoffThreadId,
              messageId: MessageId.make(`message:handoff-releases-session:${ordinal}${attempt}`),
              text: `Prompt ${ordinal}`,
              attachments: [],
              modelSelection,
              dispatchMode: { type: queued ? "queue_after_active" : "start_immediately" },
            });
          yield* orchestrator.dispatch({
            type: "thread.create",
            createdBy: "user",
            creationSource: "web",
            commandId: CommandId.make("command:handoff-releases-session:create"),
            threadId: handoffThreadId,
            projectId: ProjectId.make("project:handoff-releases-session"),
            title: "Handoff releases session",
            modelSelection: CLAUDE_MODEL_SELECTION,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: cwd,
          });
          yield* send(1, CLAUDE_MODEL_SELECTION);

          if (queued) {
            yield* Deferred.await(firstStarted);
            yield* send(2, secondSelection);
            const queuedRunId = (yield* orchestrator.getThreadProjection(handoffThreadId)).runs[1]
              ?.id;
            assert.isDefined(queuedRunId);
            yield* Deferred.succeed(releaseFirst, undefined);
            yield* orchestrator.streamStoredEvents.pipe(
              Stream.filter(
                ({ event }) =>
                  event.type === "run.updated" &&
                  event.runId === queuedRunId &&
                  (event.payload.queueHeld === true || event.payload.status === "completed"),
              ),
              Stream.runHead,
            );
            yield* worker.drain();
            const afterQueue = yield* orchestrator.getThreadProjection(handoffThreadId);
            const firstSession = afterQueue.providerSessions.find(
              (session) => session.providerInstanceId === CLAUDE_MODEL_SELECTION.instanceId,
            );
            // Detaching would end the background agents, so the busy session must stay up.
            assert.deepEqual(yield* Ref.get(closedSessions), []);
            assert.equal(firstSession?.status, "ready");
            if (!sharedHistory) {
              assert.deepEqual(
                afterQueue.runs.map((run) => [run.providerInstanceId, run.status]),
                [
                  [CLAUDE_MODEL_SELECTION.instanceId, "completed"],
                  [secondSelection.instanceId, "completed"],
                ],
              );
              return;
            }
            // Resuming the native thread beside the busy session would fork its history.
            assert.deepEqual(
              afterQueue.runs.map((run) => [run.status, run.queueHeld === true]),
              [
                ["completed", false],
                ["queued", true],
              ],
            );
            assert.lengthOf(yield* Ref.get(capturedTurns), 1);
            yield* Ref.set(backgroundWork, false);
            yield* orchestrator.dispatch({
              type: "queue.resume",
              commandId: CommandId.make("command:handoff-releases-session:resume"),
              threadId: handoffThreadId,
            });
            yield* worker.drain();
            const resumed = yield* waitForIdle(handoffThreadId);
            assert.deepEqual(
              resumed.runs.map((run) => [run.providerInstanceId, run.status]),
              [
                [CLAUDE_MODEL_SELECTION.instanceId, "completed"],
                [secondSelection.instanceId, "completed"],
              ],
            );
            assert.deepEqual(yield* Ref.get(closedSessions), [firstSession!.id]);
            return;
          }

          yield* worker.drain();
          const afterFirst = yield* waitForIdle(handoffThreadId);
          const firstSession = afterFirst.providerSessions.find(
            (session) => session.providerInstanceId === CLAUDE_MODEL_SELECTION.instanceId,
          );
          assert.equal(firstSession?.status, "ready");

          if (background) {
            // Native subagents live only in the adapter's roster, so the projection's
            // pendingBackgroundTasks stays empty while the probe still reports work.
            assert.deepEqual(afterFirst.providerThreads[0]?.pendingBackgroundTasks ?? [], []);
            const refused = yield* send(2, secondSelection, ":refused").pipe(Effect.flip);
            assert.include(String(refused.cause), "still running background agents or commands");
            const unchanged = yield* orchestrator.getThreadProjection(handoffThreadId);
            assert.lengthOf(unchanged.runs, 1);
            assert.deepEqual(yield* Ref.get(closedSessions), []);
            assert.equal(unchanged.thread.providerInstanceId, CLAUDE_MODEL_SELECTION.instanceId);
            assert.deepEqual(
              unchanged.providerSessions.map((session) => [session.id, session.status]),
              [[firstSession!.id, "ready"]],
            );
            yield* Ref.set(backgroundWork, false);
          }

          yield* send(2, secondSelection);
          yield* worker.drain();
          const afterSecond = yield* waitForIdle(handoffThreadId);
          yield* worker.drain();
          const projection = yield* orchestrator.getThreadProjection(handoffThreadId);

          assert.deepEqual(
            projection.runs.map((run) => [run.providerInstanceId, run.status]),
            [
              [CLAUDE_MODEL_SELECTION.instanceId, "completed"],
              [secondSelection.instanceId, "completed"],
            ],
          );
          assert.lengthOf(afterSecond.contextHandoffs, 1);
          assert.deepEqual(
            projection.providerSessions.map((session) => session.providerInstanceId),
            [secondSelection.instanceId],
          );
          // The detached event alone hides the session; the runtime must also close.
          assert.deepEqual(yield* Ref.get(closedSessions), [firstSession!.id]);
        }).pipe(
          Effect.provide(
            ProviderReplayHarness.layerWithRegistry(
              {
                name: "handoff-releases-session",
                runtimePolicyOverride: {
                  cwd,
                  approvalPolicy: "never",
                  sandboxPolicy: {
                    type: "readOnly",
                    access: { type: "fullAccess" },
                    networkAccess: false,
                  },
                },
              },
              layerRegistry,
            ),
          ),
        );
      }),
    ),
  );
});
