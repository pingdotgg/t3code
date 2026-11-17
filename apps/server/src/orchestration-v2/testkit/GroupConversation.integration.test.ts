import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  type ChatAttachment,
  ChatAttachmentId,
  CommandId,
  COMPOSER_CONTEXT_MAX_RECORDS,
  ComposerContextId,
  EventId,
  MessageId,
  type ModelSelection,
  type OrchestrationMessageContext,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ProviderCapabilities,
  type OrchestrationV2ProviderSession,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2ThreadProjection,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
  type ResponseStreamingMode,
  type RunId,
  RuntimeRequestId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import { historyResponseItems } from "@t3tools/provider-core/server/handoffBudget";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import { checkpointWorkspace } from "@t3tools/provider-testing/replayWorkspace";
import { formatComposerContextReference } from "@t3tools/shared/composerContextReferences";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import * as ProviderRegistry from "../../provider/ProviderRegistry.ts";
import * as ServerSettings from "../../serverSettings.ts";
import { ClaudeProviderCapabilitiesV2 } from "../Adapters/ClaudeAdapterV2.ts";
import { CodexProviderCapabilitiesV2 } from "../Adapters/CodexAdapterV2.ts";
import * as CommandReceiptStore from "../CommandReceiptStore.ts";
import * as EffectOutbox from "../EffectOutbox.ts";
import * as EffectWorker from "../EffectWorker.ts";
import * as EventSink from "../EventSink.ts";
import * as GroupReactor from "../GroupReactor.ts";
import * as Orchestrator from "../Orchestrator.ts";
import * as ProjectionStore from "../ProjectionStore.ts";
import * as ProjectStore from "../ProjectStore.ts";
import * as ProviderAdapterRegistry from "../ProviderAdapterRegistry.ts";
import * as ProviderRuntimeRecovery from "../ProviderRuntimeRecoveryService.ts";
import * as ProviderSessionManager from "../ProviderSessionManager.ts";
import * as ThreadGroupService from "../ThreadGroupService.ts";
import * as ThreadManagementService from "../ThreadManagementService.ts";
import { CLAUDE_MODEL_SELECTION, CODEX_MODEL_SELECTION } from "./fixtures/shared.ts";
import * as ProviderReplayHarness from "./ProviderReplayHarness.ts";

const projectId = ProjectId.make("project:group-conversation");
const PRIMARY = CODEX_MODEL_SELECTION;
const ASTRA = CLAUDE_MODEL_SELECTION;
/** Same instance as the primary: the common case of two models in one pool. */
const OPUS: ModelSelection = { instanceId: PRIMARY.instanceId, model: "opus-peer" };
const STEERLESS: ModelSelection = {
  instanceId: ProviderInstanceId.make("steerless"),
  model: "steerless-peer",
};

/** Invite refuses a provider the settings do not enable, so the fakes need entries like real ones. */
const CONFIGURED_INSTANCES = {
  [STEERLESS.instanceId]: { driver: ProviderDriverKind.make("cursor"), enabled: true },
  [ProviderInstanceId.make("removed-provider")]: {
    driver: ProviderDriverKind.make("cursor"),
    enabled: true,
  },
};

interface CapturedTurn {
  readonly threadId: ThreadId;
  readonly text: string;
  readonly nativeThreadId: string | null;
  readonly runOrdinal: number;
}

interface Hold {
  readonly stream?: string;
  readonly started: Deferred.Deferred<void>;
  readonly release: Deferred.Deferred<"completed" | "interrupted">;
}

interface HistoryItem {
  readonly role: string;
  readonly content: ReadonlyArray<{ readonly text: string }>;
}

interface Control {
  readonly turns: Ref.Ref<ReadonlyArray<CapturedTurn>>;
  readonly steers: Ref.Ref<ReadonlyArray<{ readonly threadId: ThreadId; readonly text: string }>>;
  readonly steered: Queue.Queue<ThreadId>;
  readonly injected: Ref.Ref<ReadonlyArray<HistoryItem>>;
  readonly holds: Ref.Ref<ReadonlyMap<ThreadId, Hold>>;
  readonly running: Ref.Ref<ReadonlyMap<ProviderThreadId, Hold>>;
  readonly replies: Ref.Ref<ReadonlyMap<ThreadId, ReadonlyArray<string>>>;
  readonly failing: Ref.Ref<ReadonlySet<ThreadId>>;
  readonly scope: Scope.Scope;
}

const assistantItem = (input: {
  readonly driver: string;
  readonly threadId: ThreadId;
  readonly runId: RunId;
  readonly nodeId: Parameters<
    ProviderAdapter.ProviderAdapterV2SessionRuntime["startTurn"]
  >[0]["rootNodeId"];
  readonly providerThreadId: ProviderThreadId;
  readonly providerTurnId: ProviderTurnId;
  readonly runOrdinal: number;
  readonly text: string;
  readonly at: DateTime.Utc;
  readonly streaming: boolean;
}) => ({
  id: TurnItemId.make(`turn-item:${input.driver}:${input.threadId}:${input.runOrdinal}`),
  threadId: input.threadId,
  runId: input.runId,
  nodeId: input.nodeId,
  providerThreadId: input.providerThreadId,
  providerTurnId: input.providerTurnId,
  nativeItemRef: null,
  parentItemId: null,
  ordinal: input.runOrdinal * 100 + 1,
  status: input.streaming ? ("running" as const) : ("completed" as const),
  title: null,
  startedAt: input.at,
  completedAt: input.streaming ? null : input.at,
  updatedAt: input.at,
  type: "assistant_message" as const,
  messageId: MessageId.make(`message:${input.driver}:${input.threadId}:${input.runOrdinal}`),
  text: input.text,
  streaming: input.streaming,
});

function fakeAdapter(
  selection: ModelSelection,
  driverName: string,
  capabilities: OrchestrationV2ProviderCapabilities,
  control: Control,
): ProviderAdapter.ProviderAdapterV2["Service"] {
  const driver = ProviderDriverKind.make(driverName);
  const instanceId = ProviderInstanceId.make(selection.instanceId);
  const unused = (detail: string) =>
    Effect.fail(new ProviderAdapter.ProviderAdapterProtocolError({ driver, detail }));
  return {
    instanceId,
    driver,
    getCapabilities: () => Effect.succeed(capabilities),
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
          model: selection.model,
          capabilities,
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
              const nativeThreadId = `${driverName}:${threadInput.threadId}`;
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
          injectHistory: (history) =>
            Ref.update(control.injected, (current) => [
              ...current,
              ...(historyResponseItems(
                history.messages,
                history.context,
              ) as ReadonlyArray<HistoryItem>),
            ]).pipe(Effect.as(true)),
          compactThread: (turnInput) => runtime.startTurn(turnInput),
          // The effect lane stays free while a turn runs, as with a real provider, so a stop can land.
          startTurn: (turnInput) =>
            Effect.gen(function* () {
              const { threadId, runOrdinal } = turnInput;
              yield* Ref.update(control.turns, (turns) => [
                ...turns,
                {
                  threadId,
                  text: turnInput.message.text,
                  nativeThreadId: turnInput.providerThread.nativeThreadRef?.nativeId ?? null,
                  runOrdinal,
                },
              ]);
              const providerTurnId = ProviderTurnId.make(
                `provider-turn:${driverName}:${threadId}:${runOrdinal}`,
              );
              const startedAt = yield* DateTime.now;
              const nativeTurnRef = {
                driver,
                nativeId: `native-turn:${threadId}:${runOrdinal}`,
                strength: "strong" as const,
              };
              const providerTurn = (
                status: "running" | "completed" | "interrupted" | "failed",
                at: DateTime.Utc,
              ) => ({
                type: "provider_turn.updated" as const,
                driver,
                providerTurn: {
                  id: providerTurnId,
                  providerThreadId: turnInput.providerThread.id,
                  nodeId: turnInput.rootNodeId,
                  runAttemptId: turnInput.attemptId,
                  nativeTurnRef,
                  ordinal: runOrdinal,
                  status,
                  startedAt,
                  completedAt: status === "running" ? null : at,
                },
              });
              const item = (text: string, at: DateTime.Utc, streaming: boolean) => ({
                type: "turn_item.updated" as const,
                driver,
                turnItem: assistantItem({
                  driver: driverName,
                  threadId,
                  runId: turnInput.runId,
                  nodeId: turnInput.rootNodeId,
                  providerThreadId: turnInput.providerThread.id,
                  providerTurnId,
                  runOrdinal,
                  text,
                  at,
                  streaming,
                }),
              });
              const holds = yield* Ref.get(control.holds);
              const hold = holds.get(threadId);
              if (hold !== undefined) {
                yield* Ref.update(control.holds, (current) => {
                  const next = new Map(current);
                  next.delete(threadId);
                  return next;
                });
                yield* Ref.update(control.running, (current) =>
                  new Map(current).set(turnInput.providerThread.id, hold),
                );
              }
              const failing = (yield* Ref.get(control.failing)).has(threadId);
              const replies = yield* Ref.modify(control.replies, (current) => {
                const queue = current.get(threadId) ?? [];
                const next = new Map(current);
                next.set(threadId, queue.slice(1));
                return [queue[0], next] as const;
              });
              const reply = replies ?? `Reply ${runOrdinal} from ${threadId}`;
              const body = Effect.gen(function* () {
                yield* PubSub.publish(events, providerTurn("running", startedAt));
                if (hold?.stream !== undefined) {
                  yield* PubSub.publish(events, item(hold.stream, startedAt, true));
                }
                if (hold !== undefined) {
                  yield* Deferred.succeed(hold.started, undefined);
                }
                const outcome =
                  hold === undefined ? "completed" : yield* Deferred.await(hold.release);
                const at = yield* DateTime.now;
                if (failing) {
                  yield* PubSub.publish(events, providerTurn("failed", at));
                  yield* PubSub.publish(events, {
                    type: "turn.terminal",
                    driver,
                    providerThreadId: turnInput.providerThread.id,
                    providerTurnId,
                    runOrdinal,
                    failureItemOrdinal: runOrdinal * 100 + 2,
                    status: "failed",
                    failure: {
                      class: "provider_error",
                      message: "boom",
                      code: null,
                      retryable: false,
                    },
                    threadDisposition: "reusable",
                  });
                  return;
                }
                if (outcome === "completed") {
                  yield* PubSub.publish(events, item(reply, at, false));
                } else if (hold?.stream !== undefined) {
                  yield* PubSub.publish(events, item(hold.stream, at, false));
                }
                yield* PubSub.publish(events, providerTurn(outcome, at));
                yield* PubSub.publish(events, {
                  type: "turn.terminal",
                  driver,
                  providerThreadId: turnInput.providerThread.id,
                  providerTurnId,
                  runOrdinal,
                  status: outcome,
                  failure: null,
                  threadDisposition: "reusable",
                });
              });
              yield* Effect.forkIn(body, control.scope);
            }),
          steerTurn: (steerInput) =>
            Ref.update(control.steers, (current) => [
              ...current,
              { threadId: steerInput.threadId, text: steerInput.message.text },
            ]).pipe(
              Effect.andThen(Queue.offer(control.steered, steerInput.threadId)),
              Effect.asVoid,
            ),
          interruptTurn: (interruptInput) =>
            Effect.gen(function* () {
              const running = yield* Ref.get(control.running);
              const hold = running.get(interruptInput.providerThread.id);
              if (hold !== undefined) yield* Deferred.succeed(hold.release, "interrupted");
            }),
          respondToRuntimeRequest: () => Effect.void,
          readThreadSnapshot: () => unused("readThreadSnapshot"),
          rollbackThread: ({ providerThread }) =>
            Effect.succeed({
              providerThread,
              providerTurns: [],
              messages: [],
              runtimeRequests: [],
            }),
          forkThread: () => unused("a seat must never fork natively"),
        };
        return runtime;
      }),
  };
}

const catalog = [
  {
    instanceId: PRIMARY.instanceId,
    models: [
      { slug: PRIMARY.model, name: "Claude Fable 5", shortName: "Fable" },
      { slug: OPUS.model, name: "Claude Opus 5", shortName: "Opus" },
    ],
  },
  { instanceId: ASTRA.instanceId, models: [{ slug: ASTRA.model, name: "Astra" }] },
];

const makeHarness = Effect.fn("GroupConversationTest.makeHarness")(function* (
  name: string,
  options: {
    readonly enabled?: boolean;
    readonly responseStreamingMode?: ResponseStreamingMode;
    /** Runs right after a seat's records are read, to land a change behind that read. */
    readonly afterSeatRead?: (threadId: ThreadId) => Effect.Effect<void>;
    readonly runEffectWorker?: boolean;
    /** The orchestrator reads its own settings, so a seat can be turned off after its invite. */
    readonly orchestratorInstances?: typeof CONFIGURED_INSTANCES;
  } = {},
) {
  const cwd = yield* checkpointWorkspace(`group-conversation-${name}`);
  const control: Control = {
    turns: yield* Ref.make<ReadonlyArray<CapturedTurn>>([]),
    steers: yield* Ref.make<ReadonlyArray<{ readonly threadId: ThreadId; readonly text: string }>>(
      [],
    ),
    steered: yield* Queue.unbounded<ThreadId>(),
    injected: yield* Ref.make<ReadonlyArray<HistoryItem>>([]),
    holds: yield* Ref.make<ReadonlyMap<ThreadId, Hold>>(new Map()),
    running: yield* Ref.make<ReadonlyMap<ProviderThreadId, Hold>>(new Map()),
    replies: yield* Ref.make<ReadonlyMap<ThreadId, ReadonlyArray<string>>>(new Map()),
    failing: yield* Ref.make<ReadonlySet<ThreadId>>(new Set()),
    scope: yield* Effect.scope,
  };
  const registry = ProviderAdapterRegistry.layerFromAdapters([
    fakeAdapter(PRIMARY, "codex", CodexProviderCapabilitiesV2, control),
    fakeAdapter(ASTRA, "claudeAgent", ClaudeProviderCapabilitiesV2, control),
    fakeAdapter(
      STEERLESS,
      "cursor",
      {
        ...CodexProviderCapabilitiesV2,
        turns: {
          ...CodexProviderCapabilitiesV2.turns,
          supportsActiveSteering: false,
          supportsSteeringByInterruptRestart: false,
        },
      },
      control,
    ),
  ]);
  const database = SqlitePersistence.layerMemory;
  const dependencies = Layer.mergeAll(
    options.afterSeatRead === undefined
      ? ProjectionStore.layer
      : Layer.effect(
          ProjectionStore.ProjectionStoreV2,
          Effect.gen(function* () {
            const store = yield* ProjectionStore.ProjectionStoreV2;
            return {
              ...store,
              getThreadRecords: (threadId, fields, filter) =>
                store
                  .getThreadRecords(threadId, fields, filter)
                  .pipe(
                    Effect.tap(() =>
                      (fields as ReadonlyArray<string>).includes("turnItems") &&
                      (fields as ReadonlyArray<string>).includes("runs")
                        ? options.afterSeatRead!(threadId)
                        : Effect.void,
                    ),
                  ),
            } satisfies ProjectionStore.ProjectionStoreV2["Service"];
          }),
        ).pipe(Layer.provide(ProjectionStore.layer)),
    ServerSettings.ServerSettingsService.layerTest({
      groupConversationsEnabled: options.enabled ?? true,
      providerInstances: CONFIGURED_INSTANCES,
    }),
    Layer.mock(ProviderRegistry.ProviderRegistry)({
      getProviders: Effect.succeed(catalog as never),
    }),
  );
  const layer = Layer.mergeAll(GroupReactor.layer, ThreadGroupService.layer).pipe(
    Layer.provideMerge(dependencies),
    Layer.provideMerge(
      ProviderReplayHarness.layerWithRegistry(
        {
          name: `group-conversation-${name}`,
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
        {
          databaseLayer: database,
          settings: {
            providerInstances: options.orchestratorInstances ?? CONFIGURED_INSTANCES,
            responseStreamingMode: options.responseStreamingMode ?? "turn",
          },
          ...(options.runEffectWorker === undefined
            ? {}
            : { runEffectWorker: options.runEffectWorker }),
        },
      ),
    ),
    Layer.provideMerge(
      ProjectStore.layer.pipe(
        Layer.provide(Layer.mergeAll(database, NodeCrypto.layer, NodeServices.layer)),
      ),
    ),
    Layer.provideMerge(database),
    Layer.provideMerge(NodeCrypto.layer),
  );
  return { control, layer };
});

const startThread = Effect.fn("GroupConversationTest.startThread")(function* (
  threadId: ThreadId,
  title = "Group conversation",
) {
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
      title: "Group conversation",
      workspaceRoot: "/work/group-conversation",
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
    title,
    modelSelection: PRIMARY,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
  });
});

const say = Effect.fn("GroupConversationTest.say")(function* (
  threadId: ThreadId,
  tag: string,
  text: string,
  groupAudience?: "everyone" | ReadonlyArray<ThreadId | "primary">,
  delivery: "auto" | "queue" = "auto",
  attachments: ReadonlyArray<ChatAttachment> = [],
  context?: OrchestrationMessageContext,
) {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  return yield* orchestrator.dispatch({
    type: "message.dispatch",
    commandId: CommandId.make(`command:${threadId}:${tag}`),
    threadId,
    messageId: MessageId.make(`message:${threadId}:${tag}`),
    createdBy: "user",
    creationSource: "web",
    text,
    attachments,
    ...(context === undefined ? {} : { context }),
    ...(groupAudience === undefined ? {} : { groupAudience }),
    dispatchMode: { type: "queue_after_active" },
    ...(delivery === "auto" ? { deliveryIntent: "auto" as const } : {}),
  });
});

const invite = Effect.fn("GroupConversationTest.invite")(function* (
  threadId: ThreadId,
  modelSelection: ModelSelection,
) {
  const service = yield* ThreadGroupService.ThreadGroupService;
  const group = yield* service.invite({
    threadId,
    modelSelection,
    createdBy: "user",
    creationSource: "web",
  });
  return group.seats.at(-1)!.threadId;
});

/** Re-evaluates after every event, so a test never waits on a clock. */
const until = Effect.fn("GroupConversationTest.until")(function* <E, R>(
  ready: Effect.Effect<boolean, E, R>,
) {
  const eventSink = yield* EventSink.EventSinkV2;
  const afterSequence = yield* eventSink.latestSequence();
  if (yield* ready) return;
  const matched = yield* eventSink.stream({ afterSequence }).pipe(
    Stream.mapEffect(() => ready),
    Stream.filter((value) => value),
    Stream.take(1),
    Stream.runCollect,
  );
  if (Array.from(matched).length === 0) {
    return yield* Effect.die(new Error("Event stream ended before the awaited state"));
  }
});

const readGroup = Effect.fn("GroupConversationTest.readGroup")(function* (threadId: ThreadId) {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  return (yield* orchestrator.getThreadProjection(threadId)).thread.group;
});

const isQuiet = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const parent = yield* orchestrator.getThreadProjection(threadId);
    const group = parent.thread.group;
    if (group == null) return false;
    const seats = yield* Effect.forEach(group.seats, (seat) =>
      orchestrator.getThreadProjection(seat.threadId),
    );
    const open = ["preparing", "starting", "running", "waiting", "queued"];
    return (
      group.discussion === null &&
      [parent, ...seats].every((projection) =>
        projection.runs.every((run) => !open.includes(run.status)),
      )
    );
  });

const settle = Effect.fn("GroupConversationTest.settle")(function* (threadId: ThreadId) {
  const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
  yield* until(isQuiet(threadId));
  yield* worker.drain();
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  return yield* orchestrator.getThreadProjection(threadId);
});

const hold = Effect.fn("GroupConversationTest.hold")(function* (
  control: Control,
  threadId: ThreadId,
  stream?: string,
) {
  const started = yield* Deferred.make<void>();
  const release = yield* Deferred.make<"completed" | "interrupted">();
  const entry: Hold = { started, release, ...(stream === undefined ? {} : { stream }) };
  yield* Ref.update(control.holds, (current) => new Map(current).set(threadId, entry));
  return entry;
});

const script = (control: Control, threadId: ThreadId, replies: ReadonlyArray<string>) =>
  Ref.update(control.replies, (current) => new Map(current).set(threadId, replies));

const turnsOf = (control: Control, threadId: ThreadId) =>
  Ref.get(control.turns).pipe(
    Effect.map((turns) => turns.filter((turn) => turn.threadId === threadId)),
  );

const countText = (texts: ReadonlyArray<string>, needle: string) =>
  texts.filter((text) => text.includes(needle)).length;

const withReactor = <A, E, R>(body: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const reactor = yield* GroupReactor.GroupReactor;
    yield* reactor.start();
    return yield* body;
  });

const publishedRows = (projection: Pick<OrchestrationV2ThreadProjection, "turnItems">) =>
  projection.turnItems.flatMap((item) =>
    item.type === "assistant_message" && item.speaker !== undefined
      ? [{ label: item.speaker.label, text: item.text }]
      : [],
  );

const noticesOf = (projection: Pick<OrchestrationV2ThreadProjection, "turnItems">) =>
  projection.turnItems.flatMap((item) => (item.type === "system_notice" ? [item.message] : []));

describe("group conversations", () => {
  it.live.each([
    ["cross-instance", ASTRA, "Astra", 1],
    ["same-instance", OPUS, "Opus", 1],
    ["context-limit", ASTRA, "Astra", COMPOSER_CONTEXT_MAX_RECORDS],
  ] as const)(
    "runs a %s discussion to its budget without moving the primary",
    ([kind, peer, label, contextCount]) =>
      Effect.scoped(
        Effect.gen(function* () {
          const harness = yield* makeHarness(`everyone-${kind}`);
          const threadId = ThreadId.make(`thread:group:everyone:${kind}`);
          yield* withReactor(
            Effect.gen(function* () {
              const orchestrator = yield* Orchestrator.OrchestratorV2;
              yield* startThread(threadId);
              yield* say(threadId, "first", "Warm up");
              yield* until(
                orchestrator
                  .getThreadProjection(threadId)
                  .pipe(Effect.map((p) => p.runs.at(-1)?.status === "completed")),
              );
              const before = yield* orchestrator.getThreadProjection(threadId);

              const seat = yield* invite(threadId, peer);
              const other = yield* invite(threadId, STEERLESS);
              const primaryHold = yield* hold(harness.control, threadId);
              const sketch = {
                type: "file" as const,
                id: ChatAttachmentId.make(`sketch-${kind}`),
                name: "sync.md",
                mimeType: "text/markdown",
                sizeBytes: 12,
              };
              const terminal = {
                version: 1 as const,
                kind: "terminal" as const,
                contextId: ComposerContextId.make(`terminal-${kind}`),
                label: "Sync failure",
                terminalId: "sync",
                terminalLabel: "Sync",
                lineStart: 1,
                lineEnd: 1,
                text: "Replica rejected a duplicate revision.",
              };
              const records = Array.from({ length: contextCount }, (_, index) => ({
                ...terminal,
                contextId: ComposerContextId.make(`${terminal.contextId}-${index}`),
                text: `${terminal.text} Context ${index}.`,
              }));
              yield* say(
                threadId,
                "question",
                `Should sync be CRDT or event log? ${records.map(formatComposerContextReference).join(" ")}`,
                undefined,
                "auto",
                [sketch],
                { version: 1, records },
              );
              yield* Deferred.await(primaryHold.started);

              const during = (yield* readGroup(threadId))!;
              assert.equal(during.discussion?.mode, "everyone");
              assert.equal(
                during.discussion?.turnsLeft,
                5,
                "min(2 * 3, 8) minus the primary, which answers first",
              );
              assert.lengthOf(yield* turnsOf(harness.control, seat), 0, "seats wait for the lead");
              assert.lengthOf(yield* turnsOf(harness.control, other), 0);
              const seatProjection = yield* orchestrator.getThreadProjection(seat);
              assert.equal(seatProjection.thread.runtimeMode, before.thread.runtimeMode);
              assert.equal(seatProjection.thread.lineage.sideChat, true);
              yield* until(
                orchestrator
                  .getThreadProjection(threadId)
                  .pipe(
                    Effect.map((p) => p.providerTurns.some((turn) => turn.status === "running")),
                  ),
              );
              yield* (yield* EffectWorker.OrchestrationEffectWorkerV2).drain();
              const clarification = {
                ...terminal,
                contextId: ComposerContextId.make(`clarification-${kind}`),
                text: "Replica logs include conflicting branches.",
              };
              yield* say(
                threadId,
                "clarification",
                `Please check the edge cases too.${contextCount > 1 ? ` ${formatComposerContextReference(clarification)}` : ""}`,
                undefined,
                "auto",
                [],
                contextCount > 1 ? { version: 1, records: [clarification] } : undefined,
              );
              assert.equal(yield* Queue.take(harness.control.steered), threadId);
              yield* (yield* EffectWorker.OrchestrationEffectWorkerV2).drain();
              yield* Deferred.succeed(primaryHold.release, "completed");

              const after = yield* settle(threadId);
              const group = (yield* readGroup(threadId))!;
              assert.equal(group.closedBecause, "budget");
              assert.isNull(group.discussion);
              assert.deepEqual(after.thread.modelSelection, before.thread.modelSelection);
              assert.equal(
                after.thread.activeProviderThreadId,
                before.thread.activeProviderThreadId,
              );
              assert.lengthOf(
                after.providerThreads,
                1,
                "seats add no provider thread to the parent",
              );

              const seatTurns = yield* turnsOf(harness.control, seat);
              assert.lengthOf(seatTurns, 2, "first answer and one reaction");
              assert.include(seatTurns[0]!.text, "group conversation");
              assert.include(seatTurns[0]!.text, "Should sync be CRDT or event log?");
              assert.include(seatTurns[0]!.text, "Please check the edge cases too.");
              assert.include(
                seatTurns[0]!.text,
                terminal.text,
                "the original context reaches peers",
              );
              if (contextCount > 1) {
                assert.include(seatTurns[0]!.text, records.at(-1)!.text);
                assert.include(seatTurns[0]!.text, clarification.text);
                assert.notInclude(seatTurns[0]!.text, records[0]!.text);
                assert.notInclude(seatTurns[0]!.text, formatComposerContextReference(records[0]!));
                assert.include(
                  seatTurns[0]!.text,
                  `kind="terminal" id="${records[0]!.contextId}" unavailable="true"`,
                );
              }
              assert.include(seatTurns[0]!.text, `from ${threadId}`, "the lead's reply came first");
              const seatFirst = (yield* orchestrator.getThreadProjection(seat)).messages.find(
                (message) => message.role === "user",
              );
              assert.deepEqual(
                seatFirst?.attachments.map((attachment) => attachment.id),
                [sketch.id],
                "the user's files reach a seat woken by the lead's reply",
              );
              assert.notInclude(seatTurns[1]!.text, "group conversation with the user");
              assert.notInclude(
                seatTurns[1]!.text,
                `Reply ${seatTurns[0]!.runOrdinal} from ${seat}`,
              );
              assert.include(seatTurns[1]!.text, `from ${other}`);
              assert.notEqual(
                seatTurns[0]!.nativeThreadId,
                (yield* turnsOf(harness.control, threadId))[0]!.nativeThreadId,
              );

              const primaryTurns = yield* turnsOf(harness.control, threadId);
              assert.lengthOf(primaryTurns, 3, "warm up, the question, one hidden wake");
              const hiddenWake = primaryTurns[2]!.text;
              assert.include(hiddenWake, `@${group.seats[0]!.handle}`);
              const visibleUserRows = after.turnItems.filter(
                (item) => item.type === "user_message",
              );
              assert.lengthOf(visibleUserRows, 3, "a wake writes no user row");
              assert.isTrue(after.turnItems.some((item) => item.type === "notification"));
              assert.isFalse(
                after.turnItems.some((item) => item.type === "handoff"),
                "no handoff row while the group is active",
              );

              const rows = publishedRows(after);
              assert.lengthOf(
                rows.filter((row) => row.label === label),
                2,
              );
              assert.isTrue(
                after.runs
                  .filter((run) => run.publication !== undefined)
                  .every((run) => run.providerThreadId === null),
              );
              assert.deepEqual(
                after.runs.map((run) => run.ordinal),
                after.runs.map((run) => run.ordinal).toSorted((a, b) => a - b),
              );
            }),
          ).pipe(Effect.provide(harness.layer));
        }),
      ),
  );

  it.live.each([
    ["failed", "failed", "answer", "everyone"],
    ["PASS", "unavailable", "answer", "everyone"],
    ["PASS", "PASS", "answer", "everyone"],
    ["", "PASS", "answer", "everyone"],
    ["failed", "failed", "failed", "everyone"],
    ["PASS", "PASS", "PASS", "everyone"],
    ["failed", "PASS", "answer", "direct"],
    ["PASS", "PASS", "answer", "direct"],
  ] as const)(
    "hands an unanswered question along once (%s, %s, %s, %s)",
    ([leadReply, firstReply, lastReply, mode]) =>
      Effect.scoped(
        Effect.gen(function* () {
          const harness = yield* makeHarness("unanswered");
          const threadId = ThreadId.make("thread:group:unanswered");
          yield* withReactor(
            Effect.gen(function* () {
              yield* startThread(threadId);
              const first = yield* invite(
                threadId,
                firstReply === "unavailable"
                  ? {
                      instanceId: ProviderInstanceId.make("removed-provider"),
                      model: "removed-model",
                    }
                  : ASTRA,
              );
              const last = yield* invite(threadId, OPUS);
              const replies = [
                [threadId, leadReply],
                [first, firstReply],
                [last, lastReply],
              ] as const;
              yield* Ref.set(
                harness.control.failing,
                new Set(replies.filter(([, reply]) => reply === "failed").map(([id]) => id)),
              );
              for (const [id, reply] of replies) {
                yield* script(harness.control, id, [
                  reply === "answer" ? "Here is the answer.\n@user" : reply,
                ]);
              }
              yield* say(
                threadId,
                "question",
                "Can someone answer this?",
                mode === "direct" ? ["primary"] : "everyone",
              );
              const after = yield* settle(threadId);
              const turns = yield* Ref.get(harness.control.turns);
              assert.deepEqual(
                turns.map((turn) => turn.threadId),
                mode === "direct"
                  ? [threadId]
                  : firstReply === "unavailable"
                    ? [threadId, last]
                    : [threadId, first, last],
                "each fallback gets one turn in seating order, without retrying the lead",
              );
              assert.equal(after.thread.group?.closedBecause, "settled");
              if (firstReply === "unavailable") {
                assert.deepEqual(noticesOf(after), ["removed-model could not start."]);
              }
              if (mode === "everyone" && lastReply === "answer") {
                assert.include(
                  publishedRows(after).map((row) => row.text),
                  "Here is the answer.\n@user",
                );
              }
            }),
          ).pipe(Effect.provide(harness.layer));
        }),
      ),
  );

  it.live("keeps others running when a seat fails, and the discussion still settles", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness("failure");
        const threadId = ThreadId.make("thread:group:failure");
        yield* withReactor(
          Effect.gen(function* () {
            const orchestrator = yield* Orchestrator.OrchestratorV2;
            yield* startThread(threadId);
            const broken = yield* invite(threadId, ASTRA);
            const healthy = yield* invite(threadId, OPUS);
            const unreachable = yield* invite(threadId, {
              instanceId: ProviderInstanceId.make("removed-provider"),
              model: "removed-model",
            });
            yield* Ref.set(harness.control.failing, new Set([broken]));
            const healthyHold = yield* hold(harness.control, healthy);
            yield* say(threadId, "question", "Go");
            yield* Deferred.await(healthyHold.started);
            yield* until(
              orchestrator
                .getThreadProjection(broken)
                .pipe(Effect.map((p) => p.runs.at(-1)?.status === "failed")),
            );
            const during = yield* orchestrator.getThreadProjection(healthy);
            assert.equal(during.runs.at(-1)?.status, "running", "the healthy seat kept running");
            assert.isNotNull((yield* readGroup(threadId))!.discussion);

            yield* Deferred.succeed(healthyHold.release, "completed");
            const after = yield* settle(threadId);
            const group = (yield* readGroup(threadId))!;
            assert.isNull(group.discussion);
            assert.isNotNull(group.closedBecause);
            const rows = publishedRows(after);
            assert.isTrue(
              rows.some((row) => row.label === "Opus"),
              "control: the peer published",
            );
            assert.isFalse(
              rows.some((row) => row.label === "Astra"),
              "a failure has no text",
            );
            assert.lengthOf(
              yield* turnsOf(harness.control, unreachable),
              0,
              "a seat that cannot start takes nobody with it",
            );
            const notices = noticesOf(after);
            assert.isTrue(
              notices.some((notice) => notice.startsWith("Astra could not reply.")),
              `a failed seat says so on the thread, got ${notices.join(" | ")}`,
            );
            assert.include(notices, "removed-model could not start.");
            assert.isFalse(
              notices.some((notice) => notice.startsWith("Opus")),
              "control: a seat that replied has no notice",
            );
          }),
        ).pipe(Effect.provide(harness.layer));
      }),
    ),
  );

  it.live("holds seats to the providers enabled for the project", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const astraOff = {
          ...CONFIGURED_INSTANCES,
          [ASTRA.instanceId]: { driver: ProviderDriverKind.make("claudeAgent"), enabled: false },
        };
        const harness = yield* makeHarness("disabled-provider", {
          orchestratorInstances: astraOff,
        });
        const threadId = ThreadId.make("thread:group:disabled-provider");
        yield* withReactor(
          Effect.gen(function* () {
            const service = yield* ThreadGroupService.ThreadGroupService;
            const settings = yield* ServerSettings.ServerSettingsService;
            yield* startThread(threadId);
            const seat = yield* invite(threadId, ASTRA);
            const healthy = yield* invite(threadId, STEERLESS);
            yield* settings.updateSettings({ providerInstances: astraOff });
            const refused = yield* service
              .invite({
                threadId,
                modelSelection: { instanceId: ASTRA.instanceId, model: "another-model" },
                createdBy: "user",
                creationSource: "web",
              })
              .pipe(Effect.flip);
            assert.equal(refused._tag, "ThreadGroupCommandError");
            assert.lengthOf((yield* readGroup(threadId))!.seats, 2, "the refusal seats nobody");

            yield* say(threadId, "question", "Go");
            const after = yield* settle(threadId);
            assert.lengthOf(
              yield* turnsOf(harness.control, seat),
              0,
              "a turned off provider never runs",
            );
            assert.isAbove(
              (yield* turnsOf(harness.control, healthy)).length,
              0,
              "control: the enabled seat ran",
            );
            assert.include(noticesOf(after), "Astra could not start.");
          }),
        ).pipe(Effect.provide(harness.layer));
      }),
    ),
  );

  it.live("addresses one seat, and only a final line or PASS decides who wakes", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness("direct");
        const threadId = ThreadId.make("thread:group:direct");
        yield* withReactor(
          Effect.gen(function* () {
            yield* startThread(threadId);
            const astra = yield* invite(threadId, ASTRA);
            const opus = yield* invite(threadId, OPUS);

            yield* script(harness.control, astra, ["Over to you.\n@fable", "Ask @fable.", "PASS"]);
            yield* script(harness.control, threadId, ["Plain from the primary."]);
            yield* say(threadId, "one", "First for Astra", [astra]);
            const first = yield* settle(threadId);
            assert.equal(
              first.runs.find((run) => run.publication?.type === "user_to_peers")?.providerThreadId,
              null,
              "a message excluding the primary has no provider turn",
            );
            assert.lengthOf(yield* turnsOf(harness.control, astra), 1);
            assert.lengthOf(yield* turnsOf(harness.control, opus), 0, "control: Opus stays asleep");
            const wake = yield* turnsOf(harness.control, threadId);
            assert.lengthOf(wake, 1, "a final line wakes the primary");
            assert.include(wake[0]!.text, "Astra replied");
            assert.lengthOf(
              first.turnItems.filter((item) => item.type === "user_message"),
              1,
              "the hidden wake writes no user row",
            );
            assert.equal((yield* readGroup(threadId))!.closedBecause, "settled");

            yield* say(threadId, "two", "Second for Astra", [astra]);
            yield* settle(threadId);
            assert.lengthOf(yield* turnsOf(harness.control, astra), 2);
            assert.lengthOf(
              yield* turnsOf(harness.control, threadId),
              1,
              "a mention in prose wakes nobody",
            );

            yield* say(threadId, "three", "Third for Astra", [astra]);
            yield* settle(threadId);
            assert.lengthOf(yield* turnsOf(harness.control, astra), 3);
            assert.lengthOf(yield* turnsOf(harness.control, threadId), 1, "PASS wakes nobody");
            assert.lengthOf(yield* turnsOf(harness.control, opus), 0);
          }),
        ).pipe(Effect.provide(harness.layer));
      }),
    ),
  );

  it.live("reaches running seats with a new message and does not wake them for it again", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness("interject");
        const threadId = ThreadId.make("thread:group:interject");
        const MARK = "INTERJECTMARK must work offline";
        yield* withReactor(
          Effect.gen(function* () {
            const orchestrator = yield* Orchestrator.OrchestratorV2;
            yield* startThread(threadId);
            const steerable = yield* invite(threadId, ASTRA);
            const queued = yield* invite(threadId, STEERLESS);
            const holds = yield* Effect.forEach([threadId, steerable, queued], (id) =>
              hold(harness.control, id),
            );
            // Only named members run at once, and the primary's reply names the seats to wake them.
            const members = ["primary", steerable, queued] as const;
            const seated = (yield* readGroup(threadId))!.seats;
            yield* script(harness.control, threadId, [
              `Reply from ${threadId}\n${seated.map((seat) => `@${seat.handle}`).join(" ")}`,
            ]);
            yield* say(threadId, "first", "First question", members);
            yield* Effect.forEach(holds, (entry) => Deferred.await(entry.started), {
              discard: true,
            });
            yield* Effect.forEach(
              [threadId, steerable, queued],
              (id) =>
                until(
                  orchestrator
                    .getThreadProjection(id)
                    .pipe(
                      Effect.map((p) => p.providerTurns.some((turn) => turn.status === "running")),
                    ),
                ),
              { discard: true },
            );
            const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
            yield* worker.drain();
            const before = (yield* orchestrator.getThreadProjection(steerable)).runs[0]!;
            const firstThrough = before.groupThrough ?? 0;
            assert.isAbove(firstThrough, 0, "the first turn delivered through the question");
            yield* say(threadId, "second", MARK, members);
            // The primary and the steerable seat each take a steer. The other seat cannot.
            const steeredThreads = [
              yield* Queue.take(harness.control.steered),
              yield* Queue.take(harness.control.steered),
            ];
            assert.includeMembers(steeredThreads, [threadId, steerable]);
            yield* until(
              orchestrator
                .getThreadProjection(queued)
                .pipe(Effect.map((p) => p.runs.some((run) => run.status === "queued"))),
            );
            yield* worker.drain();
            assert.isAbove(
              (yield* orchestrator.getThreadProjection(steerable)).runs[0]!.groupThrough ?? 0,
              firstThrough,
              "an accepted steer advances the cursor on the same run",
            );
            yield* Effect.forEach(holds, (entry) => Deferred.succeed(entry.release, "completed"), {
              discard: true,
            });
            yield* settle(threadId);

            const steers = yield* Ref.get(harness.control.steers);
            const seen = [
              ...(yield* turnsOf(harness.control, steerable)).map((turn) => turn.text),
              ...steers.filter((steer) => steer.threadId === steerable).map((steer) => steer.text),
            ];
            assert.equal(countText(seen, "INTERJECTMARK"), 1, "a steer delivers it once");
            const queuedSeen = (yield* turnsOf(harness.control, queued)).map((turn) => turn.text);
            assert.equal(
              countText(queuedSeen, "INTERJECTMARK"),
              1,
              "a queued turn delivers it once",
            );
            assert.isFalse(
              steers.some((steer) => steer.threadId === queued),
              "a provider that cannot steer is never steered",
            );
            assert.isAbove(
              countText(seen, `from ${threadId}`),
              0,
              "the primary's reply reaches a seat whose cursor moved while it ran",
            );
          }),
        ).pipe(Effect.provide(harness.layer));
      }),
    ),
  );

  it.live("stops every running member and publishes what a seat had said", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness("stop", { responseStreamingMode: "paragraph" });
        const threadId = ThreadId.make("thread:group:stop");
        yield* withReactor(
          Effect.gen(function* () {
            const orchestrator = yield* Orchestrator.OrchestratorV2;
            yield* startThread(threadId);
            const talker = yield* invite(threadId, ASTRA);
            const silent = yield* invite(threadId, OPUS);
            const holds = [
              yield* hold(harness.control, threadId, "Primary was saying"),
              yield* hold(harness.control, talker, "STREAMEDMARK half a thought\n\n"),
              yield* hold(harness.control, silent),
            ];
            yield* say(threadId, "go", "Go", ["primary", talker, silent]);
            yield* Effect.forEach(holds, (entry) => Deferred.await(entry.started), {
              discard: true,
            });
            const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
            yield* until(
              Effect.gen(function* () {
                const seats = yield* Effect.forEach([threadId, talker, silent], (id) =>
                  orchestrator.getThreadProjection(id),
                );
                return (
                  seats.every((projection) =>
                    projection.providerTurns.some((turn) => turn.status === "running"),
                  ) &&
                  seats[1]!.turnItems.some(
                    (item) =>
                      item.type === "assistant_message" &&
                      item.text === "STREAMEDMARK half a thought\n\n",
                  )
                );
              }),
            );
            yield* worker.drain();
            const turnsBefore = (yield* Ref.get(harness.control.turns)).length;
            yield* orchestrator.dispatch({
              type: "thread.stop",
              commandId: CommandId.make("command:group:stop"),
              threadId,
            });
            yield* until(
              orchestrator
                .getThreadProjection(threadId)
                .pipe(Effect.map((projection) => publishedRows(projection).length === 1)),
            );
            const after = yield* settle(threadId);
            const group = (yield* readGroup(threadId))!;
            assert.equal(group.closedBecause, "stopped");
            assert.isNull(group.discussion);
            const seatStatuses = yield* Effect.forEach([threadId, talker, silent], (id) =>
              orchestrator
                .getThreadProjection(id)
                .pipe(
                  Effect.map(
                    (projection) =>
                      projection.runs.findLast((run) => run.publication === undefined)?.status,
                  ),
                ),
            );
            assert.deepEqual(seatStatuses, ["interrupted", "interrupted", "interrupted"]);
            const rows = publishedRows(after);
            assert.deepEqual(
              rows.map((row) => row.text),
              ["STREAMEDMARK half a thought\n\n"],
              "a seat with no text publishes nothing",
            );
            assert.equal(
              after.runs.find((run) => run.publication?.type === "peer_reply")?.status,
              "interrupted",
            );
            assert.equal(
              (yield* Ref.get(harness.control.turns)).length,
              turnsBefore,
              "nothing starts after Stop",
            );

            yield* script(harness.control, talker, ["PASS"]);
            yield* script(harness.control, silent, ["PASS"]);
            yield* say(threadId, "resume", "RESUMEMARK carry on");
            yield* settle(threadId);
            for (const member of [threadId, talker, silent]) {
              const last = (yield* turnsOf(harness.control, member)).at(-1)?.text ?? "";
              assert.include(last, "RESUMEMARK", "a message after Stop reaches every member");
            }
            assert.equal((yield* readGroup(threadId))!.closedBecause, "settled");
          }),
        ).pipe(Effect.provide(harness.layer));
      }),
    ),
  );

  it.live("ends quietly, leaves the primary alone, delivers once, and resumes on invite", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness("end");
        const threadId = ThreadId.make("thread:group:end");
        yield* withReactor(
          Effect.gen(function* () {
            const orchestrator = yield* Orchestrator.OrchestratorV2;
            const service = yield* ThreadGroupService.ThreadGroupService;
            yield* startThread(threadId);
            yield* say(threadId, "warm", "Warm up");
            yield* until(
              orchestrator
                .getThreadProjection(threadId)
                .pipe(Effect.map((p) => p.runs.at(-1)?.status === "completed")),
            );
            const seat = yield* invite(threadId, ASTRA);
            yield* script(harness.control, seat, ["PEERMARK prefers an event log"]);
            yield* say(threadId, "peer", "Ask Astra", [seat]);
            yield* settle(threadId);

            const primaryHold = yield* hold(harness.control, threadId);
            const seatHold = yield* hold(harness.control, seat, "LATEMARK unfinished");
            yield* say(threadId, "both", "Both of you", ["primary", seat]);
            yield* Deferred.await(primaryHold.started);
            yield* Deferred.await(seatHold.started);
            yield* until(
              orchestrator
                .getThreadProjection(seat)
                .pipe(Effect.map((p) => p.providerTurns.some((turn) => turn.status === "running"))),
            );

            yield* service.end({ threadId });
            const seatAfter = yield* orchestrator.getThreadProjection(seat);
            yield* until(
              orchestrator
                .getThreadProjection(seat)
                .pipe(Effect.map((p) => p.runs.at(-1)?.status === "interrupted")),
            );
            const during = yield* orchestrator.getThreadProjection(threadId);
            assert.equal(seatAfter.thread.deletedAt, null);
            assert.equal(
              during.runs.findLast((run) => run.publication === undefined)?.status,
              "running",
            );
            yield* Deferred.succeed(primaryHold.release, "completed");
            yield* until(
              orchestrator
                .getThreadProjection(threadId)
                .pipe(
                  Effect.map(
                    (p) =>
                      p.runs.findLast((run) => run.publication === undefined)?.status ===
                      "completed",
                  ),
                ),
            );
            const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
            yield* worker.drain();
            const ended = yield* orchestrator.getThreadProjection(threadId);
            assert.isFalse(
              publishedRows(ended).some((row) => row.text.includes("LATEMARK")),
              "a reply after End is never published",
            );
            assert.lengthOf(yield* turnsOf(harness.control, seat), 2, "End restarts nobody");
            assert.equal((yield* readGroup(threadId))!.status, "ended");
            const notice = ended.turnItems.find((item) => item.type === "system_notice");
            assert.equal(
              notice?.type === "system_notice" ? notice.message : "",
              "Group ended.",
              "the primary's running turn already holds the reply",
            );

            yield* Ref.set(harness.control.injected, []);
            const stale = yield* say(threadId, "stale", "Only for Astra", [seat]).pipe(Effect.flip);
            assert.equal(stale._tag, "OrchestratorDispatchError");
            yield* say(threadId, "after", "Just you now");
            const firstAfter = yield* until(
              orchestrator
                .getThreadProjection(threadId)
                .pipe(Effect.map((p) => p.runs.at(-1)?.status === "completed")),
            ).pipe(Effect.andThen(orchestrator.getThreadProjection(threadId)));
            assert.isFalse(
              firstAfter.turnItems.some(
                (item) => item.type === "user_message" && item.text.includes("LATEMARK"),
              ),
            );
            assert.lengthOf(
              yield* turnsOf(harness.control, seat),
              2,
              "a message after End stays with the primary",
            );

            const returned = yield* invite(threadId, ASTRA);
            assert.equal(returned, seat, "the same seat returns");
            assert.equal((yield* readGroup(threadId))!.status, "active");
            yield* say(threadId, "back", "Astra, you missed this", [seat]);
            yield* settle(threadId);
            const seatTurns = yield* turnsOf(harness.control, seat);
            assert.lengthOf(seatTurns, 3);
            assert.equal(
              seatTurns[2]!.nativeThreadId,
              seatTurns[0]!.nativeThreadId,
              "resumes natively",
            );
            assert.notInclude(seatTurns[2]!.text, "group conversation with the user");
            assert.include(seatTurns[2]!.text, "Just you now", "the delta carries what it missed");
            assert.include(seatTurns[2]!.text, "Astra, you missed this");
            const final = yield* orchestrator.getThreadProjection(threadId);
            assert.isFalse(publishedRows(final).some((row) => row.text.includes("LATEMARK")));
          }),
        ).pipe(Effect.provide(harness.layer));
      }),
    ),
  );

  it.live(
    "delivers unseen peer text once on the primary's first turn after End, with its row",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const harness = yield* makeHarness("end-delivery");
          const threadId = ThreadId.make("thread:group:end-delivery");
          yield* withReactor(
            Effect.gen(function* () {
              const orchestrator = yield* Orchestrator.OrchestratorV2;
              const service = yield* ThreadGroupService.ThreadGroupService;
              yield* startThread(threadId);
              yield* say(threadId, "warm", "Warm up");
              yield* until(
                orchestrator
                  .getThreadProjection(threadId)
                  .pipe(Effect.map((p) => p.runs.at(-1)?.status === "completed")),
              );
              const seat = yield* invite(threadId, ASTRA);
              yield* script(harness.control, seat, ["PEERMARK prefers an event log"]);
              yield* say(threadId, "peer", "Ask Astra", [seat]);
              yield* settle(threadId);
              yield* service.end({ threadId });
              const ended = yield* orchestrator.getThreadProjection(threadId);
              const notice = ended.turnItems.find((item) => item.type === "system_notice");
              assert.equal(
                notice?.type === "system_notice" ? notice.message : "",
                "Group ended. Fable has not seen 1 message.",
              );
              const timeline = yield* orchestrator.getTimelinePage(threadId, {
                view: "activity",
                limit: 200,
              });
              assert.include(
                JSON.stringify(timeline.items),
                "Group ended. Fable has not seen 1 message.",
                "the quiet line reaches a thread reader",
              );

              yield* Ref.set(harness.control.injected, []);
              yield* say(threadId, "next", "Continue");
              yield* until(
                orchestrator
                  .getThreadProjection(threadId)
                  .pipe(Effect.map((p) => p.runs.at(-1)?.status === "completed")),
              );
              const peerItems = (yield* Ref.get(harness.control.injected)).filter((item) =>
                item.content[0]?.text.includes("PEERMARK"),
              );
              assert.lengthOf(peerItems, 1);
              assert.equal(peerItems[0]?.role, "user");
              assert.include(peerItems[0]?.content[0]?.text ?? "", "speaker=Astra");
              const first = yield* orchestrator.getThreadProjection(threadId);
              assert.isTrue(
                first.turnItems.some((item) => item.type === "handoff"),
                "the first turn after End shows the handoff",
              );

              yield* Ref.set(harness.control.injected, []);
              yield* say(threadId, "again", "And again");
              yield* until(
                orchestrator
                  .getThreadProjection(threadId)
                  .pipe(Effect.map((p) => p.runs.at(-1)?.status === "completed")),
              );
              assert.deepEqual(yield* Ref.get(harness.control.injected), []);
            }),
          ).pipe(Effect.provide(harness.layer));
        }),
      ),
  );

  it.live("converges with no duplicate when a reactor repeats work or restarts mid-step", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness("crash");
        const threadId = ThreadId.make("thread:group:crash");
        yield* Effect.gen(function* () {
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const reactor = yield* GroupReactor.GroupReactor;
          const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
          const eventSink = yield* EventSink.EventSinkV2;
          const events: Array<OrchestrationV2DomainEvent> = [];
          yield* orchestrator.streamDomainEvents.pipe(
            Stream.runForEach((event) => Effect.sync(() => events.push(event))),
            Effect.forkScoped,
          );
          yield* Effect.yieldNow;
          const counts = Effect.gen(function* () {
            const parent = yield* orchestrator.getThreadProjection(threadId);
            return {
              runs: parent.runs.length,
              items: parent.turnItems.length,
              messages: parent.messages.length,
              turns: (yield* Ref.get(harness.control.turns)).length,
            };
          });
          yield* startThread(threadId);
          const seat = yield* invite(threadId, ASTRA);
          const seatSettled = (count: number) =>
            until(
              orchestrator
                .getThreadProjection(seat)
                .pipe(
                  Effect.map(
                    (p) =>
                      p.runs.filter((run) => run.status === "completed").length === count &&
                      p.runs.every((run) => run.status !== "running"),
                  ),
                ),
            );

          const primarySettled = until(
            orchestrator
              .getThreadProjection(threadId)
              .pipe(
                Effect.map(
                  (p) =>
                    p.runs.findLast((run) => run.publication === undefined)?.status === "completed",
                ),
              ),
          );

          // The seat settled, and the reactor died before it published anything.
          yield* say(threadId, "one", "For Astra", [seat]);
          yield* seatSettled(1);
          yield* worker.drain();
          assert.lengthOf(
            (yield* orchestrator.getThreadProjection(threadId)).runs.filter(
              (run) => run.publication?.type === "peer_reply",
            ),
            0,
            "control: nothing publishes without the reactor",
          );
          yield* reactor.sweep;
          const afterSweep = yield* orchestrator.getThreadProjection(threadId);
          assert.lengthOf(
            afterSweep.runs.filter((run) => run.publication?.type === "peer_reply"),
            1,
            "the sweep publishes what the crash left",
          );
          assert.equal((yield* readGroup(threadId))!.closedBecause, "settled");
          const stable = yield* counts;
          yield* reactor.sweep;
          assert.deepEqual(yield* counts, stable, "a second sweep changes nothing");

          // The reactor published and died before it planned the next wave.
          const { primary, seats } = (yield* readGroup(threadId))!;
          yield* script(harness.control, threadId, [`Primary view\n@${seats[0]!.handle}`]);
          yield* say(threadId, "two", "Both of you", ["primary", seat]);
          yield* seatSettled(2);
          yield* primarySettled;
          yield* worker.drain();
          const seatRun = (yield* orchestrator.getThreadProjection(seat)).runs.at(-1)!;
          yield* orchestrator.dispatch({
            type: "thread.group.publish",
            commandId: CommandId.make(`server:group-publish:${seatRun.id}`),
            threadId,
            status: "completed",
            text: `Published just before the crash\n@${primary.handle}`,
            entry: {
              type: "peer_reply",
              seatThreadId: seat,
              seatRunId: seatRun.id,
              speaker: { label: "Astra", model: ASTRA.model },
              modelSelection: ASTRA,
            },
          });
          yield* reactor.sweep;
          const wave = (primaryTurns: number, seatTurns: number) =>
            until(
              Effect.gen(function* () {
                const group = yield* readGroup(threadId);
                return (
                  (group?.discussion?.delivering.length ?? 0) === 0 &&
                  (yield* turnsOf(harness.control, threadId)).length === primaryTurns &&
                  (yield* turnsOf(harness.control, seat)).length === seatTurns
                );
              }),
            );
          yield* wave(2, 3);
          yield* reactor.sweep;
          yield* wave(2, 3);
          const waveSeat = (yield* turnsOf(harness.control, seat)).length;
          yield* seatSettled(3);
          yield* primarySettled;
          yield* worker.drain();
          yield* reactor.sweep;

          // A wave's effect ran, and the worker replays the same commands after a crash.
          yield* orchestrator.dispatch({
            type: "thread.group.deliver",
            commandId: CommandId.make("server:group-deliver:replayed"),
            threadId: seat,
            parentThreadId: threadId,
          });
          yield* orchestrator.dispatch({
            type: "thread.group.deliver",
            commandId: CommandId.make("server:group-deliver:replayed"),
            threadId: seat,
            parentThreadId: threadId,
          });
          yield* orchestrator.dispatch({
            type: "thread.group.delivered",
            commandId: CommandId.make("server:group-delivered:replayed"),
            threadId,
            member: seat,
          });
          assert.lengthOf(
            yield* turnsOf(harness.control, seat),
            waveSeat,
            "nothing new to deliver means no new turn",
          );

          // Every event seen so far is handled twice, as after a restart mid-stream.
          yield* until(isQuiet(threadId));
          const seen = events.slice();
          yield* Effect.forEach(seen, reactor.handle, { discard: true });
          yield* worker.drain();
          const once = yield* counts;
          yield* Effect.forEach(seen, reactor.handle, { discard: true });
          yield* worker.drain();
          yield* reactor.sweep;
          yield* worker.drain();
          assert.deepEqual(yield* counts, once);
          assert.isAbove(yield* eventSink.latestSequence(), 0);
        }).pipe(Effect.provide(harness.layer));
      }),
    ),
  );

  it.live("publishes a seat invited while the primary runs", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness("mid-turn");
        const threadId = ThreadId.make("thread:group:mid-turn");
        yield* withReactor(
          Effect.gen(function* () {
            const orchestrator = yield* Orchestrator.OrchestratorV2;
            yield* startThread(threadId);
            const primaryHold = yield* hold(harness.control, threadId, "Primary is mid-sentence");
            yield* say(threadId, "first", "Primary, go");
            yield* Deferred.await(primaryHold.started);
            yield* until(
              orchestrator
                .getThreadProjection(threadId)
                .pipe(Effect.map((p) => p.providerTurns.some((turn) => turn.status === "running"))),
            );
            const seat = yield* invite(threadId, ASTRA);
            yield* script(harness.control, seat, ["MIDTURNMARK from the new seat"]);
            yield* say(threadId, "peer", "Astra, join in", [seat]);
            yield* until(
              orchestrator
                .getThreadProjection(threadId)
                .pipe(
                  Effect.map((p) => p.runs.some((run) => run.publication?.type === "peer_reply")),
                ),
            );
            const seatPrompt = (yield* turnsOf(harness.control, seat))[0]!.text;
            assert.include(seatPrompt, "Astra, join in");
            yield* Deferred.succeed(primaryHold.release, "completed");
            const after = yield* settle(threadId);
            assert.isTrue(publishedRows(after).some((row) => row.text.includes("MIDTURNMARK")));
          }),
        ).pipe(Effect.provide(harness.layer));
      }),
    ),
  );

  it.live("reads the primary's words as the primary's when a seat shares its instance", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness("portable");
        const threadId = ThreadId.make("thread:group:portable");
        yield* withReactor(
          Effect.gen(function* () {
            const orchestrator = yield* Orchestrator.OrchestratorV2;
            yield* startThread(threadId);
            yield* script(harness.control, threadId, [
              "PRIMARYMARK thinks CRDT",
              "BETWEENMARK came after the invite",
            ]);
            yield* say(threadId, "warm", "Warm up");
            yield* until(
              orchestrator
                .getThreadProjection(threadId)
                .pipe(Effect.map((p) => p.runs.at(-1)?.status === "completed")),
            );
            const seat = yield* invite(threadId, OPUS);
            yield* say(threadId, "between", "Between", ["primary"]);
            yield* until(
              orchestrator
                .getThreadProjection(threadId)
                .pipe(
                  Effect.map((p) => p.runs.length === 2 && p.runs.at(-1)?.status === "completed"),
                ),
            );
            yield* Ref.set(harness.control.injected, []);
            const question = "Opus, what did you recommend?";
            yield* say(threadId, "peer", question, [seat]);
            yield* settle(threadId);

            const [firstTurn] = yield* turnsOf(harness.control, seat);
            assert.include(
              firstTurn?.text ?? "",
              "known here as",
              "control: the seat's first prompt",
            );
            assert.notInclude(firstTurn?.text ?? "", "do not continue or redo");
            assert.notInclude(firstTurn?.text ?? "", "t3_thread_read");
            assert.include(firstTurn?.text ?? "", "BETWEENMARK", "the seat learns what it missed");
            assert.lengthOf(
              (firstTurn?.text ?? "").split(question),
              2,
              "the question being answered appears once",
            );

            const seatRun = (yield* orchestrator.getThreadProjection(seat)).runs.at(-1);
            assert.equal(seatRun?.status, "completed", "a native fork would fail this adapter");
            const primaryWords = (yield* Ref.get(harness.control.injected)).filter((item) =>
              item.content[0]?.text.includes("PRIMARYMARK"),
            );
            assert.lengthOf(primaryWords, 1);
            assert.equal(primaryWords[0]?.role, "user");
            assert.include(primaryWords[0]?.content[0]?.text ?? "", "speaker=Fable");
          }),
        ).pipe(Effect.provide(harness.layer));
      }),
    ),
  );

  it.live("wakes nobody on words older than the latest user message", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness("stale");
        const threadId = ThreadId.make("thread:group:stale");
        yield* withReactor(
          Effect.gen(function* () {
            const orchestrator = yield* Orchestrator.OrchestratorV2;
            yield* startThread(threadId);
            const astra = yield* invite(threadId, ASTRA);
            const opus = yield* invite(threadId, OPUS);
            const astraHold = yield* hold(harness.control, astra, "Over to you.\n@opus");
            yield* say(threadId, "first", "Astra, go", [astra]);
            yield* Deferred.await(astraHold.started);
            yield* until(
              orchestrator
                .getThreadProjection(astra)
                .pipe(Effect.map((p) => p.providerTurns.some((turn) => turn.status === "running"))),
            );
            yield* orchestrator.dispatch({
              type: "thread.stop",
              commandId: CommandId.make("command:group:stop"),
              threadId,
            });
            yield* until(
              orchestrator
                .getThreadProjection(threadId)
                .pipe(
                  Effect.map((projection) =>
                    publishedRows(projection).some((row) => row.text.endsWith("@opus")),
                  ),
                ),
            );
            yield* settle(threadId);
            const stopped = yield* orchestrator.getThreadProjection(threadId);
            assert.isTrue(
              publishedRows(stopped).some((row) => row.text.endsWith("@opus")),
              "control: the stale hand-off is on the record",
            );

            yield* script(harness.control, astra, ["PASS"]);
            yield* say(threadId, "second", "Astra, again", [astra]);
            yield* settle(threadId);
            assert.lengthOf(yield* turnsOf(harness.control, astra), 2);
            assert.lengthOf(yield* turnsOf(harness.control, opus), 0);
          }),
        ).pipe(Effect.provide(harness.layer));
      }),
    ),
  );

  it.live.each(["idle", "running"] as const)(
    "preserves later side chat messages when End reaches a seat that was %s",
    (state) =>
      Effect.scoped(
        Effect.gen(function* () {
          const harness = yield* makeHarness("end-pending-stop", { runEffectWorker: false });
          yield* Effect.gen(function* () {
            const orchestrator = yield* Orchestrator.OrchestratorV2;
            const service = yield* ThreadGroupService.ThreadGroupService;
            const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
            const threadId = ThreadId.make("thread:group:end-pending-stop");
            yield* startThread(threadId);
            const seat = yield* invite(threadId, STEERLESS);
            if (state === "running") {
              const live = yield* hold(harness.control, seat);
              yield* say(threadId, "group", "Group turn", [seat]);
              yield* worker.drain();
              yield* Deferred.await(live.started);
              yield* say(threadId, "queued-group", "Queued group turn", [seat]);
              yield* worker.drain();
              const beforeEnd = yield* orchestrator.getThreadProjection(seat);
              assert.equal(beforeEnd.runs.at(-1)?.status, "queued");
            }
            yield* service.end({ threadId });
            yield* say(seat, "solo", "First independent turn", undefined, "queue");
            yield* say(seat, "queued-solo", "Second independent turn", undefined, "queue");
            yield* worker.drain();
            const { runs } = yield* orchestrator.getThreadProjection(seat);
            const solo = runs.filter((run) => run.groupThrough === undefined);
            assert.lengthOf(solo, 2);
            for (const run of solo) {
              assert.notInclude(["interrupted", "cancelled"], run.status);
              assert.isNotTrue(run.queueHeld);
            }
            if (state === "running") {
              assert.deepEqual(
                runs.filter((run) => run.groupThrough !== undefined).map((run) => run.status),
                ["interrupted", "cancelled"],
              );
            }
          }).pipe(Effect.provide(harness.layer));
        }),
      ),
  );

  it.live("holds a discussion open while a member is being told to start", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness("delivering", { runEffectWorker: false });
        const threadId = ThreadId.make("thread:group:delivering");
        yield* Effect.gen(function* () {
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          yield* startThread(threadId);
          const seat = yield* invite(threadId, ASTRA);
          yield* say(threadId, "peer", "Astra, go", [seat]);
          const advance = (tag: string) =>
            orchestrator.dispatch({
              type: "thread.group.advance",
              commandId: CommandId.make(`command:group-delivering:${tag}`),
              threadId,
            });
          yield* advance("pending");
          const pending = (yield* readGroup(threadId))!;
          assert.deepEqual(pending.discussion?.delivering, [seat], "the seat has no run yet");
          assert.isNull(pending.closedBecause);

          yield* orchestrator.dispatch({
            type: "thread.group.delivered",
            commandId: CommandId.make("command:group-delivering:delivered"),
            threadId,
            member: seat,
          });
          yield* advance("after");
          assert.equal((yield* readGroup(threadId))!.closedBecause, "settled", "control");
        }).pipe(Effect.provide(harness.layer));
      }),
    ),
  );

  it.live.each(["thread.delete", "thread.archive"] as const)(
    "starts no turn after %s even before the reactor sees it",
    (type) =>
      Effect.scoped(
        Effect.gen(function* () {
          const harness = yield* makeHarness("delete-race");
          const threadId = ThreadId.make("thread:group:delete-race");
          yield* Effect.gen(function* () {
            const orchestrator = yield* Orchestrator.OrchestratorV2;
            const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
            yield* startThread(threadId);
            const kept = yield* invite(threadId, ASTRA);
            const gone = yield* invite(threadId, OPUS);
            const change = yield* orchestrator.dispatch({
              type,
              commandId: CommandId.make("command:group-delete-race:seat"),
              threadId: gone,
            });
            yield* say(threadId, "go", "Both of you", [kept, gone]);
            yield* until(
              orchestrator
                .getThreadProjection(kept)
                .pipe(Effect.map((p) => p.runs.at(-1)?.status === "completed")),
            );
            yield* worker.drain();
            assert.lengthOf(yield* turnsOf(harness.control, kept), 1, "control");
            assert.lengthOf(yield* turnsOf(harness.control, gone), 0);
            const reactor = yield* GroupReactor.GroupReactor;
            yield* Effect.forEach(change.storedEvents, (stored) => reactor.handle(stored.event), {
              discard: true,
            });
            assert.equal(
              (yield* readGroup(threadId))?.seats.find((seat) => seat.threadId === gone)?.status,
              "left",
            );
          }).pipe(Effect.provide(harness.layer));
        }),
      ),
  );

  it.live("names a thread from its first message even when that message skips the primary", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness("title");
        const threadId = ThreadId.make("thread:group:title");
        yield* withReactor(
          Effect.gen(function* () {
            const orchestrator = yield* Orchestrator.OrchestratorV2;
            yield* startThread(threadId, "New thread");
            const seat = yield* invite(threadId, ASTRA);
            yield* orchestrator.dispatch({
              type: "message.dispatch",
              commandId: CommandId.make("command:group-title:first"),
              threadId,
              messageId: MessageId.make("message:group-title:first"),
              createdBy: "user",
              creationSource: "web",
              text: "Astra, what do you think?",
              titleSeed: "Astra asked first",
              attachments: [],
              groupAudience: [seat],
              dispatchMode: { type: "start_immediately" },
            });
            const after = yield* settle(threadId);
            assert.equal(after.thread.title, "Astra asked first");
            assert.isDefined(
              after.messages.find((row) => row.text === "Astra, what do you think?"),
            );
          }),
        ).pipe(Effect.provide(harness.layer));
      }),
    ),
  );

  it.live("writes no handoff row when a queued primary turn takes a peer reply", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness("queued-handoff");
        const threadId = ThreadId.make("thread:group:queued-handoff");
        yield* withReactor(
          Effect.gen(function* () {
            const orchestrator = yield* Orchestrator.OrchestratorV2;
            yield* startThread(threadId);
            const seat = yield* invite(threadId, ASTRA);
            const primaryHold = yield* hold(harness.control, threadId);
            yield* script(harness.control, seat, ["PEERMARK while you worked"]);
            yield* script(harness.control, threadId, ["PASS", "PASS"]);
            yield* say(threadId, "first", "Primary, go", ["primary"]);
            yield* Deferred.await(primaryHold.started);
            yield* say(threadId, "peer", "Astra, go", [seat]);
            yield* until(
              orchestrator
                .getThreadProjection(threadId)
                .pipe(
                  Effect.map((p) => p.runs.some((run) => run.publication?.type === "peer_reply")),
                ),
            );
            yield* Ref.set(harness.control.injected, []);
            yield* orchestrator.dispatch({
              type: "message.dispatch",
              commandId: CommandId.make("command:group-queued:queued"),
              threadId,
              messageId: MessageId.make("message:group-queued:queued"),
              createdBy: "user",
              creationSource: "web",
              text: "Queued for the primary",
              attachments: [],
              groupAudience: ["primary"],
              dispatchMode: { type: "queue_after_active" },
            });
            yield* Deferred.succeed(primaryHold.release, "completed");
            const after = yield* settle(threadId);
            const delivered = (yield* Ref.get(harness.control.injected)).filter((item) =>
              item.content[0]?.text.includes("PEERMARK"),
            );
            assert.lengthOf(delivered, 1, "the queued turn still takes the reply");
            assert.isFalse(after.turnItems.some((item) => item.type === "handoff"));
          }),
        ).pipe(Effect.provide(harness.layer));
      }),
    ),
  );

  it.live(
    "refuses a rewind during a discussion, and a discussion's end reads as a turn's end",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const harness = yield* makeHarness("rewind");
          const threadId = ThreadId.make("thread:group:rewind");
          yield* withReactor(
            Effect.gen(function* () {
              const orchestrator = yield* Orchestrator.OrchestratorV2;
              yield* startThread(threadId);
              yield* say(threadId, "warm", "Warm up");
              yield* until(
                orchestrator
                  .getThreadProjection(threadId)
                  .pipe(Effect.map((p) => p.runs.at(-1)?.status === "completed")),
              );
              const warmed = yield* orchestrator.getThreadProjection(threadId);
              const checkpoint = warmed.checkpoints.at(-1)!;
              const rollback = (tag: string) =>
                orchestrator.dispatch({
                  type: "checkpoint.rollback",
                  restoreFiles: false,
                  commandId: CommandId.make(`command:group-rewind:${tag}`),
                  threadId,
                  scopeId: checkpoint.scopeId,
                  checkpointId: checkpoint.id,
                });

              const seat = yield* invite(threadId, ASTRA);
              const seatHold = yield* hold(harness.control, seat);
              yield* say(threadId, "peer", "Ask Astra", [seat]);
              yield* Deferred.await(seatHold.started);
              const refused = yield* rollback("during").pipe(Effect.flip);
              assert.include(String(refused.cause), "Stop the group's discussion");
              yield* Deferred.succeed(seatHold.release, "completed");
              yield* settle(threadId);

              const closed = (yield* readGroup(threadId))!;
              assert.isNotNull(closed.closedAt);
              const shell = yield* orchestrator.getThreadShell(threadId);
              const primaryRun = warmed.runs.at(-1)!;
              assert.equal(
                shell?.latestRunId,
                primaryRun.id,
                "the shell still names the primary's run",
              );
              assert.equal(
                shell?.latestRunCompletedAt == null
                  ? null
                  : DateTime.formatIso(shell.latestRunCompletedAt),
                closed.closedAt,
                "a user who walked away sees the discussion finished",
              );

              yield* rollback("after");
              const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
              yield* worker.drain();
              yield* until(
                orchestrator
                  .getThreadProjection(threadId)
                  .pipe(Effect.map((p) => p.runs.some((run) => run.status === "rolled_back"))),
              );
              const rewound = yield* orchestrator.getThreadProjection(threadId);
              const seatRun = (yield* orchestrator.getThreadProjection(seat)).runs.at(-1)!;
              const replay = yield* orchestrator.dispatch({
                type: "thread.group.publish",
                commandId: CommandId.make("command:group-rewind:republish"),
                threadId,
                status: "completed",
                text: "The same words again",
                entry: {
                  type: "peer_reply",
                  seatThreadId: seat,
                  seatRunId: seatRun.id,
                  speaker: { label: "Astra", model: ASTRA.model },
                  modelSelection: ASTRA,
                },
              });
              assert.lengthOf(replay.storedEvents, 0, "a rewound reply stays rewound");
              assert.deepEqual(
                (yield* orchestrator.getThreadProjection(threadId)).runs,
                rewound.runs,
              );
            }),
          ).pipe(Effect.provide(harness.layer));
        }),
      ),
  );

  it.live(
    "deletes seats with their thread, and a seat's own deletion leaves the group working",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const harness = yield* makeHarness("delete");
          const threadId = ThreadId.make("thread:group:delete");
          yield* withReactor(
            Effect.gen(function* () {
              const orchestrator = yield* Orchestrator.OrchestratorV2;
              yield* startThread(threadId);
              const kept = yield* invite(threadId, ASTRA);
              const gone = yield* invite(threadId, OPUS);
              yield* orchestrator.dispatch({
                type: "thread.delete",
                commandId: CommandId.make("command:group-delete:seat"),
                threadId: gone,
              });
              yield* script(harness.control, kept, ["Plain reply"]);
              yield* say(threadId, "go", "Go");
              const after = yield* settle(threadId);
              assert.isTrue(
                publishedRows(after).some((row) => row.label === "Astra"),
                "control: the remaining seat answered",
              );
              assert.lengthOf(
                yield* turnsOf(harness.control, gone),
                0,
                "a deleted seat never runs",
              );
              assert.equal(
                (yield* readGroup(threadId))!.seats.find((row) => row.threadId === gone)?.status,
                "left",
                "the roster stops listing it",
              );

              yield* orchestrator.dispatch({
                type: "thread.delete",
                commandId: CommandId.make("command:group-delete:parent"),
                threadId,
              });
              const seat = yield* orchestrator.getThreadProjection(kept);
              assert.isNotNull(seat.thread.deletedAt, "a seat goes with its thread");
            }),
          ).pipe(Effect.provide(harness.layer));
        }),
      ),
  );

  it.live("keeps seats on the thread's current modes and titles, and no seat writes a title", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness("modes");
        const threadId = ThreadId.make("thread:group:modes");
        yield* withReactor(
          Effect.gen(function* () {
            const orchestrator = yield* Orchestrator.OrchestratorV2;
            yield* startThread(threadId);
            const seat = yield* invite(threadId, ASTRA);
            yield* orchestrator.dispatch({
              type: "thread.runtime-mode.set",
              commandId: CommandId.make("command:group-modes:set"),
              threadId,
              runtimeMode: "approval-required",
            });
            yield* say(threadId, "go", "Go", [seat]);
            yield* settle(threadId);
            const projection = yield* orchestrator.getThreadProjection(seat);
            assert.equal(projection.thread.runtimeMode, "approval-required");
            assert.equal(projection.thread.title, "Astra");
            assert.isNull(projection.thread.titleRegeneration ?? null);
            assert.equal(projection.thread.lineage.sideChat, true);
          }),
        ).pipe(Effect.provide(harness.layer));
      }),
    ),
  );

  it.live("refuses an invite while the flag is off and still lets a group end", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness("flag");
        const threadId = ThreadId.make("thread:group:flag");
        yield* withReactor(
          Effect.gen(function* () {
            const service = yield* ThreadGroupService.ThreadGroupService;
            const settings = yield* ServerSettings.ServerSettingsService;
            yield* startThread(threadId);
            const seat = yield* invite(threadId, ASTRA);
            const other = yield* invite(threadId, OPUS);
            yield* settings.updateSettings({ groupConversationsEnabled: false });
            const refused = yield* service
              .invite({
                threadId,
                modelSelection: STEERLESS,
                createdBy: "user",
                creationSource: "web",
              })
              .pipe(Effect.flip);
            assert.equal(refused._tag, "ThreadGroupDisabledError");
            assert.lengthOf((yield* readGroup(threadId))!.seats, 2, "the refusal seats nobody");
            const orchestrator = yield* Orchestrator.OrchestratorV2;
            yield* orchestrator.dispatch({
              type: "thread.stop",
              commandId: CommandId.make("command:group:stop"),
              threadId,
            });
            assert.equal((yield* readGroup(threadId))?.status, "active");
            const removed = yield* service.remove({ threadId, seatThreadId: other });
            assert.equal(removed.seats.find((row) => row.threadId === other)?.status, "left");
            const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
            yield* worker.drain();
            const sideChatHold = yield* hold(harness.control, other);
            yield* say(other, "side", "Independent side chat");
            yield* Deferred.await(sideChatHold.started);
            yield* until(
              orchestrator
                .getThreadProjection(other)
                .pipe(Effect.map((p) => p.runs.at(-1)?.status === "running")),
            );
            yield* service.remove({ threadId, seatThreadId: other });
            yield* worker.drain();
            const formerSeat = yield* orchestrator.getThreadProjection(other);
            assert.equal(formerSeat.runs.at(-1)?.status, "running");
            yield* Deferred.succeed(sideChatHold.release, "completed");
            const ended = yield* service.end({ threadId });
            assert.equal(ended.status, "ended");
            assert.equal(ended.seats.find((row) => row.threadId === seat)?.status, "left");
          }),
        ).pipe(Effect.provide(harness.layer));
      }),
    ),
  );

  it.live("refuses an invite on an archived thread and creates no seat thread", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness("archived-invite");
        const threadId = ThreadId.make("thread:group:archived-invite");
        yield* withReactor(
          Effect.gen(function* () {
            const orchestrator = yield* Orchestrator.OrchestratorV2;
            const projections = yield* ProjectionStore.ProjectionStoreV2;
            const service = yield* ThreadGroupService.ThreadGroupService;
            yield* startThread(threadId);
            yield* orchestrator.dispatch({
              type: "thread.archive",
              commandId: CommandId.make("command:group:archived-invite"),
              threadId,
            });
            const refused = yield* service
              .invite({ threadId, modelSelection: ASTRA, createdBy: "user", creationSource: "web" })
              .pipe(Effect.flip);
            assert.equal(refused._tag, "ThreadGroupCommandError");
            const { threads } = yield* projections.getShellSnapshot();
            assert.isEmpty(threads.filter((row) => row.lineage.parentThreadId === threadId));
          }),
        ).pipe(Effect.provide(harness.layer));
      }),
    ),
  );

  it.live("returns a seat only when the whole selection matches, options included", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness("reinvite-options");
        const threadId = ThreadId.make("thread:group:reinvite-options");
        yield* withReactor(
          Effect.gen(function* () {
            const orchestrator = yield* Orchestrator.OrchestratorV2;
            const service = yield* ThreadGroupService.ThreadGroupService;
            yield* startThread(threadId);
            const seat = yield* invite(threadId, ASTRA);
            yield* service.end({ threadId });
            assert.equal(yield* invite(threadId, ASTRA), seat, "the same selection returns");
            yield* service.end({ threadId });
            const wanted: ModelSelection = {
              ...ASTRA,
              options: [{ id: "effort", value: "max" }],
            };
            const fresh = yield* invite(threadId, wanted);
            assert.notEqual(fresh, seat);
            const { thread } = yield* orchestrator.getThreadProjection(fresh);
            assert.deepEqual(thread.modelSelection, wanted);
            yield* service.end({ threadId });
            yield* orchestrator.dispatch({
              type: "thread.archive",
              commandId: CommandId.make("command:group:archive-former-seat"),
              threadId: fresh,
            });
            assert.notEqual(
              yield* invite(threadId, wanted),
              fresh,
              "an archived side chat stays archived",
            );
          }),
        ).pipe(Effect.provide(harness.layer));
      }),
    ),
  );

  it.live("waits for the primary and can settle past a reply published after it", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness("wait-primary");
        const threadId = ThreadId.make("thread:group:wait-primary");
        yield* withReactor(
          Effect.gen(function* () {
            const orchestrator = yield* Orchestrator.OrchestratorV2;
            yield* startThread(threadId);
            const seat = yield* invite(threadId, ASTRA);
            const primaryHold = yield* hold(harness.control, threadId);
            yield* say(threadId, "question", "Work on it", ["primary", seat]);
            yield* Deferred.await(primaryHold.started);
            yield* until(
              orchestrator
                .getThreadProjection(threadId)
                .pipe(Effect.map((row) => row.runs.some((run) => run.publication !== undefined))),
            );
            const running = yield* orchestrator.getThreadProjection(threadId);
            const primary = running.runs.find((run) => run.publication === undefined)!;
            assert.equal(ThreadManagementService.latestRun(running)?.id, primary.id);
            const waited = yield* Effect.forkChild(
              Effect.gen(function* () {
                const management = yield* ThreadManagementService.ThreadManagementService;
                return yield* management.waitForThread({ projectId, threadId, timeoutMs: 30_000 });
              }).pipe(
                Effect.provide(
                  ThreadManagementService.layer.pipe(
                    Layer.provide(Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({})),
                    Layer.provide(CommandReceiptStore.layer),
                  ),
                ),
              ),
            );
            yield* Deferred.succeed(primaryHold.release, "completed");
            const result = yield* Fiber.join(waited);
            assert.equal(result.run?.id, primary.id);
            assert.equal(result.run?.status, "completed");
            yield* settle(threadId);
            yield* orchestrator.dispatch({
              type: "thread.settle",
              commandId: CommandId.make("command:group:wait-primary-settle"),
              threadId,
              expectedLatestRunId: primary.id,
            });
          }),
        ).pipe(Effect.provide(harness.layer));
      }),
    ),
  );

  it.live("publishes a seat that finishes while the startup sweep reads it", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const hook = yield* Ref.make<((id: ThreadId) => Effect.Effect<void>) | null>(null);
        const harness = yield* makeHarness("sweep-race", {
          afterSeatRead: (id) =>
            Ref.get(hook).pipe(Effect.flatMap((run) => run?.(id) ?? Effect.void)),
        });
        const threadId = ThreadId.make("thread:group:sweep-race");
        yield* Effect.gen(function* () {
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const reactor = yield* GroupReactor.GroupReactor;
          const sink = yield* EventSink.EventSinkV2;
          const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
          yield* startThread(threadId);
          const seat = yield* invite(threadId, ASTRA);
          const seatHold = yield* hold(harness.control, seat);
          yield* script(harness.control, seat, ["FINISHED_DURING_SWEEP"]);
          yield* say(threadId, "question", "Astra, answer", [seat]);
          yield* Deferred.await(seatHold.started);
          yield* worker.drain();
          yield* Ref.set(hook, (id) =>
            id !== seat
              ? Effect.void
              : Effect.gen(function* () {
                  yield* Ref.set(hook, null);
                  const afterSequence = yield* sink.latestSequence();
                  yield* Deferred.succeed(seatHold.release, "completed");
                  yield* sink.stream({ afterSequence }).pipe(
                    Stream.filter(
                      ({ event }) =>
                        event.threadId === seat &&
                        event.type === "run.updated" &&
                        event.payload.status === "completed",
                    ),
                    Stream.take(1),
                    Stream.runDrain,
                  );
                }).pipe(Effect.orDie),
          );
          yield* reactor.start();
          yield* until(readGroup(threadId).pipe(Effect.map((row) => row?.discussion === null)));
          const parent = yield* orchestrator.getThreadProjection(threadId);
          assert.deepEqual(publishedRows(parent), [
            { label: "Astra", text: "FINISHED_DURING_SWEEP" },
          ]);
        }).pipe(Effect.provide(harness.layer));
      }),
    ),
  );

  it.live("publishes a seat's answer when a restart continues its turn", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness("restart");
        const threadId = ThreadId.make("thread:group:restart");
        yield* withReactor(
          Effect.gen(function* () {
            const orchestrator = yield* Orchestrator.OrchestratorV2;
            const recovery = yield* ProviderRuntimeRecovery.make.pipe(
              Effect.provide(Layer.mergeAll(IdAllocator.layer, EffectOutbox.layer)),
            );
            yield* startThread(threadId);
            const seat = yield* invite(threadId, ASTRA);
            const seatHold = yield* hold(harness.control, seat, "half way");
            yield* script(harness.control, seat, ["cut short", "CONTINUED final answer"]);
            yield* say(threadId, "question", "Ask the seat", [seat]);
            yield* Deferred.await(seatHold.started);
            yield* until(
              orchestrator
                .getThreadProjection(seat)
                .pipe(Effect.map((row) => row.providerTurns.some((t) => t.status === "running"))),
            );
            yield* recovery.reconcile("startup");
            yield* Deferred.succeed(seatHold.release, "completed");
            yield* until(
              orchestrator
                .getThreadProjection(threadId)
                .pipe(
                  Effect.map((row) =>
                    publishedRows(row).some((reply) => reply.text === "CONTINUED final answer"),
                  ),
                ),
            );
            const seatRuns = (yield* orchestrator.getThreadProjection(seat)).runs;
            assert.isDefined(seatRuns.at(-1)?.restartContinuationOfRunId);
            assert.equal(seatRuns.at(-1)?.groupThrough, seatRuns[0]?.groupThrough);
            const after = yield* settle(threadId);
            assert.deepEqual(
              publishedRows(after).map((row) => row.text),
              ["CONTINUED final answer"],
            );
          }),
        ).pipe(Effect.provide(harness.layer));
      }),
    ),
  );

  it.live.each(["startup", "shutdown"] as const)(
    "asks a seat again after a %s instead of keeping the question it lost",
    (trigger) =>
      Effect.scoped(
        Effect.gen(function* () {
          const harness = yield* makeHarness(`restart-question-${trigger}`);
          const threadId = ThreadId.make(`thread:group:restart-question-${trigger}`);
          yield* withReactor(
            Effect.gen(function* () {
              const orchestrator = yield* Orchestrator.OrchestratorV2;
              const eventSink = yield* EventSink.EventSinkV2;
              const recovery = yield* ProviderRuntimeRecovery.make.pipe(
                Effect.provide(Layer.mergeAll(IdAllocator.layer, EffectOutbox.layer)),
              );
              yield* startThread(threadId);
              const seat = yield* invite(threadId, ASTRA);
              const seatHold = yield* hold(harness.control, seat);
              yield* script(harness.control, seat, ["never finished", "ANSWER AFTER RESTART"]);
              yield* say(threadId, "question", "Ask the seat", [seat]);
              yield* Deferred.await(seatHold.started);
              yield* until(
                orchestrator
                  .getThreadProjection(seat)
                  .pipe(
                    Effect.map((row) =>
                      row.providerTurns.some((turn) => turn.status === "running"),
                    ),
                  ),
              );
              const asking = yield* orchestrator.getThreadProjection(seat);
              const run = asking.runs.at(-1)!;
              const session = asking.providerSessions[0]!;
              const requestId = RuntimeRequestId.make(`request:lost-${trigger}`);
              const now = yield* DateTime.now;
              yield* eventSink.write({
                commandId: CommandId.make(`command:seed-seat-question-${trigger}`),
                events: [
                  {
                    id: EventId.make(`event:seat-question-request-${trigger}`),
                    type: "runtime-request.updated",
                    threadId: seat,
                    nodeId: run.rootNodeId!,
                    occurredAt: now,
                    payload: {
                      id: requestId,
                      nodeId: run.rootNodeId!,
                      providerTurnId: null,
                      nativeRequestRef: null,
                      kind: "user_input",
                      status: "pending",
                      responseCapability: { type: "live", providerSessionId: session.id },
                      createdAt: now,
                      resolvedAt: null,
                    },
                  },
                  {
                    id: EventId.make(`event:seat-question-item-${trigger}`),
                    type: "turn-item.updated",
                    threadId: seat,
                    nodeId: run.rootNodeId!,
                    occurredAt: now,
                    payload: {
                      id: TurnItemId.make(`turn-item:seat-question-${trigger}`),
                      type: "user_input_request",
                      threadId: seat,
                      runId: run.id,
                      nodeId: run.rootNodeId!,
                      providerThreadId: null,
                      providerTurnId: null,
                      nativeItemRef: null,
                      parentItemId: null,
                      ordinal: 1_000,
                      status: "waiting",
                      title: null,
                      startedAt: now,
                      completedAt: null,
                      updatedAt: now,
                      requestId,
                      questions: [
                        { id: "color", header: "Color", question: "Which color?", options: [] },
                      ],
                    },
                  },
                ],
              });
              yield* recovery.reconcile(trigger);
              yield* Deferred.succeed(seatHold.release, "completed");
              yield* until(
                orchestrator
                  .getThreadProjection(threadId)
                  .pipe(
                    Effect.map((row) =>
                      publishedRows(row).some((reply) => reply.text === "ANSWER AFTER RESTART"),
                    ),
                  ),
              );
              const after = yield* orchestrator.getThreadProjection(seat);
              assert.deepEqual(
                after.runtimeRequests
                  .filter((request) => request.status === "pending")
                  .map((request) => request.id),
                [],
              );
            }),
          ).pipe(Effect.provide(harness.layer));
        }),
      ),
  );

  it.live.each([
    ["queued behind the running primary", "queue"],
    ["steered into the running primary", "auto"],
  ] as const)(
    "keeps a new discussion open past an older @user when the message is %s",
    ([, delivery]) =>
      Effect.scoped(
        Effect.gen(function* () {
          const harness = yield* makeHarness(`floor-${delivery}`);
          const threadId = ThreadId.make(`thread:group:floor-${delivery}`);
          yield* withReactor(
            Effect.gen(function* () {
              const orchestrator = yield* Orchestrator.OrchestratorV2;
              const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
              const publishedCount = (count: number) =>
                until(
                  orchestrator
                    .getThreadProjection(threadId)
                    .pipe(
                      Effect.map(
                        (row) =>
                          row.runs.filter((run) => run.publication?.type === "peer_reply").length >=
                          count,
                      ),
                    ),
                );
              yield* startThread(threadId);
              yield* say(threadId, "warm", "Warm up");
              yield* until(
                orchestrator
                  .getThreadProjection(threadId)
                  .pipe(Effect.map((row) => row.runs.at(-1)?.status === "completed")),
              );
              const seat = yield* invite(threadId, ASTRA);
              const other = yield* invite(threadId, STEERLESS);
              const primaryHold = yield* hold(harness.control, threadId, "long");
              yield* script(harness.control, seat, ["Done here.\n@user", "Second view"]);
              yield* script(harness.control, other, ["First plain", "Second plain"]);
              // Seats answer while the primary runs only when the message names them.
              const members = ["primary", seat, other] as const;
              yield* say(threadId, "first", "First question", members);
              yield* Deferred.await(primaryHold.started);
              yield* until(
                orchestrator
                  .getThreadProjection(threadId)
                  .pipe(Effect.map((row) => row.providerTurns.at(-1)?.status === "running")),
              );
              yield* publishedCount(2);
              yield* worker.drain();
              assert.equal((yield* readGroup(threadId))?.closedBecause, "settled");
              yield* say(threadId, "second", "Second question", members, delivery);
              const { runs } = yield* orchestrator.getThreadProjection(threadId);
              assert.equal(
                runs.some((run) => run.status === "queued"),
                delivery === "queue",
              );
              yield* publishedCount(4);
              yield* worker.drain();
              const group = yield* readGroup(threadId);
              assert.isNotNull(group?.discussion, "the new message still has the primary to hear");
              assert.isNull(group?.closedBecause);
              yield* Deferred.succeed(primaryHold.release, "completed");
              yield* settle(threadId);
            }),
          ).pipe(Effect.provide(harness.layer));
        }),
      ),
  );

  it.live("closes the discussion when the thread is archived, running or not", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness("archive");
        const threadId = ThreadId.make("thread:group:archive");
        yield* withReactor(
          Effect.gen(function* () {
            const orchestrator = yield* Orchestrator.OrchestratorV2;
            const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
            yield* startThread(threadId);
            const seat = yield* invite(threadId, ASTRA);
            const seatHold = yield* hold(harness.control, seat, "busy");
            yield* say(threadId, "question", "Ask the seat", [seat]);
            yield* Deferred.await(seatHold.started);
            yield* orchestrator.dispatch({
              type: "thread.archive",
              commandId: CommandId.make("command:group:archive"),
              threadId,
            });
            const archived = yield* readGroup(threadId);
            assert.isNull(archived?.discussion);
            assert.equal(archived?.closedBecause, "stopped");
            yield* Deferred.succeed(seatHold.release, "completed");
            yield* until(
              orchestrator
                .getThreadProjection(seat)
                .pipe(Effect.map((row) => row.runs.at(-1)?.status === "completed")),
            );
            yield* worker.drain();
            yield* orchestrator.dispatch({
              type: "thread.unarchive",
              commandId: CommandId.make("command:group:unarchive"),
              threadId,
            });
            assert.isNull((yield* readGroup(threadId))?.discussion);
            assert.lengthOf(yield* turnsOf(harness.control, seat), 1, "nothing new started");

            const { thread } = yield* orchestrator.getThreadProjection(threadId);
            yield* (yield* ProjectionStore.ProjectionStoreV2).apply({
              id: EventId.make("event:group:left-open"),
              type: "thread.group-updated",
              threadId,
              providerInstanceId: thread.providerInstanceId,
              occurredAt: thread.updatedAt,
              commandId: CommandId.make("command:group:left-open"),
              causationEventId: null,
              correlationId: null,
              actor: "system",
              metadata: {},
              payload: {
                ...thread,
                archivedAt: thread.updatedAt,
                group: {
                  ...thread.group!,
                  discussion: { mode: "direct", turnsLeft: 1, delivering: [] },
                },
              },
            } as never);
            yield* orchestrator.dispatch({
              type: "thread.group.advance",
              commandId: CommandId.make("command:group:advance-archived"),
              threadId,
            });
            assert.isNull(
              (yield* readGroup(threadId))?.discussion,
              "a discussion an earlier build left open on an archived thread closes",
            );
          }),
        ).pipe(Effect.provide(harness.layer));
      }),
    ),
  );

  it.live("moves a seat to the thread's checkout on its next turn, with a new session", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness("move");
        const threadId = ThreadId.make("thread:group:move");
        yield* withReactor(
          Effect.gen(function* () {
            const orchestrator = yield* Orchestrator.OrchestratorV2;
            const sink = yield* EventSink.EventSinkV2;
            yield* startThread(threadId);
            const seat = yield* invite(threadId, ASTRA);
            yield* say(threadId, "first", "First", [seat]);
            yield* settle(threadId);
            yield* orchestrator.dispatch({
              type: "thread.metadata.update",
              commandId: CommandId.make("command:group:move"),
              threadId,
              branch: "feature/moved",
              worktreePath: "/work/moved",
            });
            yield* say(threadId, "second", "Second", [seat]);
            yield* settle(threadId);
            const after = yield* orchestrator.getThreadProjection(seat);
            assert.equal(after.thread.worktreePath, "/work/moved");
            assert.equal(after.thread.branch, "feature/moved");
            const detached = yield* sink
              .stream({
                threadId: seat,
                afterSequence: 0,
                eventType: "provider-session.detached",
              })
              .pipe(Stream.take(1), Stream.runCollect);
            assert.deepEqual(
              Array.from(detached).map(({ event }) =>
                event.type === "provider-session.detached" ? event.payload.reason : null,
              ),
              ["Workspace changed."],
              "the old checkout's session is released, as for any thread that moves",
            );
          }),
        ).pipe(Effect.provide(harness.layer));
      }),
    ),
  );

  it.live("names the model the primary is running once the picker moves it", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness("switched-primary");
        const threadId = ThreadId.make("thread:group:switched-primary");
        yield* withReactor(
          Effect.gen(function* () {
            const orchestrator = yield* Orchestrator.OrchestratorV2;
            yield* startThread(threadId);
            const seat = yield* invite(threadId, ASTRA);
            yield* orchestrator.dispatch({
              type: "thread.model-selection.set",
              commandId: CommandId.make("command:group:switch"),
              threadId,
              modelSelection: OPUS,
            });
            yield* say(threadId, "question", "Thoughts?");
            yield* settle(threadId);
            const group = yield* readGroup(threadId);
            assert.deepEqual(group?.primary, {
              model: OPUS.model,
              label: OPUS.model,
              handle: "opus",
            });
            const seatPrompt = (yield* turnsOf(harness.control, seat))[0]!.text.split("\n")[0]!;
            assert.include(seatPrompt, `${OPUS.model} (@opus)`);
            assert.notInclude(seatPrompt, "Fable");
          }),
        ).pipe(Effect.provide(harness.layer));
      }),
    ),
  );

  it.live("spends what an open discussion has left on an agent's message, and labels it", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness("agent-discuss");
        const threadId = ThreadId.make("thread:group:agent-discuss");
        yield* withReactor(
          Effect.gen(function* () {
            const service = yield* ThreadGroupService.ThreadGroupService;
            yield* startThread(threadId);
            const seat = yield* invite(threadId, ASTRA);
            const fresh = yield* service.discuss({
              threadId,
              text: "AGENTWORDS one",
              createdBy: "agent",
              creationSource: "mcp",
            });
            assert.equal(
              fresh.discussion?.turnsLeft,
              3,
              "no discussion was open, so a fresh budget, and only the primary starts",
            );
            yield* settle(threadId);
            const told = (yield* turnsOf(harness.control, seat))[0]!.text;
            assert.include(told, "[Agent]\nAGENTWORDS one");
            assert.notInclude(told, "[User]");

            const seatHold = yield* hold(harness.control, seat);
            yield* say(threadId, "question", "One question", [seat]);
            yield* Deferred.await(seatHold.started);
            assert.equal((yield* readGroup(threadId))!.discussion!.turnsLeft, 3);
            const both = [fresh.primary.handle, fresh.seats[0]!.handle];
            const spent = yield* service.discuss({
              threadId,
              text: "AGENTWORDS two",
              to: both,
              createdBy: "agent",
              creationSource: "mcp",
            });
            assert.equal(spent.discussion?.turnsLeft, 1, "an open discussion is not refilled");
            const refused = yield* service
              .discuss({
                threadId,
                text: "AGENTWORDS three",
                to: both,
                createdBy: "agent",
                creationSource: "mcp",
              })
              .pipe(Effect.flip);
            assert.equal(refused._tag, "ThreadGroupCommandError");
            yield* Deferred.succeed(seatHold.release, "completed");
            const parent = yield* settle(threadId);
            assert.notInclude(
              parent.turnItems.flatMap((item) => (item.type === "user_message" ? [item.text] : [])),
              "AGENTWORDS three",
            );
          }),
        ).pipe(Effect.provide(harness.layer));
      }),
    ),
  );

  it.live("tells the primary about the group on a user's message, not on its wake", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness("primary-note");
        const threadId = ThreadId.make("thread:group:primary-note");
        yield* withReactor(
          Effect.gen(function* () {
            const orchestrator = yield* Orchestrator.OrchestratorV2;
            const noteOf = (text: string) => text.includes("in a group conversation with the user");
            yield* startThread(threadId);
            yield* say(threadId, "solo", "Before the group");
            yield* until(
              orchestrator
                .getThreadProjection(threadId)
                .pipe(Effect.map((row) => row.runs.at(-1)?.status === "completed")),
            );
            const seat = yield* invite(threadId, ASTRA);
            yield* script(harness.control, seat, ["Use a log."]);
            yield* say(threadId, "everyone", "Which design?");
            const parent = yield* settle(threadId);
            const turns = yield* turnsOf(harness.control, threadId);
            assert.isFalse(noteOf(turns[0]!.text), "no group existed yet");
            assert.isTrue(noteOf(turns[1]!.text));
            assert.include(turns[1]!.text, "You are Fable, known here as @fable");
            assert.include(turns[1]!.text, "Astra (@");
            assert.include(turns[1]!.text, "You answer first");
            assert.include(turns[1]!.text, "`@user` closes the discussion");
            assert.include(turns[1]!.text, "Which design?");
            assert.isAbove(turns.length, 2, "the primary woke for Astra's reply");
            assert.isFalse(noteOf(turns.at(-1)!.text), "a wake has its own prompt");
            const visible = parent.turnItems.flatMap((item) =>
              item.type === "user_message" ? [item.text] : [],
            );
            assert.includeMembers(visible, ["Which design?"]);
            assert.isFalse(visible.some(noteOf), "the note stays out of the visible row");
            assert.isFalse(
              (yield* turnsOf(harness.control, seat)).some((turn) =>
                turn.text.startsWith("You are Fable"),
              ),
            );

            yield* say(threadId, "direct", "Only you", ["primary"]);
            yield* settle(threadId);
            const direct = (yield* turnsOf(harness.control, threadId)).at(-1)!.text;
            assert.isTrue(noteOf(direct));
            assert.notInclude(direct, "You answer first");
          }),
        ).pipe(Effect.provide(harness.layer));
      }),
    ),
  );

  it.live("marks a discussion finished when only peers have spoken on the thread", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness("peer-only-unread");
        const threadId = ThreadId.make("thread:group:peer-only-unread");
        yield* withReactor(
          Effect.gen(function* () {
            const orchestrator = yield* Orchestrator.OrchestratorV2;
            const projections = yield* ProjectionStore.ProjectionStoreV2;
            yield* startThread(threadId);
            const seat = yield* invite(threadId, ASTRA);
            yield* say(threadId, "question", "Astra, answer this", [seat]);
            const running = yield* orchestrator.getThreadShell(threadId);
            assert.isNull(running?.latestRunCompletedAt ?? null, "still open");
            const parent = yield* settle(threadId);
            const closedAt = DateTime.makeUnsafe(parent.thread.group!.closedAt!);
            const shell = yield* orchestrator.getThreadShell(threadId);
            const { threads } = yield* projections.getShellSnapshot();
            const listed = threads.find((row) => row.id === threadId);
            for (const row of [shell, listed]) {
              assert.isNull(row?.latestRunId ?? null, "publication runs still present as no run");
              assert.deepEqual(row?.latestRunCompletedAt, closedAt);
            }
          }),
        ).pipe(Effect.provide(harness.layer));
      }),
    ),
  );
});
