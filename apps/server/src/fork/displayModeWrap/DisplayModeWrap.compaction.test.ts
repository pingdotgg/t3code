import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  EventId,
  MessageId,
  NodeId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  ProviderTurnId,
  RunId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2DomainEvent,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import { CHAT_REPLIES_DISPLAY_MODE, displayNote } from "@t3tools/shared/displayModes";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerConfig from "../../config.ts";
import * as EventSink from "../../orchestration-v2/EventSink.ts";
import * as EventStore from "../../orchestration-v2/EventStore.ts";
import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import * as ProviderEventIngestor from "../../orchestration-v2/ProviderEventIngestor.ts";
import * as ThreadCommandExecutor from "../../orchestration-v2/ThreadCommandExecutor.ts";
import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import * as ProviderInstanceRegistry from "../../provider/ProviderInstanceRegistry.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as GitVcsDriver from "../../vcs/GitVcsDriver.ts";
import * as DisplayModeWrap from "./DisplayModeWrap.ts";
import { layerNoProviders } from "./DisplayModeWrap.testkit.ts";

const threadId = ThreadId.make("thread:display-wrap-compaction");
const runId = RunId.make("run:display-wrap-compaction");
const nodeId = NodeId.make("node:display-wrap-compaction");
const providerInstanceId = ProviderInstanceId.make("display-wrap-compaction");

const database = SqlitePersistence.layerMemory;
const stores = Layer.merge(EventStore.layer, ProjectionStore.layer).pipe(Layer.provide(database));
const wrapper = DisplayModeWrap.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      database,
      ServerSettings.layerTest({ threadDisplayModes: { [threadId]: "chat-replies" } }),
      layerNoProviders,
    ),
  ),
);
const git = GitVcsDriver.layer.pipe(
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "display-wrap-compaction-" })),
  Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
);
const ingestor = ProviderEventIngestor.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      Layer.mock(ProviderInstanceRegistry.ProviderInstanceRegistry)({
        getInstance: () => Effect.undefined,
      }),
      stores,
      EventSink.layer.pipe(Layer.provide(Layer.mergeAll(stores, database))),
      IdAllocator.layer,
      ThreadCommandExecutor.layer,
      git,
      wrapper,
    ),
  ),
);
const layer = Layer.mergeAll(stores, wrapper, ingestor);

/** The run's prompt is `text`. */
const seedRun = Effect.fn("seedRun")(function* (text: string) {
  const now = yield* DateTime.now;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const modelSelection = { instanceId: providerInstanceId, model: "model" };
  const messageId = MessageId.make("message:display-wrap-compaction");
  const events: ReadonlyArray<OrchestrationV2DomainEvent> = [
    {
      id: EventId.make("display-wrap-compaction:thread"),
      type: "thread.created",
      threadId,
      occurredAt: now,
      payload: {
        id: threadId,
        projectId: ProjectId.make("project:display-wrap-compaction"),
        title: "Compaction",
        providerInstanceId,
        modelSelection,
        createdBy: "user",
        creationSource: "web",
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        activeProviderThreadId: null,
        lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
        forkedFrom: null,
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        lastVisitedAt: null,
        deletedAt: null,
      },
    },
    {
      id: EventId.make("display-wrap-compaction:run"),
      type: "run.created",
      threadId,
      occurredAt: now,
      payload: {
        id: runId,
        threadId,
        ordinal: 1,
        providerInstanceId,
        modelSelection,
        providerThreadId: null,
        userMessageId: messageId,
        rootNodeId: nodeId,
        activeAttemptId: null,
        status: "running",
        requestedAt: now,
        startedAt: now,
        completedAt: null,
        checkpointId: null,
        contextHandoffId: null,
      },
    },
    {
      id: EventId.make("display-wrap-compaction:message"),
      type: "message.updated",
      threadId,
      occurredAt: now,
      payload: {
        id: messageId,
        threadId,
        runId,
        nodeId,
        role: "user",
        text,
        attachments: [],
        streaming: false,
        createdBy: "user",
        creationSource: "web",
        createdAt: now,
        updatedAt: now,
      },
    },
  ];
  yield* Effect.forEach(events, (event) => projections.apply(event), { discard: true });
});

const ingest = Effect.fn("ingest")(function* (event: ProviderAdapter.ProviderAdapterV2Event) {
  const ingestor = yield* ProviderEventIngestor.ProviderEventIngestorV2;
  yield* ingestor.ingestNormalized({
    providerSessionId: ProviderSessionId.make("session:display-wrap-compaction"),
    providerInstanceId,
    threadId,
    runId,
    event,
  });
});

const compaction = (driver: string, status: "running" | "completed") =>
  DateTime.now.pipe(
    Effect.flatMap((now) =>
      ingest({
        type: "turn_item.updated",
        driver: ProviderDriverKind.make(driver),
        turnItem: {
          id: TurnItemId.make(`item:display-wrap-compaction:${driver}`),
          threadId,
          runId,
          nodeId,
          providerThreadId: null,
          providerTurnId: null,
          nativeItemRef: null,
          parentItemId: null,
          ordinal: 1,
          status,
          title: null,
          startedAt: now,
          completedAt: status === "completed" ? now : null,
          updatedAt: now,
          type: "compaction",
          driver: ProviderDriverKind.make(driver),
        },
      }),
    ),
  );

const runCompleted = (driver: string) =>
  ingest({
    type: "turn.terminal",
    driver: ProviderDriverKind.make(driver),
    providerThreadId: ProviderThreadId.make("provider-thread:display-wrap-compaction"),
    providerTurnId: ProviderTurnId.make("provider-turn:display-wrap-compaction"),
    runOrdinal: 1,
    status: "completed",
    failure: null,
    threadDisposition: "reusable",
  });

/** The note for an agent that may have lost its notes in this thread, which has no Dashboard. */
const stateNote = displayNote("unknown", { mode: CHAT_REPLIES_DISPLAY_MODE, dashboard: false });

let sent = 0;
/** The note before the Chat mode block of the next typed message, which then counts as told. */
const nextNote = Effect.gen(function* () {
  const wrap = yield* DisplayModeWrap.DisplayModeWrap;
  sent += 1;
  const text = `Message ${sent}`;
  const wrapped = yield* wrap.wrapUserText({
    threadId,
    message: {
      id: MessageId.make(`message:${sent}`),
      createdBy: "user",
      creationSource: "web",
      text,
    },
    text,
  });
  yield* wrapped.accepted;
  const block = wrapped.text.indexOf("<t3-replies-mode>");
  return block === 0 ? null : wrapped.text.slice(0, block - 1);
});

it.effect("tells the agent its mode again after the first completion of a compaction item", () =>
  Effect.gen(function* () {
    yield* seedRun("Work on it.");
    assert.strictEqual(yield* nextNote, CHAT_REPLIES_DISPLAY_MODE.notice);
    yield* compaction("opencode", "running");
    assert.isNull(yield* nextNote);
    yield* compaction("opencode", "completed");
    assert.strictEqual(yield* nextNote, stateNote);
    yield* compaction("opencode", "completed");
    assert.isNull(yield* nextNote);
  }).pipe(Effect.provide(layer)),
);

it.effect("leaves the notes of Claude and Codex, which send the note after a compaction", () =>
  Effect.gen(function* () {
    yield* seedRun("/compact");
    assert.strictEqual(yield* nextNote, CHAT_REPLIES_DISPLAY_MODE.notice);
    for (const driver of ["claudeAgent", "codex"]) {
      yield* compaction(driver, "completed");
      yield* runCompleted(driver);
      assert.isNull(yield* nextNote);
    }
  }).pipe(Effect.provide(layer)),
);

it.effect("tells the agent its mode again after a /compact run that reports no compaction", () =>
  Effect.gen(function* () {
    yield* seedRun("/compact");
    assert.strictEqual(yield* nextNote, CHAT_REPLIES_DISPLAY_MODE.notice);
    yield* runCompleted("cursor");
    assert.strictEqual(yield* nextNote, stateNote);
  }).pipe(Effect.provide(layer)),
);

it.effect("keeps the notes when a run with another prompt ends", () =>
  Effect.gen(function* () {
    yield* seedRun("Work on it.");
    assert.strictEqual(yield* nextNote, CHAT_REPLIES_DISPLAY_MODE.notice);
    yield* runCompleted("cursor");
    assert.isNull(yield* nextNote);
  }).pipe(Effect.provide(layer)),
);
