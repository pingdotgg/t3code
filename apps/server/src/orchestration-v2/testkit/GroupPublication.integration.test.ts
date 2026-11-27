import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  type ModelSelection,
  type OrchestrationV2ProviderCapabilities,
  type OrchestrationV2ProviderSession,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2ThreadProjection,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
  RunId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import { historyResponseItems } from "@t3tools/provider-core/server/handoffBudget";
import { checkpointWorkspace } from "@t3tools/provider-testing/replayWorkspace";
import { createOrchestrationV2TurnItemVisibility } from "@t3tools/shared/orchestrationV2Timeline";
import { latestExecutedRun, latestUnheldRun } from "@t3tools/shared/orchestrationV2ThreadError";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import { ClaudeProviderCapabilitiesV2 } from "../Adapters/ClaudeAdapterV2.ts";
import { CodexProviderCapabilitiesV2 } from "../Adapters/CodexAdapterV2.ts";
import * as EffectWorker from "../EffectWorker.ts";
import * as EventSink from "../EventSink.ts";
import * as Orchestrator from "../Orchestrator.ts";
import * as ProjectStore from "../ProjectStore.ts";
import * as ProviderAdapterRegistry from "../ProviderAdapterRegistry.ts";
import * as ThreadSearch from "../ThreadSearch.ts";
import { CLAUDE_MODEL_SELECTION, CODEX_MODEL_SELECTION } from "./fixtures/shared.ts";
import * as ProviderReplayHarness from "./ProviderReplayHarness.ts";

const projectId = ProjectId.make("project:group-publication");
const PEER_TEXT = "PEERMARK prefers an event log";
const PEERS = [
  ["cross-instance", CLAUDE_MODEL_SELECTION],
  ["same-instance", CODEX_MODEL_SELECTION],
] as const;

interface CapturedTurn {
  readonly driver: ProviderDriverKind;
  readonly threadId: ThreadId;
  readonly text: string;
  readonly nativeThreadId: string | null;
}

interface HistoryItem {
  readonly role: string;
  readonly content: ReadonlyArray<{ readonly text: string }>;
}

function fakeAdapter(input: {
  readonly driver: string;
  readonly modelSelection: ModelSelection;
  readonly capabilities: OrchestrationV2ProviderCapabilities;
  readonly turns: Ref.Ref<ReadonlyArray<CapturedTurn>>;
  readonly injected?: Ref.Ref<ReadonlyArray<HistoryItem>>;
  readonly rollbackCalls: Ref.Ref<number>;
  readonly hold?: {
    readonly runOrdinal: number;
    readonly started: Deferred.Deferred<void>;
    readonly release: Deferred.Deferred<void>;
  };
}): ProviderAdapter.ProviderAdapterV2["Service"] {
  const driver = ProviderDriverKind.make(input.driver);
  const instanceId = ProviderInstanceId.make(input.modelSelection.instanceId);
  const unused = (detail: string) =>
    Effect.fail(new ProviderAdapter.ProviderAdapterProtocolError({ driver, detail }));
  return {
    instanceId,
    driver,
    getCapabilities: () => Effect.succeed(input.capabilities),
    planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
    openSession: (sessionInput) =>
      Effect.gen(function* () {
        const events = yield* PubSub.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
        const now = yield* DateTime.now;
        const providerSession: OrchestrationV2ProviderSession = {
          id: sessionInput.providerSessionId,
          driver,
          providerInstanceId: instanceId,
          status: "ready",
          cwd: sessionInput.runtimePolicy.cwd ?? process.cwd(),
          model: input.modelSelection.model,
          capabilities: input.capabilities,
          createdAt: now,
          updatedAt: now,
          lastError: null,
        };
        const runtime: ProviderAdapter.ProviderAdapterV2SessionRuntime = {
          instanceId,
          driver,
          providerSessionId: sessionInput.providerSessionId,
          providerSession,
          events: Stream.fromPubSub(events),
          ensureThread: (threadInput) =>
            Effect.gen(function* () {
              const createdAt = yield* DateTime.now;
              const nativeThreadId = `${input.driver}:${threadInput.threadId}`;
              return {
                id: ProviderThreadId.make(`provider-thread:${nativeThreadId}`),
                driver,
                providerInstanceId: instanceId,
                providerSessionId: sessionInput.providerSessionId,
                appThreadId: threadInput.threadId,
                ownerNodeId: null,
                nativeThreadRef: { driver, nativeId: nativeThreadId, strength: "strong" },
                nativeConversationHeadRef: null,
                status: "idle",
                firstRunOrdinal: null,
                lastRunOrdinal: null,
                handoffIds: [],
                forkedFrom: null,
                createdAt,
                updatedAt: createdAt,
              } satisfies OrchestrationV2ProviderThread;
            }),
          resumeThread: ({ providerThread }) => Effect.succeed(providerThread),
          ...(input.injected === undefined
            ? {}
            : {
                injectHistory: (history: ProviderAdapter.ProviderAdapterV2HistoricalContext) =>
                  Ref.update(input.injected!, (current) => [
                    ...current,
                    ...(historyResponseItems(
                      history.messages,
                      history.context,
                    ) as ReadonlyArray<HistoryItem>),
                  ]).pipe(Effect.as(true)),
              }),
          compactThread: (turnInput) => runtime.startTurn(turnInput),
          startTurn: (turnInput) =>
            Effect.gen(function* () {
              yield* Effect.yieldNow;
              yield* Ref.update(input.turns, (turns) => [
                ...turns,
                {
                  driver,
                  threadId: turnInput.threadId,
                  text: turnInput.message.text,
                  nativeThreadId: turnInput.providerThread.nativeThreadRef?.nativeId ?? null,
                },
              ]);
              if (turnInput.runOrdinal === input.hold?.runOrdinal) {
                yield* Deferred.succeed(input.hold.started, undefined);
                yield* Deferred.await(input.hold.release);
              }
              const eventTime = yield* DateTime.now;
              const providerTurnId = ProviderTurnId.make(
                `provider-turn:${input.driver}:${turnInput.threadId}:${turnInput.runOrdinal}`,
              );
              const providerEvents: ReadonlyArray<ProviderAdapter.ProviderAdapterV2Event> = [
                {
                  type: "provider_turn.updated",
                  driver,
                  providerTurn: {
                    id: providerTurnId,
                    providerThreadId: turnInput.providerThread.id,
                    nodeId: turnInput.rootNodeId,
                    runAttemptId: turnInput.attemptId,
                    nativeTurnRef: {
                      driver,
                      nativeId: `native-turn:${turnInput.threadId}:${turnInput.runOrdinal}`,
                      strength: "strong",
                    },
                    ordinal: turnInput.runOrdinal,
                    status: "completed",
                    startedAt: eventTime,
                    completedAt: eventTime,
                  },
                },
                {
                  type: "turn_item.updated",
                  driver,
                  turnItem: {
                    id: TurnItemId.make(
                      `turn-item:${input.driver}:${turnInput.threadId}:${turnInput.runOrdinal}`,
                    ),
                    threadId: turnInput.threadId,
                    runId: turnInput.runId,
                    nodeId: turnInput.rootNodeId,
                    providerThreadId: turnInput.providerThread.id,
                    providerTurnId,
                    nativeItemRef: null,
                    parentItemId: null,
                    ordinal: turnInput.runOrdinal * 100 + 1,
                    status: "completed",
                    title: null,
                    startedAt: eventTime,
                    completedAt: eventTime,
                    updatedAt: eventTime,
                    type: "assistant_message",
                    messageId: MessageId.make(
                      `message:${input.driver}:${turnInput.threadId}:${turnInput.runOrdinal}`,
                    ),
                    text: `Primary reply ${turnInput.runOrdinal}`,
                    streaming: false,
                  },
                },
                {
                  type: "turn.terminal",
                  driver,
                  providerThreadId: turnInput.providerThread.id,
                  providerTurnId,
                  runOrdinal: turnInput.runOrdinal,
                  status: "completed",
                  failure: null,
                  threadDisposition: "reusable",
                },
              ];
              for (const event of providerEvents) yield* PubSub.publish(events, event);
            }),
          steerTurn: () => Effect.void,
          interruptTurn: () => Effect.void,
          respondToRuntimeRequest: () => Effect.void,
          readThreadSnapshot: () => unused("readThreadSnapshot"),
          rollbackThread: ({ providerThread }) =>
            Ref.update(input.rollbackCalls, (calls) => calls + 1).pipe(
              Effect.as({ providerThread, providerTurns: [], messages: [], runtimeRequests: [] }),
            ),
          forkThread: () => unused("a publication run must never fork natively"),
        };
        return runtime;
      }),
  };
}

const makeHarness = Effect.fn("GroupPublicationTest.makeHarness")(function* (
  name: string,
  options: {
    /** Omit the primary's injectHistory, so context can only arrive inside the prompt. */
    readonly inlineOnly?: boolean;
    readonly primaryCapabilities?: OrchestrationV2ProviderCapabilities;
    readonly holdRunOrdinal?: number;
  } = {},
) {
  const cwd = yield* checkpointWorkspace(`group-publication-${name}`);
  const turns = yield* Ref.make<ReadonlyArray<CapturedTurn>>([]);
  const injected = yield* Ref.make<ReadonlyArray<HistoryItem>>([]);
  const rollbackCalls = yield* Ref.make(0);
  const started = yield* Deferred.make<void>();
  const release = yield* Deferred.make<void>();
  const registry = ProviderAdapterRegistry.layerFromAdapters([
    fakeAdapter({
      driver: "codex",
      modelSelection: CODEX_MODEL_SELECTION,
      capabilities: options.primaryCapabilities ?? CodexProviderCapabilitiesV2,
      turns,
      rollbackCalls,
      ...(options.inlineOnly ? {} : { injected }),
      ...(options.holdRunOrdinal === undefined
        ? {}
        : { hold: { runOrdinal: options.holdRunOrdinal, started, release } }),
    }),
    fakeAdapter({
      driver: "claudeAgent",
      modelSelection: CLAUDE_MODEL_SELECTION,
      capabilities: ClaudeProviderCapabilitiesV2,
      turns,
      rollbackCalls,
      injected,
    }),
  ]);
  const database = SqlitePersistence.layerMemory;
  const layer = Layer.mergeAll(
    ProviderReplayHarness.layerWithRegistry(
      {
        name: `group-publication-${name}`,
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
      registry,
      { databaseLayer: database },
    ),
    Layer.mergeAll(ThreadSearch.layer, ProjectStore.layer).pipe(
      Layer.provide(Layer.mergeAll(database, NodeCrypto.layer, NodeServices.layer)),
    ),
  );
  return { turns, injected, rollbackCalls, started, release, layer };
});

const startThread = Effect.fn("GroupPublicationTest.startThread")(function* (threadId: ThreadId) {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const createdAt = DateTime.formatIso(yield* DateTime.now);
  yield* projects.apply({
    sequence: 0,
    eventId: EventId.make(`created:${projectId}:${threadId}`),
    aggregateKind: "project",
    aggregateId: projectId,
    occurredAt: createdAt,
    commandId: null,
    causationEventId: null,
    correlationId: null,
    metadata: {},
    type: "project.created",
    payload: {
      projectId,
      title: "Group publication",
      workspaceRoot: "/work/group-publication",
      defaultModelSelection: null,
      scripts: [],
      createdAt,
      updatedAt: createdAt,
    },
  });
  yield* orchestrator.dispatch({
    type: "thread.create",
    commandId: CommandId.make(`command:create:${threadId}`),
    threadId,
    projectId,
    createdBy: "user",
    creationSource: "web",
    title: "Group publication",
    modelSelection: CODEX_MODEL_SELECTION,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
  });
});

const say = Effect.fn("GroupPublicationTest.say")(function* (
  threadId: ThreadId,
  tag: string,
  text: string,
  options: {
    readonly modelSelection?: ModelSelection;
    readonly queue?: boolean;
  } = {},
) {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  yield* orchestrator.dispatch({
    type: "message.dispatch",
    commandId: CommandId.make(`command:${threadId}:${tag}`),
    threadId,
    messageId: MessageId.make(`message:${threadId}:${tag}`),
    createdBy: "user",
    creationSource: "web",
    text,
    attachments: [],
    modelSelection: options.modelSelection ?? CODEX_MODEL_SELECTION,
    dispatchMode: options.queue ? { type: "queue_after_active" } : { type: "start_immediately" },
  });
});

const publishPeerReply = Effect.fn("GroupPublicationTest.publishPeerReply")(function* (
  threadId: ThreadId,
  tag: string,
  options: {
    readonly text?: string;
    readonly modelSelection?: ModelSelection;
    readonly status?: "completed" | "interrupted";
    readonly commandTag?: string;
  } = {},
) {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const modelSelection = options.modelSelection ?? CLAUDE_MODEL_SELECTION;
  return yield* orchestrator.dispatch({
    type: "thread.group.publish",
    commandId: CommandId.make(`command:publish:${threadId}:${options.commandTag ?? tag}`),
    threadId,
    status: options.status ?? "completed",
    text: options.text ?? `${PEER_TEXT} (${tag})`,
    entry: {
      type: "peer_reply",
      seatThreadId: ThreadId.make(`thread:seat:${threadId}`),
      seatRunId: RunId.make(`run:seat:${threadId}:${tag}`),
      speaker: { label: "Astra", model: modelSelection.model },
      modelSelection,
    },
  });
});

const isIdle = (projection: OrchestrationV2ThreadProjection) =>
  projection.runs.every(
    (run) => !["queued", "starting", "running", "waiting"].includes(run.status),
  );

const awaitProjection = Effect.fn("GroupPublicationTest.awaitProjection")(function* (
  threadId: ThreadId,
  ready: (projection: OrchestrationV2ThreadProjection) => boolean,
) {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const eventSink = yield* EventSink.EventSinkV2;
  const afterSequence = yield* eventSink.latestSequence();
  const current = yield* orchestrator.getThreadProjection(threadId);
  if (ready(current)) return current;
  const [next] = yield* eventSink.stream({ afterSequence }).pipe(
    Stream.mapEffect(() => orchestrator.getThreadProjection(threadId)),
    Stream.filter(ready),
    Stream.take(1),
    Stream.runCollect,
  );
  return next ?? (yield* Effect.die(new Error("Event stream ended before the awaited state")));
});

const settle = Effect.fn("GroupPublicationTest.settle")(function* (threadId: ThreadId) {
  const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
  yield* worker.drain();
  return yield* awaitProjection(threadId, isIdle);
});

const visibleTexts = (projection: OrchestrationV2ThreadProjection) => {
  const visible = createOrchestrationV2TurnItemVisibility({
    runs: projection.runs,
    attempts: projection.attempts,
    items: projection.turnItems,
  });
  return projection.turnItems
    .filter(visible)
    .flatMap((item) =>
      item.type === "assistant_message" || item.type === "user_message" ? [item.text] : [],
    );
};

const hasText = (texts: ReadonlyArray<string>, needle: string) =>
  texts.some((text) => text.includes(needle));

const lastTurnText = (turns: Ref.Ref<ReadonlyArray<CapturedTurn>>) =>
  Ref.get(turns).pipe(Effect.map((captured) => captured.at(-1)?.text ?? ""));

describe("group publication runs", () => {
  it.live("records words said elsewhere as a run with no provider turn, once", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness("record");
        yield* Effect.gen(function* () {
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const threadId = ThreadId.make("thread:group-publication:record");
          yield* startThread(threadId);
          yield* publishPeerReply(threadId, "reply");
          const interrupted = yield* publishPeerReply(threadId, "stopped", {
            status: "interrupted",
          });
          assert.isAbove(interrupted.storedEvents.length, 0);
          const messageId = MessageId.make("message:group-publication:to-peers");
          yield* orchestrator.dispatch({
            type: "thread.group.publish",
            commandId: CommandId.make("command:group-publication:to-peers"),
            threadId,
            status: "completed",
            text: "To the peers only",
            entry: {
              type: "user_to_peers",
              seatThreadIds: [ThreadId.make("thread:seat:one")],
              messageId,
              attachments: [],
              createdBy: "user",
              creationSource: "web",
            },
          });

          const first = yield* orchestrator.getThreadProjection(threadId);
          assert.deepEqual(
            first.runs.map((run) => [run.status, run.publication?.type, run.providerThreadId]),
            [
              ["completed", "peer_reply", null],
              ["interrupted", "peer_reply", null],
              ["completed", "user_to_peers", null],
            ],
          );
          assert.deepEqual(first.runs[0]!.modelSelection, CLAUDE_MODEL_SELECTION);
          assert.deepEqual(first.runs[2]!.modelSelection, CODEX_MODEL_SELECTION);
          assert.deepEqual(
            first.turnItems.map((item) =>
              item.type === "assistant_message" ? [item.type, item.speaker] : [item.type, null],
            ),
            [
              ["assistant_message", { label: "Astra", model: CLAUDE_MODEL_SELECTION.model }],
              ["assistant_message", { label: "Astra", model: CLAUDE_MODEL_SELECTION.model }],
              ["user_message", null],
            ],
          );
          assert.equal(first.messages.at(-1)?.id, messageId);

          const repeat = yield* publishPeerReply(threadId, "reply", { commandTag: "repeat" });
          assert.lengthOf(repeat.storedEvents, 0);
          const second = yield* orchestrator.getThreadProjection(threadId);
          assert.deepEqual(second.runs, first.runs);
          assert.deepEqual(second.turnItems, first.turnItems);
        }).pipe(Effect.provide(harness.layer));
      }),
    ),
  );

  it.live.each(PEERS)(
    "delivers a %s peer reply on the primary's next turn, once, on the same native session",
    ([kind, peer]) =>
      Effect.scoped(
        Effect.gen(function* () {
          const harness = yield* makeHarness(`delivery-${kind}`);
          yield* Effect.gen(function* () {
            const threadId = ThreadId.make(`thread:group-publication:delivery:${kind}`);
            yield* startThread(threadId);
            yield* say(threadId, "first", "Should sync be CRDT or event log?");
            const before = yield* settle(threadId);
            yield* publishPeerReply(threadId, "reply", { modelSelection: peer });
            yield* Ref.set(harness.injected, []);

            yield* say(threadId, "second", "Continue with the primary");
            const after = yield* settle(threadId);
            const delivered = yield* Ref.get(harness.injected);
            const peerItem = delivered.find((item) => item.content[0]?.text.includes(PEER_TEXT));
            assert.equal(peerItem?.role, "user");
            assert.include(peerItem?.content[0]?.text ?? "", `speaker=Astra (${peer.model})`);
            assert.notInclude(yield* lastTurnText(harness.turns), PEER_TEXT);

            const turns = yield* Ref.get(harness.turns);
            assert.equal(turns[0]?.nativeThreadId, turns[1]?.nativeThreadId);
            assert.equal(turns[1]?.driver, ProviderDriverKind.make("codex"));
            assert.equal(after.thread.activeProviderThreadId, before.thread.activeProviderThreadId);
            assert.deepEqual(after.thread.modelSelection, before.thread.modelSelection);
            assert.lengthOf(after.providerThreads, 1);
            assert.deepEqual(
              after.contextHandoffs.at(-1)?.history?.messages.map((message) => message.speaker),
              [{ label: "Astra", model: peer.model }],
            );

            yield* Ref.set(harness.injected, []);
            yield* say(threadId, "third", "And again");
            const final = yield* settle(threadId);
            assert.deepEqual(yield* Ref.get(harness.injected), []);
            assert.notInclude(yield* lastTurnText(harness.turns), PEER_TEXT);
            assert.equal(final.runs.at(-1)?.contextHandoffId, null);
          }).pipe(Effect.provide(harness.layer));
        }),
      ),
  );

  it.live("delivers inline to a provider that declares no handoff support", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness("inline", {
          inlineOnly: true,
          primaryCapabilities: {
            ...CodexProviderCapabilitiesV2,
            context: {
              ...CodexProviderCapabilitiesV2.context,
              acceptsSyntheticUserContext: false,
              canConsumeHandoffSummaries: false,
              supportsDeltaHandoff: false,
            },
          },
        });
        yield* Effect.gen(function* () {
          const threadId = ThreadId.make("thread:group-publication:inline");
          yield* startThread(threadId);
          yield* say(threadId, "first", "Question");
          yield* settle(threadId);
          yield* publishPeerReply(threadId, "reply");

          yield* say(threadId, "second", "Continue");
          const after = yield* settle(threadId);
          assert.equal(after.runs.at(-1)?.status, "completed");
          const text = yield* lastTurnText(harness.turns);
          assert.include(text, PEER_TEXT);
          assert.include(text, "speaker=Astra");
          assert.include(text, "Continue");
        }).pipe(Effect.provide(harness.layer));
      }),
    ),
  );

  it.live("reaches a first primary turn when only peers have spoken", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness("first-turn");
        yield* Effect.gen(function* () {
          const threadId = ThreadId.make("thread:group-publication:first-turn");
          yield* startThread(threadId);
          yield* publishPeerReply(threadId, "reply");

          yield* say(threadId, "first", "Now you");
          const after = yield* settle(threadId);
          assert.equal(after.runs.at(-1)?.status, "completed");
          const delivered = hasText(
            (yield* Ref.get(harness.injected)).flatMap((item) =>
              item.content.map((part) => part.text),
            ),
            PEER_TEXT,
          );
          assert.isTrue(delivered || (yield* lastTurnText(harness.turns)).includes(PEER_TEXT));
        }).pipe(Effect.provide(harness.layer));
      }),
    ),
  );

  it.live("labels peer text with role user when the thread later switches provider", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness("switch");
        yield* Effect.gen(function* () {
          const threadId = ThreadId.make("thread:group-publication:switch");
          yield* startThread(threadId);
          yield* say(threadId, "first", "Question");
          yield* settle(threadId);
          yield* publishPeerReply(threadId, "reply", { modelSelection: CODEX_MODEL_SELECTION });
          yield* Ref.set(harness.injected, []);

          yield* say(threadId, "switch", "Over to Claude", {
            modelSelection: CLAUDE_MODEL_SELECTION,
          });
          const after = yield* settle(threadId);
          assert.equal(after.runs.at(-1)?.status, "completed");
          const delivered = yield* Ref.get(harness.injected);
          const textOf = (item: HistoryItem) => item.content[0]?.text ?? "";
          const peer = delivered.find((item) => textOf(item).includes(PEER_TEXT));
          assert.equal(peer?.role, "user");
          assert.include(peer === undefined ? "" : textOf(peer), "speaker=Astra");
          const own = delivered.find((item) => textOf(item).includes("Primary reply 1"));
          assert.equal(own?.role, "assistant");
          assert.notInclude(own === undefined ? "" : textOf(own), "speaker=");
        }).pipe(Effect.provide(harness.layer));
      }),
    ),
  );

  it.live.each(PEERS)(
    "keeps the primary running while a %s peer publishes, and the queue delivers",
    ([kind, peer]) =>
      Effect.scoped(
        Effect.gen(function* () {
          const harness = yield* makeHarness(`concurrent-${kind}`, { holdRunOrdinal: 2 });
          yield* Effect.gen(function* () {
            const orchestrator = yield* Orchestrator.OrchestratorV2;
            const threadId = ThreadId.make(`thread:group-publication:concurrent:${kind}`);
            yield* startThread(threadId);
            yield* say(threadId, "first", "Question");
            yield* settle(threadId);
            yield* say(threadId, "held", "Primary is working");
            yield* Deferred.await(harness.started);
            yield* publishPeerReply(threadId, "reply", { modelSelection: peer });

            const during = yield* orchestrator.getThreadProjection(threadId);
            const primary = during.runs.find((run) => run.status === "running");
            assert.equal(primary?.ordinal, 2);
            assert.isDefined(during.runs.find((run) => run.publication !== undefined));
            assert.equal(latestUnheldRun(during.runs)?.id, primary?.id);
            assert.equal(latestExecutedRun(during.runs)?.id, primary?.id);
            const shell = yield* orchestrator.getThreadShell(threadId);
            assert.equal(shell?.latestRunId, primary?.id);
            assert.equal(shell?.activeRunId, primary?.id);
            assert.equal(shell?.status, "running");

            yield* say(threadId, "queued-before", "Queued before", { queue: true });
            yield* publishPeerReply(threadId, "second", { modelSelection: peer });
            yield* say(threadId, "queued-after", "Queued after", { queue: true });
            yield* Ref.set(harness.injected, []);
            yield* Deferred.succeed(harness.release, undefined);
            const after = yield* settle(threadId);
            assert.isTrue(
              after.runs.every((run) => run.status === "completed"),
              "every run finished",
            );
            const turns = yield* Ref.get(harness.turns);
            assert.deepEqual(
              turns.slice(-2).map((turn) => turn.text),
              ["Queued before", "Queued after"],
            );
            const peerItems = (yield* Ref.get(harness.injected)).filter((item) =>
              item.content[0]?.text.includes(PEER_TEXT),
            );
            assert.lengthOf(peerItems, 2, "the first queued turn delivers each reply, once");
            assert.deepEqual(
              peerItems.map((item) => item.role),
              ["user", "user"],
            );
            const handoffRuns = after.runs.filter((run) => run.contextHandoffId !== null);
            assert.deepEqual(
              handoffRuns.map(
                (run) => after.messages.find((m) => m.id === run.userMessageId)?.text,
              ),
              ["Queued before"],
            );
            assert.equal(after.thread.activeProviderThreadId, during.thread.activeProviderThreadId);
          }).pipe(Effect.provide(harness.layer));
        }),
      ),
  );

  it.live("removes a rewound publication run, leaves earlier ones, and hides it from search", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness("rollback");
        yield* Effect.gen(function* () {
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const search = yield* ThreadSearch.ThreadSearch;
          const threadId = ThreadId.make("thread:group-publication:rollback");
          yield* startThread(threadId);
          yield* say(threadId, "first", "CONTROLQUESTION");
          yield* settle(threadId);
          yield* publishPeerReply(threadId, "kept", { text: "KEPTPEERMARK stays" });
          yield* say(threadId, "second", "SECONDQUESTION");
          const beforeReply = yield* settle(threadId);
          yield* publishPeerReply(threadId, "gone", { text: "GONEPEERMARK goes" });
          assert.lengthOf((yield* search.search({ query: "GONEPEERMARK" })).matches, 1);

          const target = beforeReply.runs.at(-1)!;
          const checkpoint = (yield* awaitProjection(threadId, (p) =>
            p.checkpoints.some((c) => c.runId === target.id),
          )).checkpoints.find((c) => c.runId === target.id)!;
          yield* orchestrator.dispatch({
            type: "checkpoint.rollback",
            restoreFiles: false,
            commandId: CommandId.make("command:group-publication:rollback"),
            threadId,
            scopeId: checkpoint.scopeId,
            checkpointId: checkpoint.id,
          });
          const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
          yield* worker.drain();
          const after = yield* awaitProjection(threadId, (projection) =>
            projection.runs.some((run) => run.status === "rolled_back"),
          );

          const texts = visibleTexts(after);
          assert.isTrue(hasText(texts, "CONTROLQUESTION"));
          assert.isTrue(hasText(texts, "SECONDQUESTION"));
          assert.isTrue(hasText(texts, "KEPTPEERMARK"));
          assert.isFalse(hasText(texts, "GONEPEERMARK"));
          assert.equal(
            yield* Ref.get(harness.rollbackCalls),
            0,
            "the provider has nothing to undo",
          );
          assert.lengthOf((yield* search.search({ query: "GONEPEERMARK" })).matches, 0);
          assert.lengthOf((yield* search.search({ query: "KEPTPEERMARK" })).matches, 1);

          yield* Ref.set(harness.injected, []);
          yield* say(threadId, "third", "After the rewind");
          yield* settle(threadId);
          assert.isFalse(
            hasText(
              (yield* Ref.get(harness.injected)).flatMap((item) =>
                item.content.map((part) => part.text),
              ),
              "GONEPEERMARK",
            ),
          );
        }).pipe(Effect.provide(harness.layer));
      }),
    ),
  );

  it.live("still asks the provider to undo a real turn rewound with a publication run", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness("rollback-mixed");
        yield* Effect.gen(function* () {
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const threadId = ThreadId.make("thread:group-publication:rollback-mixed");
          yield* startThread(threadId);
          yield* say(threadId, "first", "CONTROLQUESTION");
          const base = yield* settle(threadId);
          yield* publishPeerReply(threadId, "gone", { text: "GONEPEERMARK goes" });
          yield* say(threadId, "second", "SECONDQUESTION");
          yield* settle(threadId);

          const runId = base.runs[0]!.id;
          const checkpoint = (yield* awaitProjection(threadId, (p) =>
            p.checkpoints.some((c) => c.runId === runId),
          )).checkpoints.find((c) => c.runId === runId)!;
          yield* orchestrator.dispatch({
            type: "checkpoint.rollback",
            restoreFiles: false,
            commandId: CommandId.make("command:group-publication:rollback-mixed"),
            threadId,
            scopeId: checkpoint.scopeId,
            checkpointId: checkpoint.id,
          });
          const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
          yield* worker.drain();
          const after = yield* awaitProjection(
            threadId,
            (projection) =>
              projection.runs.filter((run) => run.status === "rolled_back").length === 2,
          );
          const texts = visibleTexts(after);
          assert.isTrue(hasText(texts, "CONTROLQUESTION"));
          assert.isFalse(hasText(texts, "SECONDQUESTION"));
          assert.isFalse(hasText(texts, "GONEPEERMARK"));
          assert.equal(yield* Ref.get(harness.rollbackCalls), 1);
        }).pipe(Effect.provide(harness.layer));
      }),
    ),
  );

  it.live.each([
    ["latest", CLAUDE_MODEL_SELECTION],
    ["latest", CODEX_MODEL_SELECTION],
    ["reply", CLAUDE_MODEL_SELECTION],
    ["reply", CODEX_MODEL_SELECTION],
  ] as const)("forks from %s with its row and context, continuing on %j", ([point, continueOn]) =>
    Effect.scoped(
      Effect.gen(function* () {
        const name = `fork-${point}-${continueOn.instanceId}`;
        const harness = yield* makeHarness(name);
        yield* Effect.gen(function* () {
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const threadId = ThreadId.make(`thread:group-publication:${name}`);
          yield* startThread(threadId);
          yield* say(threadId, "first", "CONTROLQUESTION");
          yield* settle(threadId);
          yield* publishPeerReply(threadId, "reply");
          const source = yield* orchestrator.getThreadProjection(threadId);
          const replyRun = source.runs.at(-1)!;
          if (point === "reply") {
            yield* publishPeerReply(threadId, "later", { text: "LATERMARK after the fork" });
          }

          const forkId = ThreadId.make(`${threadId}:fork`);
          yield* orchestrator.dispatch({
            type: "thread.fork",
            createdBy: "user",
            creationSource: "web",
            commandId: CommandId.make(`command:fork:${name}`),
            sourceThreadId: threadId,
            targetThreadId: forkId,
            sourcePoint:
              point === "latest" ? { type: "latest_stable" } : { type: "run", runId: replyRun.id },
            title: "Fork",
          });
          const shown = JSON.stringify(
            (yield* orchestrator.getTimelinePage(forkId, { limit: 200 })).items,
          );
          assert.include(shown, "CONTROLQUESTION");
          assert.include(shown, PEER_TEXT);
          assert.notInclude(shown, "LATERMARK");
          assert.include(shown, '"label":"Astra"');

          yield* Ref.set(harness.injected, []);
          yield* say(forkId, "go", "Continue in fork", { modelSelection: continueOn });
          const fork = yield* settle(forkId);
          assert.equal(fork.runs.at(-1)?.status, "completed");
          const sent = [
            ...(yield* Ref.get(harness.injected)).flatMap((item) =>
              item.content.map((part) => part.text),
            ),
            yield* lastTurnText(harness.turns),
          ];
          assert.isTrue(hasText(sent, "CONTROLQUESTION"), "control context arrives");
          assert.isTrue(hasText(sent, PEER_TEXT), "peer text arrives");
          assert.isFalse(hasText(sent, "LATERMARK"), "later words stay behind");
          const afterFirst = JSON.stringify(
            (yield* orchestrator.getTimelinePage(forkId, { limit: 200 })).items,
          );
          assert.include(afterFirst, PEER_TEXT);
        }).pipe(Effect.provide(harness.layer));
      }),
    ),
  );

  it.live("merges a fork back when its latest stable run is a publication run", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness("merge-back");
        yield* Effect.gen(function* () {
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const threadId = ThreadId.make("thread:group-publication:merge-back");
          const forkId = ThreadId.make(`${threadId}:fork`);
          yield* startThread(threadId);
          yield* say(threadId, "first", "CONTROLQUESTION");
          yield* settle(threadId);
          yield* orchestrator.dispatch({
            type: "thread.fork",
            createdBy: "user",
            creationSource: "web",
            commandId: CommandId.make("command:group-publication:merge-back:fork"),
            sourceThreadId: threadId,
            targetThreadId: forkId,
            sourcePoint: { type: "latest_stable" },
            title: "Fork",
          });
          yield* say(forkId, "work", "Work in the fork");
          yield* settle(forkId);
          yield* publishPeerReply(forkId, "reply");

          yield* orchestrator.dispatch({
            type: "thread.merge_back",
            createdBy: "user",
            creationSource: "web",
            commandId: CommandId.make("command:group-publication:merge-back"),
            sourceThreadId: forkId,
            targetThreadId: threadId,
            sourcePoint: { type: "latest_stable" },
          });
          yield* Ref.set(harness.injected, []);
          yield* say(threadId, "after", "Back on the main thread");
          const after = yield* settle(threadId);
          assert.equal(after.runs.at(-1)?.status, "completed");
          const sent = [
            ...(yield* Ref.get(harness.injected)).flatMap((item) =>
              item.content.map((part) => part.text),
            ),
            yield* lastTurnText(harness.turns),
          ];
          assert.isTrue(hasText(sent, PEER_TEXT));
        }).pipe(Effect.provide(harness.layer));
      }),
    ),
  );
});
