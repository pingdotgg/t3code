import { assert, it } from "@effect/vitest";
import {
  CIVILIZATION_CONFIG_VERSION,
  CommandId,
  EventId,
  type OrchestrationV2AppThread,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as EventStore from "../orchestration-v2/EventStore.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ConfigService from "./ConfigService.ts";
import { civilizationPersistenceParticipant } from "./PersistenceParticipant.ts";
import { makeCivilizationTitleTransform } from "./TitleOwnership.ts";

const database = SqlitePersistence.layerMemory;
const stores = Layer.merge(EventStore.layer, ProjectionStore.layer).pipe(Layer.provide(database));
const sink = EventSink.layer.pipe(
  Layer.provide(Layer.mergeAll(stores, database)),
  Layer.provide(
    Layer.succeed(EventSink.EventSinkPersistenceParticipants, [civilizationPersistenceParticipant]),
  ),
);
const layer = Layer.mergeAll(
  database,
  stores,
  sink,
  ConfigService.layer.pipe(Layer.provide(database)),
);

const providerInstanceId = ProviderInstanceId.make("codex");

function makeThread(
  id: ThreadId,
  projectId: ProjectId,
  at: DateTime.Utc,
  overrides: Partial<OrchestrationV2AppThread> = {},
): OrchestrationV2AppThread {
  return {
    createdBy: "user",
    creationSource: "web",
    id,
    projectId,
    title: "New thread",
    providerInstanceId,
    modelSelection: { instanceId: providerInstanceId, model: "civilization-phase1" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: id },
    forkedFrom: null,
    createdAt: at,
    updatedAt: at,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
    ...overrides,
  };
}

const enableTitles = Effect.fn("TitleOwnership.test.enableTitles")(function* () {
  const config = yield* ConfigService.CivilizationConfigService;
  yield* config.set({
    expectedRevision: 0,
    override: {
      version: CIVILIZATION_CONFIG_VERSION,
      participation: { enabled: true },
      names: {
        pools: [{ id: "main", entries: [{ id: "ada", displayName: "Ada", weight: 1 }] }],
        selectedPoolId: "main",
        automaticTitles: true,
        titleTemplate: "[{name}] {topic}",
      },
    },
  });
});

type TitleRow = {
  readonly title_managed: number;
  readonly preserved_title: string | null;
  readonly last_managed_title: string | null;
  readonly title_topic: string;
  readonly pending_title_command_id: string | null;
  readonly pending_managed_title: string | null;
};

const readTitleRow = Effect.fn("TitleOwnership.test.readTitleRow")(function* (threadId: ThreadId) {
  const sql = yield* SqlClient.SqlClient;
  return (yield* sql<TitleRow>`
      SELECT title_managed, preserved_title, last_managed_title, title_topic,
             pending_title_command_id, pending_managed_title
      FROM civilization_citizens WHERE thread_id = ${threadId}
    `)[0]!;
});

it.effect(
  "composes a managed title and finalizes ownership only for the exact pending completion",
  () =>
    Effect.gen(function* () {
      yield* enableTitles();
      const eventSink = yield* EventSink.EventSinkV2;
      const sql = yield* SqlClient.SqlClient;
      const now = yield* DateTime.now;
      const projectId = ProjectId.make("project:civilization:title");
      const threadId = ThreadId.make("thread:civilization:title");
      const thread = makeThread(threadId, projectId, now);
      yield* eventSink.write({
        events: [
          {
            id: EventId.make("event:civilization:title:create"),
            type: "thread.created",
            threadId,
            occurredAt: now,
            payload: thread,
          },
        ],
      });

      const requestId = CommandId.make("command:civilization:title:request");
      const managed = yield* makeCivilizationTitleTransform(sql).transform({
        threadId,
        requestId,
        generatedTitle: "Fresh topic",
      });
      assert.equal(managed, "[Ada] Fresh topic");
      const pending = yield* readTitleRow(threadId);
      assert.equal(pending.pending_title_command_id, `${requestId}:title-complete`);
      assert.equal(pending.pending_managed_title, managed);
      assert.isNull(pending.last_managed_title);

      const landed = { ...thread, title: managed, updatedAt: now };
      yield* eventSink.write({
        commandId: CommandId.make(`${requestId}:title-complete`),
        events: [
          {
            id: EventId.make("event:civilization:title:complete"),
            type: "thread.metadata-updated",
            threadId,
            occurredAt: now,
            payload: landed,
          },
        ],
      });
      const finalized = yield* readTitleRow(threadId);
      assert.equal(finalized.title_managed, 1);
      assert.equal(finalized.last_managed_title, managed);
      assert.equal(finalized.title_topic, "Fresh topic");
      assert.isNull(finalized.pending_title_command_id);
    }).pipe(Effect.provide(Layer.fresh(layer))),
);

it.effect(
  "manual rename relinquishes ownership while an armed host title regeneration does not",
  () =>
    Effect.gen(function* () {
      yield* enableTitles();
      const eventSink = yield* EventSink.EventSinkV2;
      const now = yield* DateTime.now;
      const projectId = ProjectId.make("project:civilization:title-manual");
      const threadId = ThreadId.make("thread:civilization:title-manual");
      const thread = makeThread(threadId, projectId, now);
      yield* eventSink.write({
        events: [
          {
            id: EventId.make("event:civilization:title-manual:create"),
            type: "thread.created",
            threadId,
            occurredAt: now,
            payload: thread,
          },
        ],
      });

      const requestId = CommandId.make("command:civilization:title-manual:armed");
      const seeded = {
        ...thread,
        title: "Host initial title",
        titleRegeneration: { requestId, startedAt: now },
        updatedAt: now,
      };
      yield* eventSink.write({
        commandId: requestId,
        events: [
          {
            id: EventId.make("event:civilization:title-manual:seed"),
            type: "thread.metadata-updated",
            threadId,
            occurredAt: now,
            payload: seeded,
          },
        ],
      });
      assert.equal((yield* readTitleRow(threadId)).title_managed, 1);

      const renamed = { ...seeded, title: "User title", titleRegeneration: null, updatedAt: now };
      yield* eventSink.write({
        commandId: CommandId.make("command:civilization:title-manual:rename"),
        events: [
          {
            id: EventId.make("event:civilization:title-manual:rename"),
            type: "thread.metadata-updated",
            threadId,
            occurredAt: now,
            payload: renamed,
          },
        ],
      });
      const relinquished = yield* readTitleRow(threadId);
      assert.equal(relinquished.title_managed, 0);
      assert.equal(relinquished.preserved_title, "User title");
    }).pipe(Effect.provide(Layer.fresh(layer))),
);
