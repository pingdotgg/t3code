import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";

import { runMigrations } from "../persistence/Migrations.ts";
import * as NodeSqliteClient from "../persistence/NodeSqliteClient.ts";
import {
  HermesProactiveEventRepository,
  classifyHermesProactiveCapability,
  layer as repositoryLayer,
} from "./HermesProactiveEventRepository.ts";

const T0 = "2026-07-25T12:00:00.000Z";
const T1 = "2026-07-25T12:01:00.000Z";
const T2 = "2026-07-25T12:02:00.000Z";
const T3 = "2026-07-25T12:03:00.000Z";
const decodeUnknownJsonString = Schema.decodeUnknownEffect(Schema.UnknownFromJsonString);

function testLayer(databaseLayer: Layer.Layer<SqlClient.SqlClient, SqlError>) {
  return repositoryLayer.pipe(Layer.provideMerge(databaseLayer));
}

const memory = it.layer(testLayer(NodeSqliteClient.layerMemory()));

const legacyCompatibility = {
  status: "legacy" as const,
  protocol: null,
  capabilities: ["cron.read", "cron.manage"],
  inventory: null,
  reason: "Pinned gateway does not advertise protocol capabilities.",
};

const readyCompatibility = {
  status: "supported" as const,
  protocol: {
    major: 1,
    minor: 1,
    capabilities: ["cron.events.global_cursor", "events.stable_ids"],
  },
  capabilities: ["cron.events.global_cursor", "events.stable_ids"],
  inventory: ["cron.events.global_cursor", "events.stable_ids"],
  reason: "Future gateway advertises the required durable feed.",
};

function registerReady(
  repository: HermesProactiveEventRepository["Service"],
  profileKey = "profile:default",
) {
  return repository.registerSource({
    providerInstanceId: "hermes-local",
    profileKey,
    compatibility: readyCompatibility,
    now: T0,
  });
}

function event(externalEventId = "event:1") {
  return {
    externalEventId,
    externalCursor: "cursor:1",
    eventKind: "cron.completed",
    title: "Background task completed",
    body: "A Hermes background task produced a result.",
    projectId: "project:1",
    threadId: null,
    occurredAt: T0,
  };
}

memory("HermesProactiveEventRepository", (it) => {
  it.effect("fails closed with explicit diagnostics for the pinned legacy gateway", () =>
    Effect.gen(function* () {
      yield* runMigrations({ toMigrationInclusive: 45 });
      const repository = yield* HermesProactiveEventRepository;
      const source = yield* repository.registerSource({
        providerInstanceId: "hermes-local",
        profileKey: "profile:default",
        compatibility: legacyCompatibility,
        now: T0,
      });

      assert.strictEqual(source.state, "degraded");
      assert.strictEqual(source.diagnosticCode, "missing_capability_inventory");
      assert.deepStrictEqual(source.missingCapabilities, [
        "cron.events.global_cursor",
        "events.stable_ids",
      ]);

      const result = yield* repository.ingestPage({
        sourceId: source.sourceId,
        expectedCursor: null,
        nextCursor: "cursor:1",
        gatewayRevision: null,
        protocolMajor: null,
        protocolMinor: null,
        receivedAt: T1,
        events: [event()],
      });
      assert.deepStrictEqual(result, {
        status: "degraded",
        diagnosticCode: "missing_capability_inventory",
      });

      const sql = yield* SqlClient.SqlClient;
      const rows = yield* sql<{ count: number }>`
        SELECT COUNT(*) AS count FROM hermes_proactive_events
      `;
      assert.strictEqual(rows[0]?.count, 0);
    }),
  );

  it.effect("classifies each missing upstream guarantee without optimistic fallback", () =>
    Effect.sync(() => {
      assert.deepStrictEqual(
        classifyHermesProactiveCapability({
          ...readyCompatibility,
          capabilities: ["events.stable_ids"],
          inventory: ["events.stable_ids"],
        }),
        {
          state: "degraded",
          diagnosticCode: "missing_durable_global_cursor",
          missingCapabilities: ["cron.events.global_cursor"],
        },
      );
      assert.deepStrictEqual(
        classifyHermesProactiveCapability({
          ...readyCompatibility,
          capabilities: ["cron.events.global_cursor"],
          inventory: ["cron.events.global_cursor"],
        }),
        {
          state: "degraded",
          diagnosticCode: "missing_stable_event_ids",
          missingCapabilities: ["events.stable_ids"],
        },
      );
    }),
  );

  it.effect(
    "atomically advances a durable cursor and deduplicates stable upstream identities",
    () =>
      Effect.gen(function* () {
        yield* runMigrations({ toMigrationInclusive: 45 });
        const repository = yield* HermesProactiveEventRepository;
        const source = yield* registerReady(repository, "profile:delivery");

        const applied = yield* repository.ingestPage({
          sourceId: source.sourceId,
          expectedCursor: null,
          nextCursor: "cursor:1",
          gatewayRevision: "future-revision",
          protocolMajor: 1,
          protocolMinor: 1,
          receivedAt: T1,
          events: [event(), event()],
        });
        assert.deepStrictEqual(applied, {
          status: "applied",
          inserted: 1,
          duplicates: 1,
          checkpointCursor: "cursor:1",
          checkpointSequence: 1,
        });

        const replay = yield* repository.ingestPage({
          sourceId: source.sourceId,
          expectedCursor: null,
          nextCursor: "cursor:1",
          gatewayRevision: "future-revision",
          protocolMajor: 1,
          protocolMinor: 1,
          receivedAt: T2,
          events: [event()],
        });
        assert.deepStrictEqual(replay, {
          status: "already_applied",
          checkpointCursor: "cursor:1",
          checkpointSequence: 1,
        });

        const stale = yield* repository.ingestPage({
          sourceId: source.sourceId,
          expectedCursor: null,
          nextCursor: "cursor:2",
          gatewayRevision: "future-revision",
          protocolMajor: 1,
          protocolMinor: 1,
          receivedAt: T2,
          events: [],
        });
        assert.deepStrictEqual(stale, {
          status: "stale_checkpoint",
          checkpointCursor: "cursor:1",
          checkpointSequence: 1,
        });

        const sql = yield* SqlClient.SqlClient;
        const rows = yield* sql<{
          event_id: string;
          provenance_json: string;
          outbox_count: number;
        }>`
        SELECT
          event.event_id,
          event.provenance_json,
          COUNT(outbox.outbox_id) AS outbox_count
        FROM hermes_proactive_events AS event
        JOIN hermes_notification_outbox AS outbox ON outbox.event_id = event.event_id
        GROUP BY event.event_id, event.provenance_json
      `;
        assert.lengthOf(rows, 1);
        assert.match(rows[0]!.event_id, /^hermes-event:[0-9a-f]{64}$/);
        assert.strictEqual(rows[0]!.outbox_count, 1);
        const provenance = yield* decodeUnknownJsonString(rows[0]!.provenance_json);
        assert.deepInclude(provenance, {
          provider: "hermes",
          externalEventId: "event:1",
          externalCursor: "cursor:1",
          gatewayRevision: "future-revision",
        });

        const cleanupClaim = yield* repository.claimNotification({
          workerId: "worker:test-cleanup",
          now: T3,
          leaseExpiresAt: "2026-07-25T12:04:00.000Z",
        });
        assert.isTrue(Option.isSome(cleanupClaim));
        if (Option.isSome(cleanupClaim)) {
          assert.isTrue(
            yield* repository.deadLetterNotification({
              outboxId: cleanupClaim.value.outboxId,
              workerId: "worker:test-cleanup",
              now: T3,
              errorCode: "test_cleanup",
            }),
          );
        }
      }),
  );

  it.effect(
    "leases, retries, fences, and projects outbox entries into Work and in-app records",
    () =>
      Effect.gen(function* () {
        yield* runMigrations({ toMigrationInclusive: 45 });
        const repository = yield* HermesProactiveEventRepository;
        const source = yield* registerReady(repository);
        yield* repository.ingestPage({
          sourceId: source.sourceId,
          expectedCursor: null,
          nextCursor: "cursor:1",
          gatewayRevision: "future-revision",
          protocolMajor: 1,
          protocolMinor: 1,
          receivedAt: T0,
          events: [event()],
        });

        const first = yield* repository.claimNotification({
          workerId: "worker:a",
          now: T0,
          leaseExpiresAt: T1,
        });
        assert.isTrue(Option.isSome(first));
        if (Option.isNone(first)) return;
        assert.strictEqual(first.value.attemptCount, 1);

        assert.isFalse(
          yield* repository.deliverInApp({
            outboxId: first.value.outboxId,
            workerId: "worker:b",
            now: T0,
          }),
        );
        assert.isTrue(
          yield* repository.retryNotification({
            outboxId: first.value.outboxId,
            workerId: "worker:a",
            now: T0,
            availableAt: T2,
            errorCode: "projection_busy",
          }),
        );

        const tooEarly = yield* repository.claimNotification({
          workerId: "worker:b",
          now: T1,
          leaseExpiresAt: T2,
        });
        assert.isTrue(Option.isNone(tooEarly));

        const retried = yield* repository.claimNotification({
          workerId: "worker:b",
          now: T2,
          leaseExpiresAt: T3,
        });
        assert.isTrue(Option.isSome(retried));
        if (Option.isNone(retried)) return;
        assert.strictEqual(retried.value.attemptCount, 2);
        assert.isTrue(
          yield* repository.deliverInApp({
            outboxId: retried.value.outboxId,
            workerId: "worker:b",
            now: T2,
          }),
        );

        const workItems = yield* repository.listWorkItems();
        const notifications = yield* repository.listInAppNotifications();
        assert.lengthOf(workItems, 1);
        assert.lengthOf(notifications, 1);
        assert.strictEqual(workItems[0]!.eventId, retried.value.eventId);
        assert.strictEqual(notifications[0]!.workItemId, workItems[0]!.workItemId);
        assert.strictEqual(notifications[0]!.status, "unread");

        const exhausted = yield* repository.claimNotification({
          workerId: "worker:c",
          now: T3,
          leaseExpiresAt: "2026-07-25T12:04:00.000Z",
        });
        assert.isTrue(Option.isNone(exhausted));
      }),
  );

  it.effect("rejects outbox commits from a worker whose lease has expired", () =>
    Effect.gen(function* () {
      yield* runMigrations({ toMigrationInclusive: 45 });
      const repository = yield* HermesProactiveEventRepository;
      const source = yield* registerReady(repository, "profile:lease-expiry");
      yield* repository.ingestPage({
        sourceId: source.sourceId,
        expectedCursor: null,
        nextCursor: "cursor:1",
        gatewayRevision: "future-revision",
        protocolMajor: 1,
        protocolMinor: 1,
        receivedAt: T0,
        events: [event()],
      });

      const claimed = yield* repository.claimNotification({
        workerId: "worker:expired",
        now: T0,
        leaseExpiresAt: T1,
      });
      assert.isTrue(Option.isSome(claimed));
      if (Option.isNone(claimed)) return;

      assert.isFalse(
        yield* repository.deliverInApp({
          outboxId: claimed.value.outboxId,
          workerId: "worker:expired",
          now: T2,
        }),
      );
      assert.isFalse(
        yield* repository.retryNotification({
          outboxId: claimed.value.outboxId,
          workerId: "worker:expired",
          now: T2,
          availableAt: T3,
          errorCode: "lease_expired",
        }),
      );
      assert.isFalse(
        yield* repository.deadLetterNotification({
          outboxId: claimed.value.outboxId,
          workerId: "worker:expired",
          now: T2,
          errorCode: "lease_expired",
        }),
      );

      const reclaimed = yield* repository.claimNotification({
        workerId: "worker:fresh",
        now: T2,
        leaseExpiresAt: T3,
      });
      assert.isTrue(Option.isSome(reclaimed));
      if (Option.isNone(reclaimed)) return;
      assert.strictEqual(reclaimed.value.outboxId, claimed.value.outboxId);
      assert.isTrue(
        yield* repository.deliverInApp({
          outboxId: reclaimed.value.outboxId,
          workerId: "worker:fresh",
          now: T2,
        }),
      );
    }),
  );
});
