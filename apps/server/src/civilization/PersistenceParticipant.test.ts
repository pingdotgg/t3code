import { assert, it } from "@effect/vitest";
import {
  CIVILIZATION_CONFIG_VERSION,
  CIVILIZATION_NAME_GENERATOR_VERSION,
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
import * as Random from "effect/Random";
import * as SqlClient from "effect/sql/SqlClient";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as EventStore from "../orchestration-v2/EventStore.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ConfigService from "./ConfigService.ts";
import {
  civilizationPersistenceParticipant,
  enrollCivilizationThread,
} from "./PersistenceParticipant.ts";

const databaseLayer = SqlitePersistence.layerMemory;
const storesLayer = Layer.merge(EventStore.layer, ProjectionStore.layer).pipe(
  Layer.provide(databaseLayer),
);
const participantLayer = Layer.succeed(EventSink.EventSinkPersistenceParticipants, [
  civilizationPersistenceParticipant,
]);
const sinkLayer = EventSink.layer.pipe(
  Layer.provide(Layer.mergeAll(storesLayer, databaseLayer)),
  Layer.provide(participantLayer),
);
const layer = Layer.mergeAll(
  databaseLayer,
  storesLayer,
  sinkLayer,
  ConfigService.layer.pipe(Layer.provide(databaseLayer)),
);

const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "civilization-phase1" };

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
    providerInstanceId: instanceId,
    modelSelection,
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

type CitizenRow = {
  readonly thread_id: string;
  readonly name_display: string;
  readonly name_key: string;
  readonly name_entry_id: string;
  readonly name_generator_version: number;
  readonly profile_entry_id: string;
  readonly parent_thread_id: string | null;
  readonly relationship_to_parent: "fork" | "subagent" | null;
  readonly observed_only: number;
  readonly title_managed: number;
  readonly generation: number;
  readonly lineage_status: string;
  readonly epoch: number;
  readonly closed: number;
  readonly deleted: number;
  readonly delivery_epoch: number;
  readonly delivery_settled: number;
  readonly delivery_archived: number;
  readonly delivery_deleted: number;
  readonly last_applied_sequence: number;
  readonly revision: number;
};

type MessageRow = {
  readonly message_id: string;
  readonly terminal_at: string | null;
  readonly terminal_reason: string | null;
  readonly acknowledged_at: string | null;
};

const readCitizen = Effect.fn("PersistenceParticipant.test.readCitizen")(function* (
  threadId: ThreadId,
) {
  const sql = yield* SqlClient.SqlClient;
  return (yield* sql<CitizenRow>`
      SELECT thread_id, name_display, name_key, name_entry_id, name_generator_version, profile_entry_id,
             parent_thread_id, relationship_to_parent, generation, lineage_status, observed_only,
             title_managed, epoch, closed, deleted,
             delivery_epoch, delivery_settled, delivery_archived, delivery_deleted,
             last_applied_sequence, revision
      FROM civilization_citizens WHERE thread_id = ${threadId} LIMIT 1
    `)[0];
});

const insertMessage = Effect.fn("PersistenceParticipant.test.insertMessage")(function* (input: {
  readonly messageId: string;
  readonly projectId: ProjectId;
  readonly recipientThreadId: ThreadId;
  readonly recipientDeliveryEpoch: number;
  readonly acceptedAt: string;
  readonly offered?: boolean;
  readonly acknowledged?: boolean;
  readonly terminalReason?: "expired" | "purged";
}) {
  const sql = yield* SqlClient.SqlClient;
  const offeredAt = input.offered === true ? input.acceptedAt : null;
  const acknowledgedAt = input.acknowledged === true ? input.acceptedAt : null;
  const terminalAt = input.terminalReason === undefined ? null : input.acceptedAt;
  yield* sql`
    INSERT INTO civilization_messages (
      message_id, project_id, sender_thread_id, sender_name_at_send,
      sender_citizen_epoch, sender_run_id, recipient_thread_id, recipient_delivery_epoch,
      reply_to_message_id, body, body_bytes,
      accepted_runtime_mode, accepted_interaction_mode,
      accepted_environment_revision, accepted_project_revision,
      accepted_at, expires_at, terminal_retention_days,
      first_offered_at, last_offered_at, offer_count,
      acknowledged_at, terminal_at, terminal_reason
    ) VALUES (
      ${input.messageId}, ${input.projectId}, ${`${input.recipientThreadId}:sender`}, 'Sender',
      0, ${`${input.messageId}:run`}, ${input.recipientThreadId}, ${input.recipientDeliveryEpoch},
      NULL, 'mail', 4,
      'full-access', 'default', 0, 0,
      ${input.acceptedAt}, ${input.acceptedAt}, 30,
      ${offeredAt}, ${offeredAt}, ${input.offered === true ? 1 : 0},
      ${acknowledgedAt}, ${terminalAt}, ${input.terminalReason ?? null}
    )
  `;
});

const readMessages = Effect.fn("PersistenceParticipant.test.readMessages")(function* (
  projectId: ProjectId,
) {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql<MessageRow>`
    SELECT message_id, terminal_at, terminal_reason, acknowledged_at
    FROM civilization_messages
    WHERE project_id = ${projectId}
    ORDER BY message_id ASC
  `;
});

const enableFeature = Effect.fn("PersistenceParticipant.test.enableFeature")(function* () {
  const service = yield* ConfigService.CivilizationConfigService;
  yield* service.set({
    expectedRevision: 0,
    override: {
      version: CIVILIZATION_CONFIG_VERSION,
      participation: { enabled: true },
      names: {
        pools: [{ id: "single", entries: [{ id: "ada", displayName: "Ada", weight: 1 }] }],
        selectedPoolId: "single",
      },
    },
  });
});

it.effect(
  "enrolls one durable identity per created thread and resolves forced name collisions",
  () =>
    Effect.gen(function* () {
      const sink = yield* EventSink.EventSinkV2;
      yield* enableFeature();
      const now = yield* DateTime.now;
      const projectId = ProjectId.make("project:civilization:identity");
      const firstId = ThreadId.make("thread:civilization:identity:1111dead");
      const secondId = ThreadId.make("thread:civilization:identity:2222dead");

      for (const [index, threadId] of [firstId, secondId].entries()) {
        const thread = makeThread(threadId, projectId, now);
        const stored = yield* sink.write({
          events: [
            {
              id: EventId.make(`event:civilization:identity:${index}`),
              type: "thread.created",
              threadId,
              occurredAt: now,
              payload: thread,
            },
          ],
        });
        assert.lengthOf(stored, 1);
        yield* sink.write({
          events: [],
        });
      }

      const first = yield* readCitizen(firstId);
      const second = yield* readCitizen(secondId);
      assert.isDefined(first);
      assert.isDefined(second);
      assert.equal(first?.name_display, "Ada");
      assert.match(second?.name_display ?? "", /^Ada~/);
      assert.notEqual(first?.name_key, second?.name_key);
      assert.equal(first?.profile_entry_id.length > 0, true);
      assert.equal(first?.name_generator_version, CIVILIZATION_NAME_GENERATOR_VERSION);

      const sql = yield* SqlClient.SqlClient;
      const count = (yield* sql<{
        readonly count: number;
      }>`SELECT COUNT(*) AS count FROM civilization_citizens`)[0]!.count;
      assert.equal(count, 2);
    }).pipe(Effect.provide(Layer.fresh(layer))),
);

it.effect("does not let corrupt optional Civilization config roll back host thread creation", () =>
  Effect.gen(function* () {
    const sink = yield* EventSink.EventSinkV2;
    const sql = yield* SqlClient.SqlClient;
    const now = yield* DateTime.now;
    const projectId = ProjectId.make("project:civilization:corrupt-enrollment");
    const threadId = ThreadId.make("thread:civilization:corrupt-enrollment");
    yield* sql`
      UPDATE civilization_environment_config
      SET revision = 1,
          override_json = ${JSON.stringify({ version: CIVILIZATION_CONFIG_VERSION, context: { packetBytes: 999_999 } })}
      WHERE singleton = 1
    `;
    const thread = makeThread(threadId, projectId, now);
    const stored = yield* sink.write({
      events: [
        {
          id: EventId.make("event:civilization:corrupt-enrollment"),
          type: "thread.created",
          threadId,
          occurredAt: now,
          payload: thread,
        },
      ],
    });
    assert.lengthOf(stored, 1);
    assert.isUndefined(yield* readCitizen(threadId));
  }).pipe(Effect.provide(Layer.fresh(layer))),
);

it.effect("uses the injectable Effect random service for the stored weighted name draw", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const config = yield* ConfigService.CivilizationConfigService;
    const now = yield* DateTime.now;
    const projectId = ProjectId.make("project:civilization:weighted-random");
    const threadId = ThreadId.make("thread:civilization:weighted-random");
    const entries = [
      { id: "ada", displayName: "Ada", weight: 6 },
      { id: "grace", displayName: "Grace", weight: 3 },
      { id: "linus", displayName: "Linus", weight: 1 },
    ] as const;
    yield* config.set({
      expectedRevision: 0,
      override: {
        version: CIVILIZATION_CONFIG_VERSION,
        participation: { enabled: true },
        names: { pools: [{ id: "weighted", entries }], selectedPoolId: "weighted" },
      },
    });
    const expectedDraw = yield* Random.nextIntBetween(0, 10, { halfOpen: true }).pipe(
      Random.withSeed("civilization-phase1-weighted-draw"),
    );
    const expected = ConfigService.weightedCivilizationEntry(entries, expectedDraw);
    yield* sql.withTransaction(
      enrollCivilizationThread({
        sequence: 1,
        thread: makeThread(threadId, projectId, now),
        adoption: false,
      }).pipe(
        Effect.provideService(SqlClient.SqlClient, sql),
        Random.withSeed("civilization-phase1-weighted-draw"),
      ),
    );
    const citizen = yield* readCitizen(threadId);
    assert.equal(citizen?.name_entry_id, expected.id);
    assert.equal(citizen?.name_generator_version, CIVILIZATION_NAME_GENERATOR_VERSION);
  }).pipe(Effect.provide(Layer.fresh(layer))),
);

it.effect(
  "initializes delivery components from adopted thread state without advancing its epoch",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* enableFeature();
      const now = yield* DateTime.now;
      const projectId = ProjectId.make("project:civilization:delivery-adoption");
      const threadId = ThreadId.make("thread:civilization:delivery-adoption");
      const thread = makeThread(threadId, projectId, now, {
        settledOverride: "settled",
        settledAt: now,
        archivedAt: now,
      });

      yield* enrollCivilizationThread({ sequence: 7, thread, adoption: true }).pipe(
        Effect.provideService(SqlClient.SqlClient, sql),
      );

      const citizen = yield* readCitizen(threadId);
      assert.deepEqual(
        {
          epoch: citizen?.epoch,
          deliveryEpoch: citizen?.delivery_epoch,
          settled: citizen?.delivery_settled,
          archived: citizen?.delivery_archived,
          deleted: citizen?.delivery_deleted,
        },
        { epoch: 0, deliveryEpoch: 0, settled: 1, archived: 1, deleted: 0 },
      );
    }).pipe(Effect.provide(Layer.fresh(layer))),
);

it.effect(
  "keeps provider-native children observed-only and applies controllable-child inclusion to forks",
  () =>
    Effect.gen(function* () {
      const sink = yield* EventSink.EventSinkV2;
      const config = yield* ConfigService.CivilizationConfigService;
      const now = yield* DateTime.now;
      const projectId = ProjectId.make("project:civilization:observed-child");
      const parentId = ThreadId.make("thread:civilization:observed-child:parent");
      const observedId = ThreadId.make("thread:civilization:observed-child:native");
      const forkId = ThreadId.make("thread:civilization:observed-child:fork");
      yield* config.set({
        expectedRevision: 0,
        override: {
          version: CIVILIZATION_CONFIG_VERSION,
          participation: { enabled: true, includeControllableChildren: false },
        },
      });
      yield* sink.write({
        events: [
          {
            id: EventId.make("event:civilization:observed-child:parent"),
            type: "thread.created",
            threadId: parentId,
            occurredAt: now,
            payload: makeThread(parentId, projectId, now),
          },
        ],
      });
      const observed = makeThread(observedId, projectId, now, {
        creationSource: "provider",
        lineage: {
          parentThreadId: parentId,
          relationshipToParent: "subagent",
          rootThreadId: parentId,
        },
      });
      const fork = makeThread(forkId, projectId, now, {
        lineage: { parentThreadId: parentId, relationshipToParent: "fork", rootThreadId: parentId },
      });
      yield* sink.write({
        events: [
          {
            id: EventId.make("event:civilization:observed-child:native"),
            type: "thread.created",
            threadId: observedId,
            occurredAt: now,
            payload: observed,
          },
          {
            id: EventId.make("event:civilization:observed-child:fork"),
            type: "thread.created",
            threadId: forkId,
            occurredAt: now,
            payload: fork,
          },
        ],
      });

      const observedCitizen = yield* readCitizen(observedId);
      assert.deepEqual(
        {
          relationship: observedCitizen?.relationship_to_parent,
          observedOnly: observedCitizen?.observed_only,
          titleManaged: observedCitizen?.title_managed,
        },
        { relationship: "subagent", observedOnly: 1, titleManaged: 0 },
      );
      assert.isUndefined(yield* readCitizen(forkId));
    }).pipe(Effect.provide(Layer.fresh(layer))),
);

it.effect(
  "tracks independent delivery lifecycle and terminalizes only pending mail while disabled",
  () =>
    Effect.gen(function* () {
      const sink = yield* EventSink.EventSinkV2;
      const service = yield* ConfigService.CivilizationConfigService;
      yield* enableFeature();
      const now = yield* DateTime.now;
      const projectId = ProjectId.make("project:civilization:lifecycle");
      const threadId = ThreadId.make("thread:civilization:lifecycle");
      let thread = makeThread(threadId, projectId, now);
      yield* sink.write({
        events: [
          {
            id: EventId.make("event:civilization:lifecycle:create"),
            type: "thread.created",
            threadId,
            occurredAt: now,
            payload: thread,
          },
        ],
      });
      assert.deepEqual(
        {
          epoch: (yield* readCitizen(threadId))?.epoch,
          closed: (yield* readCitizen(threadId))?.closed,
          deliveryEpoch: (yield* readCitizen(threadId))?.delivery_epoch,
        },
        { epoch: 0, closed: 0, deliveryEpoch: 0 },
      );

      const nowIso = DateTime.formatIso(now);
      yield* insertMessage({
        messageId: "mail:civilization:lifecycle:pending",
        projectId,
        recipientThreadId: threadId,
        recipientDeliveryEpoch: 0,
        acceptedAt: nowIso,
      });
      yield* insertMessage({
        messageId: "mail:civilization:lifecycle:offered",
        projectId,
        recipientThreadId: threadId,
        recipientDeliveryEpoch: 0,
        acceptedAt: nowIso,
        offered: true,
      });
      yield* insertMessage({
        messageId: "mail:civilization:lifecycle:acked",
        projectId,
        recipientThreadId: threadId,
        recipientDeliveryEpoch: 0,
        acceptedAt: nowIso,
        offered: true,
        acknowledged: true,
      });
      yield* insertMessage({
        messageId: "mail:civilization:lifecycle:terminal",
        projectId,
        recipientThreadId: threadId,
        recipientDeliveryEpoch: 0,
        acceptedAt: nowIso,
        terminalReason: "expired",
      });

      const writeThread = (
        type:
          | "thread.settled"
          | "thread.pinned"
          | "thread.archived"
          | "thread.unarchived"
          | "thread.unsettled"
          | "thread.deleted",
        next: OrchestrationV2AppThread,
        id: string,
      ) =>
        sink.write({
          events: [
            { id: EventId.make(id), type, threadId, occurredAt: next.updatedAt, payload: next },
          ],
        });

      thread = { ...thread, settledOverride: "settled", settledAt: now, updatedAt: now };
      yield* writeThread("thread.settled", thread, "event:civilization:lifecycle:settle");
      assert.deepEqual(
        {
          epoch: (yield* readCitizen(threadId))?.epoch,
          deliveryEpoch: (yield* readCitizen(threadId))?.delivery_epoch,
          settled: (yield* readCitizen(threadId))?.delivery_settled,
        },
        { epoch: 1, deliveryEpoch: 1, settled: 1 },
      );
      assert.deepEqual(
        (yield* readMessages(projectId)).map((message) => ({
          id: message.message_id,
          terminalAt: message.terminal_at,
          reason: message.terminal_reason,
        })),
        [
          { id: "mail:civilization:lifecycle:acked", terminalAt: null, reason: null },
          {
            id: "mail:civilization:lifecycle:offered",
            terminalAt: nowIso,
            reason: "recipient_settled",
          },
          {
            id: "mail:civilization:lifecycle:pending",
            terminalAt: nowIso,
            reason: "recipient_settled",
          },
          { id: "mail:civilization:lifecycle:terminal", terminalAt: nowIso, reason: "expired" },
        ],
      );
      yield* writeThread("thread.settled", thread, "event:civilization:lifecycle:settle-redundant");
      assert.deepEqual(
        {
          epoch: (yield* readCitizen(threadId))?.epoch,
          deliveryEpoch: (yield* readCitizen(threadId))?.delivery_epoch,
        },
        { epoch: 1, deliveryEpoch: 1 },
      );

      thread = { ...thread, settledOverride: "active", settledAt: null, updatedAt: now };
      yield* writeThread("thread.pinned", thread, "event:civilization:lifecycle:pin");
      assert.deepEqual(
        {
          epoch: (yield* readCitizen(threadId))?.epoch,
          closed: (yield* readCitizen(threadId))?.closed,
          deliveryEpoch: (yield* readCitizen(threadId))?.delivery_epoch,
          settled: (yield* readCitizen(threadId))?.delivery_settled,
        },
        { epoch: 2, closed: 0, deliveryEpoch: 1, settled: 0 },
      );

      thread = { ...thread, settledOverride: "settled", settledAt: now, updatedAt: now };
      yield* writeThread("thread.settled", thread, "event:civilization:lifecycle:settle-again");
      yield* insertMessage({
        messageId: "mail:civilization:lifecycle:archive",
        projectId,
        recipientThreadId: threadId,
        recipientDeliveryEpoch: 2,
        acceptedAt: nowIso,
      });
      thread = { ...thread, archivedAt: now, updatedAt: now };
      yield* writeThread("thread.archived", thread, "event:civilization:lifecycle:archive");
      assert.deepEqual(
        {
          epoch: (yield* readCitizen(threadId))?.epoch,
          deliveryEpoch: (yield* readCitizen(threadId))?.delivery_epoch,
          settled: (yield* readCitizen(threadId))?.delivery_settled,
          archived: (yield* readCitizen(threadId))?.delivery_archived,
        },
        { epoch: 3, deliveryEpoch: 3, settled: 1, archived: 1 },
        "archive advances delivery while aggregate citizen lifecycle is already closed",
      );
      assert.equal(
        (yield* readMessages(projectId)).find(
          (message) => message.message_id === "mail:civilization:lifecycle:archive",
        )?.terminal_reason,
        "recipient_archived",
      );
      const beforeUnarchiveRevision = (yield* readCitizen(threadId))?.revision;
      thread = { ...thread, archivedAt: null, updatedAt: now };
      yield* writeThread("thread.unarchived", thread, "event:civilization:lifecycle:unarchive");
      const afterUnarchive = yield* readCitizen(threadId);
      assert.deepEqual(
        {
          epoch: afterUnarchive?.epoch,
          closed: afterUnarchive?.closed,
          deliveryEpoch: afterUnarchive?.delivery_epoch,
          archived: afterUnarchive?.delivery_archived,
        },
        { epoch: 3, closed: 1, deliveryEpoch: 3, archived: 0 },
      );
      assert.equal(afterUnarchive?.revision, (beforeUnarchiveRevision ?? 0) + 1);

      yield* service.set({
        expectedRevision: 1,
        override: {
          version: CIVILIZATION_CONFIG_VERSION,
          participation: { enabled: false },
        },
      });
      thread = { ...thread, settledOverride: "active", settledAt: null, updatedAt: now };
      yield* writeThread(
        "thread.unsettled",
        thread,
        "event:civilization:lifecycle:return-disabled",
      );
      assert.deepEqual(
        {
          epoch: (yield* readCitizen(threadId))?.epoch,
          closed: (yield* readCitizen(threadId))?.closed,
          deliveryEpoch: (yield* readCitizen(threadId))?.delivery_epoch,
          settled: (yield* readCitizen(threadId))?.delivery_settled,
        },
        { epoch: 4, closed: 0, deliveryEpoch: 3, settled: 0 },
      );

      yield* insertMessage({
        messageId: "mail:civilization:lifecycle:disabled",
        projectId,
        recipientThreadId: threadId,
        recipientDeliveryEpoch: 3,
        acceptedAt: nowIso,
      });
      thread = { ...thread, settledOverride: "settled", settledAt: now, updatedAt: now };
      yield* writeThread("thread.settled", thread, "event:civilization:lifecycle:settle-disabled");
      thread = { ...thread, archivedAt: now, updatedAt: now };
      yield* writeThread(
        "thread.archived",
        thread,
        "event:civilization:lifecycle:archive-disabled",
      );
      yield* insertMessage({
        messageId: "mail:civilization:lifecycle:delete",
        projectId,
        recipientThreadId: threadId,
        recipientDeliveryEpoch: 5,
        acceptedAt: nowIso,
      });
      thread = { ...thread, deletedAt: now, updatedAt: now };
      yield* writeThread("thread.deleted", thread, "event:civilization:lifecycle:delete-disabled");
      assert.deepEqual(
        {
          epoch: (yield* readCitizen(threadId))?.epoch,
          closed: (yield* readCitizen(threadId))?.closed,
          deliveryEpoch: (yield* readCitizen(threadId))?.delivery_epoch,
          settled: (yield* readCitizen(threadId))?.delivery_settled,
          archived: (yield* readCitizen(threadId))?.delivery_archived,
          deleted: (yield* readCitizen(threadId))?.delivery_deleted,
        },
        { epoch: 5, closed: 1, deliveryEpoch: 6, settled: 1, archived: 1, deleted: 1 },
        "archive/delete each advance delivery even though aggregate closed stays true",
      );
      assert.deepEqual(
        (yield* readMessages(projectId)).find(
          (message) => message.message_id === "mail:civilization:lifecycle:disabled",
        ),
        {
          message_id: "mail:civilization:lifecycle:disabled",
          terminal_at: nowIso,
          terminal_reason: "recipient_settled",
          acknowledged_at: null,
        },
        "delivery bookkeeping stays active when Civilization participation is disabled",
      );
      assert.equal(
        (yield* readMessages(projectId)).find(
          (message) => message.message_id === "mail:civilization:lifecycle:delete",
        )?.terminal_reason,
        "recipient_deleted",
      );
    }).pipe(Effect.provide(Layer.fresh(layer))),
);

it.effect(
  "prioritizes delete when one host state enters multiple delivery-closing components",
  () =>
    Effect.gen(function* () {
      const sink = yield* EventSink.EventSinkV2;
      yield* enableFeature();
      const now = yield* DateTime.now;
      const nowIso = DateTime.formatIso(now);
      const projectId = ProjectId.make("project:civilization:delivery-priority");
      const threadId = ThreadId.make("thread:civilization:delivery-priority");
      const thread = makeThread(threadId, projectId, now);
      yield* sink.write({
        events: [
          {
            id: EventId.make("event:civilization:delivery-priority:create"),
            type: "thread.created",
            threadId,
            occurredAt: now,
            payload: thread,
          },
        ],
      });
      yield* insertMessage({
        messageId: "mail:civilization:delivery-priority",
        projectId,
        recipientThreadId: threadId,
        recipientDeliveryEpoch: 0,
        acceptedAt: nowIso,
      });

      const terminal = {
        ...thread,
        settledOverride: "settled" as const,
        settledAt: now,
        archivedAt: now,
        deletedAt: now,
        updatedAt: now,
      };
      yield* sink.write({
        events: [
          {
            id: EventId.make("event:civilization:delivery-priority:terminal"),
            type: "thread.deleted",
            threadId,
            occurredAt: now,
            payload: terminal,
          },
        ],
      });

      const citizen = yield* readCitizen(threadId);
      assert.deepEqual(
        {
          epoch: citizen?.epoch,
          deliveryEpoch: citizen?.delivery_epoch,
          settled: citizen?.delivery_settled,
          archived: citizen?.delivery_archived,
          deleted: citizen?.delivery_deleted,
        },
        { epoch: 1, deliveryEpoch: 3, settled: 1, archived: 1, deleted: 1 },
      );
      assert.deepEqual((yield* readMessages(projectId))[0], {
        message_id: "mail:civilization:delivery-priority",
        terminal_at: nowIso,
        terminal_reason: "recipient_deleted",
        acknowledged_at: null,
      });
    }).pipe(Effect.provide(Layer.fresh(layer))),
);

it.effect(
  "derives generation from host lineage even when ancestors are not citizens and labels unresolved ancestry",
  () =>
    Effect.gen(function* () {
      const sink = yield* EventSink.EventSinkV2;
      const sql = yield* SqlClient.SqlClient;
      const now = yield* DateTime.now;
      const projectId = ProjectId.make("project:civilization:lineage");
      const otherProjectId = ProjectId.make("project:civilization:lineage:other");
      const rootId = ThreadId.make("thread:civilization:lineage:root");
      const parentId = ThreadId.make("thread:civilization:lineage:parent");
      const foreignId = ThreadId.make("thread:civilization:lineage:foreign");
      const cycleAId = ThreadId.make("thread:civilization:lineage:cycle-a");
      const cycleBId = ThreadId.make("thread:civilization:lineage:cycle-b");

      const root = makeThread(rootId, projectId, now);
      const parent = makeThread(parentId, projectId, now, {
        lineage: { parentThreadId: rootId, relationshipToParent: "fork", rootThreadId: rootId },
      });
      const foreign = makeThread(foreignId, otherProjectId, now);
      const cycleA = makeThread(cycleAId, projectId, now, {
        lineage: { parentThreadId: cycleBId, relationshipToParent: "fork", rootThreadId: cycleAId },
      });
      const cycleB = makeThread(cycleBId, projectId, now, {
        lineage: { parentThreadId: cycleAId, relationshipToParent: "fork", rootThreadId: cycleAId },
      });
      for (const [index, thread] of [root, parent, foreign, cycleA, cycleB].entries()) {
        yield* sink.write({
          events: [
            {
              id: EventId.make(`event:civilization:lineage:preexisting:${index}`),
              type: "thread.created",
              threadId: thread.id,
              occurredAt: now,
              payload: thread,
            },
          ],
        });
      }
      assert.isUndefined(yield* readCitizen(parentId));

      yield* enableFeature();
      const childId = ThreadId.make("thread:civilization:lineage:child");
      const child = makeThread(childId, projectId, now, {
        lineage: { parentThreadId: parentId, relationshipToParent: "fork", rootThreadId: rootId },
      });
      yield* sink.write({
        events: [
          {
            id: EventId.make("event:civilization:lineage:child"),
            type: "thread.created",
            threadId: childId,
            occurredAt: now,
            payload: child,
          },
        ],
      });
      const resolved = yield* readCitizen(childId);
      assert.deepEqual(
        {
          parent: resolved?.parent_thread_id,
          relationship: resolved?.relationship_to_parent,
          generation: resolved?.generation,
          status: resolved?.lineage_status,
        },
        { parent: parentId, relationship: "fork", generation: 2, status: "resolved" },
      );

      const missingParentId = ThreadId.make("thread:civilization:lineage:missing-parent");
      const orphanId = ThreadId.make("thread:civilization:lineage:orphan");
      const orphan = makeThread(orphanId, projectId, now, {
        lineage: {
          parentThreadId: missingParentId,
          relationshipToParent: "fork",
          rootThreadId: missingParentId,
        },
      });
      yield* sink.write({
        events: [
          {
            id: EventId.make("event:civilization:lineage:orphan"),
            type: "thread.created",
            threadId: orphanId,
            occurredAt: now,
            payload: orphan,
          },
        ],
      });
      assert.deepEqual(
        {
          generation: (yield* readCitizen(orphanId))?.generation,
          status: (yield* readCitizen(orphanId))?.lineage_status,
        },
        { generation: 1, status: "missing" },
      );

      const crossProjectId = ThreadId.make("thread:civilization:lineage:cross-project");
      const crossProject = makeThread(crossProjectId, projectId, now, {
        lineage: {
          parentThreadId: foreignId,
          relationshipToParent: "fork",
          rootThreadId: foreignId,
        },
      });
      yield* sink.write({
        events: [
          {
            id: EventId.make("event:civilization:lineage:cross-project"),
            type: "thread.created",
            threadId: crossProjectId,
            occurredAt: now,
            payload: crossProject,
          },
        ],
      });
      assert.equal((yield* readCitizen(crossProjectId))?.lineage_status, "cross_project");

      yield* enrollCivilizationThread({ sequence: 999, thread: cycleA, adoption: true }).pipe(
        Effect.provideService(SqlClient.SqlClient, sql),
      );
      assert.deepEqual(
        {
          generation: (yield* readCitizen(cycleAId))?.generation,
          status: (yield* readCitizen(cycleAId))?.lineage_status,
        },
        { generation: 2, status: "cycle" },
      );
    }).pipe(Effect.provide(Layer.fresh(layer))),
);

it.effect(
  "project delete closes remaining mail and advances only newly entered delete components",
  () =>
    Effect.gen(function* () {
      const sink = yield* EventSink.EventSinkV2;
      yield* enableFeature();
      const now = yield* DateTime.now;
      const nowIso = DateTime.formatIso(now);
      const projectId = ProjectId.make("project:civilization:delete");
      const firstThreadId = ThreadId.make("thread:civilization:delete:first");
      const secondThreadId = ThreadId.make("thread:civilization:delete:second");

      yield* sink.commitProjectCommand({
        commandId: CommandId.make("command:civilization:project:create"),
        projectId,
        commandType: "project.create",
        acceptedAt: now,
        event: {
          eventId: EventId.make("event:civilization:project:create"),
          aggregateKind: "project",
          aggregateId: projectId,
          occurredAt: DateTime.formatIso(now),
          commandId: null,
          causationEventId: null,
          correlationId: null,
          metadata: {},
          type: "project.created",
          payload: {
            projectId,
            title: "Civilization",
            workspaceRoot: "C:\\probe\\civilization",
            defaultModelSelection: null,
            scripts: [],
            createdAt: DateTime.formatIso(now),
            updatedAt: DateTime.formatIso(now),
          },
        },
      });
      const firstThread = makeThread(firstThreadId, projectId, now);
      const secondThread = makeThread(secondThreadId, projectId, now);
      for (const [index, thread] of [firstThread, secondThread].entries()) {
        yield* sink.write({
          events: [
            {
              id: EventId.make(`event:civilization:project:thread:${index}`),
              type: "thread.created",
              threadId: thread.id,
              occurredAt: now,
              payload: thread,
            },
          ],
        });
      }

      yield* sink.write({
        events: [
          {
            id: EventId.make("event:civilization:project:first-thread-delete"),
            type: "thread.deleted",
            threadId: firstThreadId,
            occurredAt: now,
            payload: { ...firstThread, deletedAt: now, updatedAt: now },
          },
        ],
      });
      assert.equal((yield* readCitizen(firstThreadId))?.delivery_epoch, 1);

      yield* insertMessage({
        messageId: "mail:civilization:project:stray-first",
        projectId,
        recipientThreadId: firstThreadId,
        recipientDeliveryEpoch: 1,
        acceptedAt: nowIso,
      });
      yield* insertMessage({
        messageId: "mail:civilization:project:pending-second",
        projectId,
        recipientThreadId: secondThreadId,
        recipientDeliveryEpoch: 0,
        acceptedAt: nowIso,
        offered: true,
      });
      yield* insertMessage({
        messageId: "mail:civilization:project:acked-second",
        projectId,
        recipientThreadId: secondThreadId,
        recipientDeliveryEpoch: 0,
        acceptedAt: nowIso,
        offered: true,
        acknowledged: true,
      });

      const deleted = yield* sink.commitProjectCommand({
        commandId: CommandId.make("command:civilization:project:delete"),
        projectId,
        commandType: "project.delete",
        acceptedAt: now,
        event: {
          eventId: EventId.make("event:civilization:project:delete"),
          aggregateKind: "project",
          aggregateId: projectId,
          occurredAt: DateTime.formatIso(now),
          commandId: null,
          causationEventId: null,
          correlationId: null,
          metadata: {},
          type: "project.deleted",
          payload: { projectId, deletedAt: DateTime.formatIso(now) },
        },
      });

      const firstCitizen = yield* readCitizen(firstThreadId);
      const secondCitizen = yield* readCitizen(secondThreadId);
      assert.deepEqual(
        {
          first: {
            epoch: firstCitizen?.epoch,
            deliveryEpoch: firstCitizen?.delivery_epoch,
            deliveryDeleted: firstCitizen?.delivery_deleted,
            watermark: firstCitizen?.last_applied_sequence,
          },
          second: {
            epoch: secondCitizen?.epoch,
            deliveryEpoch: secondCitizen?.delivery_epoch,
            deliveryDeleted: secondCitizen?.delivery_deleted,
            watermark: secondCitizen?.last_applied_sequence,
          },
        },
        {
          first: {
            epoch: 1,
            deliveryEpoch: 1,
            deliveryDeleted: 1,
            watermark: deleted.receipt.resultSequence,
          },
          second: {
            epoch: 1,
            deliveryEpoch: 1,
            deliveryDeleted: 1,
            watermark: deleted.receipt.resultSequence,
          },
        },
        "already-deleted recipients do not advance delivery epoch again",
      );
      assert.deepEqual(
        (yield* readMessages(projectId)).map((message) => ({
          id: message.message_id,
          terminalAt: message.terminal_at,
          reason: message.terminal_reason,
        })),
        [
          { id: "mail:civilization:project:acked-second", terminalAt: null, reason: null },
          {
            id: "mail:civilization:project:pending-second",
            terminalAt: nowIso,
            reason: "project_deleted",
          },
          {
            id: "mail:civilization:project:stray-first",
            terminalAt: nowIso,
            reason: "project_deleted",
          },
        ],
      );
    }).pipe(Effect.provide(Layer.fresh(layer))),
);
