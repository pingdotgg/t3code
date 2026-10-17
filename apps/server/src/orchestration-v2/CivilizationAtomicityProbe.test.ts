// @effect-diagnostics nodeBuiltinImport:off
/**
 * Phase 0 G3 probe (disposable experiment, not feature implementation).
 *
 * Proves the persistence boundary PLANNING.md §5.2/§5.3 requires: a feature
 * "persistence participant" runs inside the host write transaction, and every
 * interleaving of a feature send/offer with host lifecycle writes resolves to
 * one serial ordering. The boundary revision under test is the optional
 * `participants` field on `EventSink.write` / `writeWithEffects` /
 * `commitProjectCommand`: the sink invokes each participant after host
 * projections are applied and before the outbox enqueue, on the transaction's
 * own connection, and any participant failure rolls the whole write back.
 *
 * What this file proves:
 * - participant bookkeeping commits atomically with the host event, its
 *   projection and queued effects, and rolls back together on failure;
 * - send/offer guarded reads (feature rows, host thread row, effective config,
 *   quota) live in the same transaction as their writes, so offer-vs-settle,
 *   offer-vs-project-delete, offer-vs-mode-change and offer-vs-config-change
 *   each produce exactly one serial order;
 * - settlement, archive and project delete close citizens and their open mail
 *   in the committing transaction; unsettle/unarchive return the same identity
 *   with a new epoch while old mail stays closed;
 * - two connections racing for the last quota slot admit exactly one offer;
 * - a writer that meets SQLITE_BUSY retries at most three times, keeps no
 *   partial state, and returns an explicit retryable outcome;
 * - the in-transaction participant keeps an active citizen's watermark at the
 *   committed host sequence, so event-store compaction (which only removes
 *   superseded events) can never strand an active citizen, and catch-up
 *   interleaved with compaction keeps one serial ordering.
 *
 * Hazard control (documented, not a defect): a lifecycle write that bypasses
 * the participant leaves a citizen behind, and compaction can then remove the
 * transition it never applied. That is why the boundary requires participants
 * on every lifecycle-committing write path; enumerating those paths is G6.
 *
 * Limits (recorded in experiments/phase-0/E03-g3-atomicity.md): the packet
 * transport is G2; identity/run-ownership semantics are G1; participants are
 * only wired into the write paths this probe drives (production wiring must
 * enumerate every lifecycle-committing path, including `commitCommand`);
 * `writeIfRunCurrent`/provider-thread guards are upstream-tested and not
 * re-probed here; the probe's feature schema and delivery rules are
 * stand-ins. Promote or delete after the Phase 0 review.
 */

import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  type ModelSelection,
  type OrchestrationV2AppThread,
  type OrchestrationV2DomainEvent,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import type * as PlatformError from "effect/PlatformError";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as SqlError from "effect/sql/SqlError";
import * as SqlClient from "effect/sql/SqlClient";
import type * as Migrator from "effect/sql/Migrator";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as EventSink from "./EventSink.ts";
import * as EventStore from "./EventStore.ts";
import * as ProjectionMaintenance from "./ProjectionMaintenance.ts";
import * as ProjectionStore from "./ProjectionStore.ts";

const providerInstanceId = ProviderInstanceId.make("codex");
const modelSelection = {
  instanceId: providerInstanceId,
  model: "gpt-5.4",
} satisfies ModelSelection;

function makeThread(
  threadId: ThreadId,
  now: DateTime.Utc,
  options?: {
    readonly projectId?: ProjectId;
    readonly runtimeMode?: OrchestrationV2AppThread["runtimeMode"];
  },
): OrchestrationV2AppThread {
  return {
    createdBy: "user",
    creationSource: "web",
    id: threadId,
    projectId: options?.projectId ?? ProjectId.make(`project:${threadId}`),
    title: `Thread ${threadId}`,
    providerInstanceId,
    modelSelection,
    runtimeMode: options?.runtimeMode ?? "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: {
      parentThreadId: null,
      relationshipToParent: null,
      rootThreadId: threadId,
    },
    forkedFrom: null,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
  };
}

function threadCreatedEvent(input: {
  readonly id: string;
  readonly thread: OrchestrationV2AppThread;
  readonly now: DateTime.Utc;
}): OrchestrationV2DomainEvent {
  return {
    id: EventId.make(input.id),
    type: "thread.created",
    threadId: input.thread.id,
    providerInstanceId,
    occurredAt: input.now,
    payload: input.thread,
  };
}

type LifecycleEventType =
  | "thread.settled"
  | "thread.unsettled"
  | "thread.archived"
  | "thread.unarchived"
  | "thread.deleted";

function threadLifecycleEvent(input: {
  readonly id: string;
  readonly type: LifecycleEventType;
  readonly thread: OrchestrationV2AppThread;
  readonly now: DateTime.Utc;
}): OrchestrationV2DomainEvent {
  const base = { ...input.thread, updatedAt: input.now };
  const payload: OrchestrationV2AppThread =
    input.type === "thread.settled"
      ? { ...base, settledOverride: "settled", settledAt: input.now }
      : input.type === "thread.unsettled"
        ? { ...base, settledOverride: null, settledAt: null }
        : input.type === "thread.archived"
          ? { ...base, archivedAt: input.now }
          : input.type === "thread.unarchived"
            ? { ...base, archivedAt: null }
            : { ...base, deletedAt: input.now };
  return {
    id: EventId.make(input.id),
    type: input.type,
    threadId: input.thread.id,
    providerInstanceId,
    occurredAt: input.now,
    payload,
  };
}

function threadRuntimeModeEvent(input: {
  readonly id: string;
  readonly thread: OrchestrationV2AppThread;
  readonly runtimeMode: OrchestrationV2AppThread["runtimeMode"];
  readonly now: DateTime.Utc;
}): OrchestrationV2DomainEvent {
  return {
    id: EventId.make(input.id),
    type: "thread.runtime-mode-updated",
    threadId: input.thread.id,
    providerInstanceId,
    occurredAt: input.now,
    payload: { ...input.thread, runtimeMode: input.runtimeMode, updatedAt: input.now },
  };
}

/**
 * The probe's copy of the future feature schema: authoritative feature rows in
 * the host SQLite database with no foreign keys into host projection tables.
 * `config` and `quota` are the effective-configuration and quota guards.
 */
const ensureProbeSchema = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE IF NOT EXISTS civilization_probe_schema (
    version INTEGER NOT NULL,
    created_at TEXT NOT NULL
  )`;
  yield* sql`CREATE TABLE IF NOT EXISTS civilization_probe_citizens (
    thread_id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    name TEXT NOT NULL,
    birth_sequence INTEGER NOT NULL,
    last_applied_sequence INTEGER NOT NULL,
    epoch INTEGER NOT NULL DEFAULT 0,
    closed_at TEXT
  )`;
  yield* sql`CREATE TABLE IF NOT EXISTS civilization_probe_mail (
    mail_id TEXT PRIMARY KEY,
    from_thread_id TEXT NOT NULL,
    to_thread_id TEXT NOT NULL,
    accepted_epoch INTEGER NOT NULL,
    config_revision INTEGER NOT NULL,
    accepted_at TEXT NOT NULL,
    closed_at TEXT
  )`;
  yield* sql`CREATE TABLE IF NOT EXISTS civilization_probe_config (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    enabled INTEGER NOT NULL,
    revision INTEGER NOT NULL
  )`;
  yield* sql`CREATE TABLE IF NOT EXISTS civilization_probe_quota (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    accepted_count INTEGER NOT NULL,
    limit_count INTEGER NOT NULL
  )`;
  yield* sql`INSERT INTO civilization_probe_schema (version, created_at)
    SELECT 1, 'phase-0' WHERE NOT EXISTS (SELECT 1 FROM civilization_probe_schema)`;
  yield* sql`INSERT INTO civilization_probe_config (id, enabled, revision)
    SELECT 1, 1, 1 WHERE NOT EXISTS (SELECT 1 FROM civilization_probe_config)`;
  yield* sql`INSERT INTO civilization_probe_quota (id, accepted_count, limit_count)
    SELECT 1, 0, 100 WHERE NOT EXISTS (SELECT 1 FROM civilization_probe_quota)`;
});

const enrollCitizen = (threadId: ThreadId, projectId: ProjectId, name: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const eventStore = yield* EventStore.EventStoreV2;
    const birthSequence = yield* eventStore.latestSequence();
    yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`INSERT INTO civilization_probe_citizens (
          thread_id, project_id, name, birth_sequence, last_applied_sequence, epoch, closed_at
        ) VALUES (${threadId}, ${projectId}, ${name}, ${birthSequence}, ${birthSequence}, 0, NULL)`;
      }),
    );
  });

const probeStatus = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const tables = yield* sql<{ readonly name: string }>`
    SELECT name FROM sqlite_master WHERE type = 'table'
      AND name IN (
        'civilization_probe_schema',
        'civilization_probe_citizens',
        'civilization_probe_mail'
      )
  `;
  if (tables.length < 3) return "unavailable";
  const versions = yield* sql<{ readonly version: number }>`
    SELECT version FROM civilization_probe_schema LIMIT 1
  `;
  if (versions.length !== 1 || versions[0]?.version !== 1) return "unavailable";
  const corrupt = yield* sql<{ readonly count: number }>`
    SELECT COUNT(*) AS count FROM civilization_probe_citizens
    WHERE name IS NULL OR TRIM(name) = '' OR last_applied_sequence IS NULL
  `;
  if ((corrupt[0]?.count ?? 0) > 0) return "unavailable";
  return "active";
});

const closeOpenMailFor = (threadIds: ReadonlyArray<string>, atIso: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    for (const threadId of threadIds) {
      yield* sql`UPDATE civilization_probe_mail
        SET closed_at = COALESCE(closed_at, ${atIso})
        WHERE to_thread_id = ${threadId} AND closed_at IS NULL`;
    }
  });

const closeCitizensForThread = (threadId: string, sequence: number, atIso: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const closed = yield* sql<{ readonly thread_id: string }>`
      UPDATE civilization_probe_citizens
      SET epoch = epoch + 1,
          closed_at = COALESCE(closed_at, ${atIso}),
          last_applied_sequence = MAX(last_applied_sequence, ${sequence})
      WHERE thread_id = ${threadId}
        AND last_applied_sequence < ${sequence}
      RETURNING thread_id
    `;
    yield* closeOpenMailFor(
      closed.map((row) => row.thread_id),
      atIso,
    );
  });

const reopenCitizen = (threadId: string, sequence: number) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      UPDATE civilization_probe_citizens
      SET epoch = epoch + 1,
          closed_at = NULL,
          last_applied_sequence = MAX(last_applied_sequence, ${sequence})
      WHERE thread_id = ${threadId}
        AND last_applied_sequence < ${sequence}
      RETURNING thread_id
    `;
  });

const closeCitizensForProject = (projectId: string, sequence: number, atIso: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const closed = yield* sql<{ readonly thread_id: string }>`
      UPDATE civilization_probe_citizens
      SET epoch = epoch + 1,
          closed_at = COALESCE(closed_at, ${atIso}),
          last_applied_sequence = MAX(last_applied_sequence, ${sequence})
      WHERE project_id = ${projectId}
        AND last_applied_sequence < ${sequence}
      RETURNING thread_id
    `;
    yield* closeOpenMailFor(
      closed.map((row) => row.thread_id),
      atIso,
    );
  });

const CLOSING_LIFECYCLE_EVENTS = new Set<LifecycleEventType>([
  "thread.settled",
  "thread.archived",
  "thread.deleted",
]);

/**
 * The candidate boundary revision under test: one participant, invoked by the
 * sink inside the committing transaction, applying the same guarded updates a
 * production feature would apply.
 */
const civilizationParticipant: EventSink.EventSinkPersistenceParticipant = {
  name: "civilization-probe",
  apply: ({ storedEvents, projectEvents }) =>
    Effect.gen(function* () {
      for (const stored of storedEvents) {
        const event = stored.event;
        if (
          event.type === "thread.settled" ||
          event.type === "thread.archived" ||
          event.type === "thread.deleted"
        ) {
          yield* closeCitizensForThread(
            event.threadId,
            stored.sequence,
            DateTime.formatIso(event.occurredAt),
          );
        } else if (event.type === "thread.unsettled" || event.type === "thread.unarchived") {
          yield* reopenCitizen(event.threadId, stored.sequence);
        }
      }
      for (const event of projectEvents) {
        if (event.type === "project.deleted") {
          yield* closeCitizensForProject(
            event.payload.projectId,
            event.sequence,
            event.payload.deletedAt,
          );
        }
      }
    }),
};

class ProbeParticipantFailure extends Schema.TaggedError<ProbeParticipantFailure>()(
  "ProbeParticipantFailure",
  {},
) {
  override get message(): string {
    return "probe participant invariant failure";
  }
}

/** Fails before applying anything, to prove the sink rolls the whole write back. */
const failingParticipant: EventSink.EventSinkPersistenceParticipant = {
  name: "civilization-probe-failing",
  apply: () => Effect.fail(new ProbeParticipantFailure()),
};

/**
 * The feature-side write path: guarded reads (effective config, citizen
 * lifecycle, host thread row, quota) and the mail insert share one transaction,
 * so delivery is authorized by database state, not cached flags, and a
 * competing host write serializes entirely before or entirely after it.
 */
const featureOffer = (input: {
  readonly mailId: string;
  readonly from: ThreadId;
  readonly to: ThreadId;
  readonly now: DateTime.Utc;
}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const configRows = yield* sql<{ readonly enabled: number; readonly revision: number }>`
          SELECT enabled, revision FROM civilization_probe_config WHERE id = 1
        `;
        const config = configRows[0];
        if (config === undefined || config.enabled !== 1) {
          return { status: "rejected", reason: "config-disabled" } as const;
        }
        const citizenRows = yield* sql<{
          readonly epoch: number;
          readonly closed_at: string | null;
        }>`SELECT epoch, closed_at FROM civilization_probe_citizens WHERE thread_id = ${input.to}`;
        const citizen = citizenRows[0];
        if (citizen === undefined) {
          return { status: "rejected", reason: "no-citizen" } as const;
        }
        if (citizen.closed_at !== null) {
          return { status: "rejected", reason: "closed" } as const;
        }
        const thread = yield* projectionStore.getThread(input.to);
        if (thread.deletedAt !== null) {
          return { status: "rejected", reason: "thread-deleted" } as const;
        }
        if (thread.runtimeMode !== "full-access") {
          return { status: "rejected", reason: "mode-not-full-access" } as const;
        }
        const quota = yield* sql<{ readonly accepted_count: number }>`
          UPDATE civilization_probe_quota
          SET accepted_count = accepted_count + 1
          WHERE id = 1 AND accepted_count < limit_count
          RETURNING accepted_count
        `;
        if (quota.length === 0) {
          return { status: "rejected", reason: "quota" } as const;
        }
        yield* sql`INSERT INTO civilization_probe_mail (
          mail_id, from_thread_id, to_thread_id, accepted_epoch, config_revision, accepted_at, closed_at
        ) VALUES (
          ${input.mailId}, ${input.from}, ${input.to}, ${citizen.epoch},
          ${config.revision}, ${DateTime.formatIso(input.now)}, NULL
        )`;
        return {
          status: "accepted",
          epoch: citizen.epoch,
          configRevision: config.revision,
          hostMode: thread.runtimeMode,
        } as const;
      }),
    );
  });

const isSqlError = Schema.is(SqlError.SqlError);

/**
 * Bounded retry: at most three attempts, all before any external side effect
 * (the probe has none), then an explicit retryable outcome. Nothing is written
 * on the failed attempts because each attempt is one transaction.
 */
const offerWithBoundedRetry = (
  input: Parameters<typeof featureOffer>[0],
  attempts: Ref.Ref<number>,
  failures: Ref.Ref<ReadonlyArray<unknown>>,
  maxAttempts = 3,
) =>
  Effect.gen(function* () {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const exit = yield* Effect.exit(featureOffer(input));
      yield* Ref.set(attempts, attempt);
      if (Exit.isSuccess(exit)) return exit.value;
      yield* Ref.update(failures, (current) => [...current, Cause.squash(exit.cause)]);
    }
    return { status: "retryable-error" } as const;
  });

/**
 * Applies host lifecycle transitions newer than the citizen's watermark in one
 * transaction, exactly as the G4 probe does. With the participant attached,
 * catch-up normally has nothing to do; it is the recovery path for writes that
 * bypassed the participant and for restarts.
 */
const runLifecycleCatchUp = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    if ((yield* probeStatus) === "unavailable") return { applied: 0, status: "unavailable" };
    const applied = yield* sql.withTransaction(
      Effect.gen(function* () {
        const watermarks = yield* sql<{ readonly last_applied_sequence: number }>`
          SELECT last_applied_sequence FROM civilization_probe_citizens
          WHERE thread_id = ${threadId}
        `;
        const watermark = watermarks[0]?.last_applied_sequence;
        if (watermark === undefined) return 0;
        const transitions = yield* sql<{
          readonly sequence: number;
          readonly event_type: string;
          readonly occurred_at: string;
        }>`
          SELECT sequence, event_type, occurred_at
          FROM orchestration_events
          WHERE application_event_version = 2
            AND aggregate_kind = 'thread'
            AND stream_id = ${threadId}
            AND sequence > ${watermark}
            AND event_type IN (
              'thread.settled',
              'thread.unsettled',
              'thread.archived',
              'thread.unarchived',
              'thread.deleted'
            )
          ORDER BY sequence ASC
        `;
        let count = 0;
        for (const transition of transitions) {
          const closes = CLOSING_LIFECYCLE_EVENTS.has(transition.event_type as LifecycleEventType);
          const changed = yield* sql<{ readonly thread_id: string }>`
            UPDATE civilization_probe_citizens
            SET last_applied_sequence = ${transition.sequence},
                epoch = epoch + 1,
                closed_at = CASE
                  WHEN ${closes ? 1 : 0} = 1 THEN COALESCE(closed_at, ${transition.occurred_at})
                  ELSE NULL
                END
            WHERE thread_id = ${threadId}
              AND last_applied_sequence < ${transition.sequence}
            RETURNING thread_id
          `;
          count += changed.length;
        }
        return count;
      }),
    );
    return { applied, status: "active" as const };
  });

type CitizenRow = {
  readonly thread_id: string;
  readonly project_id: string;
  readonly name: string;
  readonly birth_sequence: number;
  readonly last_applied_sequence: number;
  readonly epoch: number;
  readonly closed_at: string | null;
};

const readCitizens = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<CitizenRow>`
    SELECT thread_id, project_id, name, birth_sequence, last_applied_sequence, epoch, closed_at
    FROM civilization_probe_citizens
    ORDER BY thread_id ASC
  `;
  return [...rows];
});

const readCitizen = (threadId: ThreadId) =>
  readCitizens.pipe(Effect.map((rows) => rows.find((row) => row.thread_id === threadId)));

type MailRow = {
  readonly mail_id: string;
  readonly from_thread_id: string;
  readonly to_thread_id: string;
  readonly accepted_epoch: number;
  readonly config_revision: number;
  readonly closed_at: string | null;
};

const readMail = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<MailRow>`
    SELECT mail_id, from_thread_id, to_thread_id, accepted_epoch, config_revision, closed_at
    FROM civilization_probe_mail
    ORDER BY mail_id ASC
  `;
  return [...rows];
});

const readConfig = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly enabled: number; readonly revision: number }>`
    SELECT enabled, revision FROM civilization_probe_config WHERE id = 1
  `;
  return rows[0];
});

const readQuota = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly accepted_count: number; readonly limit_count: number }>`
    SELECT accepted_count, limit_count FROM civilization_probe_quota WHERE id = 1
  `;
  return rows[0];
});

const countOutbox = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly count: number }>`
    SELECT COUNT(*) AS count FROM orchestration_v2_effect_outbox
  `;
  return rows[0]?.count ?? 0;
});

type ProbeServices =
  | SqlClient.SqlClient
  | EventStore.EventStoreV2
  | ProjectionStore.ProjectionStoreV2
  | EventSink.EventSinkV2
  | ProjectionMaintenance.ProjectionMaintenanceV2;

const makeProbeLayer = <E, R>(
  database: Layer.Layer<SqlClient.SqlClient, E, R>,
): Layer.Layer<ProbeServices, E, R> => {
  const eventStoreProvided = EventStore.layer.pipe(Layer.provideMerge(database));
  const projectionStoreProvided = ProjectionStore.layer.pipe(Layer.provideMerge(database));
  const stores = Layer.mergeAll(database, eventStoreProvided, projectionStoreProvided);
  return Layer.mergeAll(
    stores,
    EventSink.layer.pipe(Layer.provide(stores)),
    ProjectionMaintenance.layer.pipe(Layer.provide(stores)),
  );
};

const layerMemory = makeProbeLayer(SqlitePersistence.layerMemory);

const makeFileLayer = (
  dbPath: string,
): Layer.Layer<
  ProbeServices,
  Migrator.MigrationError | PlatformError.PlatformError | SqlError.SqlError,
  never
> =>
  makeProbeLayer(SqlitePersistence.layerFromPath(dbPath).pipe(Layer.provide(NodeServices.layer)));

const makeTempDbPath = (label: string) =>
  NodePath.join(
    NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), `t3-civ-g3-${label}-`)),
    "state.sqlite",
  );

it.effect("commits participant bookkeeping atomically with the host event and queued effects", () =>
  Effect.gen(function* () {
    const sink = yield* EventSink.EventSinkV2;
    const eventStore = yield* EventStore.EventStoreV2;
    const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
    const now = yield* DateTime.now;
    const threadId = ThreadId.make("thread:g3:atomic");
    const thread = makeThread(threadId, now);
    const commandId = CommandId.make("command:g3:atomic");

    yield* sink.write({
      events: [threadCreatedEvent({ id: "event:g3:atomic:created", thread, now })],
    });
    yield* ensureProbeSchema;
    yield* enrollCitizen(threadId, thread.projectId, "Ada");

    const stored = yield* sink.writeWithEffects({
      commandId,
      events: [
        threadLifecycleEvent({
          id: "event:g3:atomic:settled",
          type: "thread.settled",
          thread,
          now,
        }),
      ],
      effects: [
        {
          id: "effect:g3:atomic:cleanup",
          commandId,
          threadId,
          request: { type: "terminal.cleanup" },
        },
      ],
      participants: [civilizationParticipant],
    });

    assert.equal(stored.length, 1);
    assert.equal(stored[0]?.event.type, "thread.settled");
    assert.equal(yield* eventStore.latestSequence(), stored[0]?.sequence);
    const projected = yield* projectionStore.getThread(threadId);
    assert.isNotNull(projected.settledAt);
    const citizen = yield* readCitizen(threadId);
    assert.equal(citizen?.epoch, 1);
    assert.isNotNull(citizen?.closed_at);
    assert.equal(citizen?.last_applied_sequence, stored[0]?.sequence);
    assert.equal(yield* countOutbox, 1);
  }).pipe(Effect.provide(Layer.fresh(layerMemory))),
);

it.effect(
  "rolls back the event, projection, effects and feature rows when a participant fails",
  () =>
    Effect.gen(function* () {
      const sink = yield* EventSink.EventSinkV2;
      const eventStore = yield* EventStore.EventStoreV2;
      const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
      const now = yield* DateTime.now;
      const threadId = ThreadId.make("thread:g3:rollback");
      const thread = makeThread(threadId, now);
      const commandId = CommandId.make("command:g3:rollback");

      yield* sink.write({
        events: [threadCreatedEvent({ id: "event:g3:rollback:created", thread, now })],
      });
      yield* ensureProbeSchema;
      yield* enrollCitizen(threadId, thread.projectId, "Bram");
      const sequenceBefore = yield* eventStore.latestSequence();

      const exit = yield* Effect.exit(
        sink.writeWithEffects({
          commandId,
          events: [
            threadLifecycleEvent({
              id: "event:g3:rollback:settled",
              type: "thread.settled",
              thread,
              now,
            }),
          ],
          effects: [
            {
              id: "effect:g3:rollback:cleanup",
              commandId,
              threadId,
              request: { type: "terminal.cleanup" },
            },
          ],
          participants: [failingParticipant],
        }),
      );

      assert.isTrue(Exit.isFailure(exit));
      assert.equal(yield* eventStore.latestSequence(), sequenceBefore);
      const projected = yield* projectionStore.getThread(threadId);
      assert.isNull(projected.settledAt);
      const citizen = yield* readCitizen(threadId);
      assert.equal(citizen?.epoch, 0);
      assert.isNull(citizen?.closed_at);
      assert.equal(citizen?.last_applied_sequence, sequenceBefore);
      assert.equal(yield* countOutbox, 0);
      assert.equal((yield* readMail).length, 0);
    }).pipe(Effect.provide(Layer.fresh(layerMemory))),
);

it.effect(
  "offer before settlement: mail commits, then the settlement closes it in its own transaction",
  () =>
    Effect.gen(function* () {
      const sink = yield* EventSink.EventSinkV2;
      const eventStore = yield* EventStore.EventStoreV2;
      const now = yield* DateTime.now;
      const threadId = ThreadId.make("thread:g3:offer-first");
      const thread = makeThread(threadId, now);

      yield* sink.write({
        events: [threadCreatedEvent({ id: "event:g3:offer-first:created", thread, now })],
      });
      yield* ensureProbeSchema;
      yield* enrollCitizen(threadId, thread.projectId, "Cleo");

      const offered = yield* featureOffer({
        mailId: "mail:g3:offer-first:one",
        from: ThreadId.make("thread:g3:source"),
        to: threadId,
        now,
      });
      assert.equal(offered.status, "accepted");

      yield* sink.write({
        events: [
          threadLifecycleEvent({
            id: "event:g3:offer-first:settled",
            type: "thread.settled",
            thread,
            now,
          }),
        ],
        participants: [civilizationParticipant],
      });

      const mail = yield* readMail;
      assert.equal(mail.length, 1);
      assert.isNotNull(mail[0]?.closed_at, "the settlement closed the committed mail");
      assert.equal(mail[0]?.accepted_epoch, 0);
      const citizen = yield* readCitizen(threadId);
      assert.equal(citizen?.epoch, 1);
      assert.equal(citizen?.last_applied_sequence, yield* eventStore.latestSequence());

      const second = yield* featureOffer({
        mailId: "mail:g3:offer-first:two",
        from: ThreadId.make("thread:g3:source"),
        to: threadId,
        now,
      });
      assert.deepEqual(second, { status: "rejected", reason: "closed" });
      assert.equal((yield* readMail).length, 1);
    }).pipe(Effect.provide(Layer.fresh(layerMemory))),
);

it.effect("settlement before offer: the guarded read rejects delivery with no mail row", () =>
  Effect.gen(function* () {
    const sink = yield* EventSink.EventSinkV2;
    const now = yield* DateTime.now;
    const threadId = ThreadId.make("thread:g3:settle-first");
    const thread = makeThread(threadId, now);

    yield* sink.write({
      events: [threadCreatedEvent({ id: "event:g3:settle-first:created", thread, now })],
    });
    yield* ensureProbeSchema;
    yield* enrollCitizen(threadId, thread.projectId, "Dana");

    yield* sink.write({
      events: [
        threadLifecycleEvent({
          id: "event:g3:settle-first:settled",
          type: "thread.settled",
          thread,
          now,
        }),
      ],
      participants: [civilizationParticipant],
    });

    const offered = yield* featureOffer({
      mailId: "mail:g3:settle-first:one",
      from: ThreadId.make("thread:g3:source"),
      to: threadId,
      now,
    });
    assert.deepEqual(offered, { status: "rejected", reason: "closed" });
    assert.equal((yield* readMail).length, 0);
    assert.equal((yield* readQuota)?.accepted_count, 0, "a rejected offer consumes no quota");
  }).pipe(Effect.provide(Layer.fresh(layerMemory))),
);

it.effect(
  "settle then unsettle: same identity returns in a new epoch and old mail stays closed",
  () =>
    Effect.gen(function* () {
      const sink = yield* EventSink.EventSinkV2;
      const now = yield* DateTime.now;
      const threadId = ThreadId.make("thread:g3:return");
      const thread = makeThread(threadId, now);

      yield* sink.write({
        events: [threadCreatedEvent({ id: "event:g3:return:created", thread, now })],
      });
      yield* ensureProbeSchema;
      yield* enrollCitizen(threadId, thread.projectId, "Eero");

      assert.equal(
        (yield* featureOffer({
          mailId: "mail:g3:return:before",
          from: ThreadId.make("thread:g3:source"),
          to: threadId,
          now,
        })).status,
        "accepted",
      );
      yield* sink.write({
        events: [
          threadLifecycleEvent({
            id: "event:g3:return:settled",
            type: "thread.settled",
            thread,
            now,
          }),
        ],
        participants: [civilizationParticipant],
      });
      yield* sink.write({
        events: [
          threadLifecycleEvent({
            id: "event:g3:return:unsettled",
            type: "thread.unsettled",
            thread,
            now,
          }),
        ],
        participants: [civilizationParticipant],
      });

      const returned = yield* featureOffer({
        mailId: "mail:g3:return:after",
        from: ThreadId.make("thread:g3:source"),
        to: threadId,
        now,
      });
      assert.equal(returned.status, "accepted");
      assert.equal(returned.status === "accepted" ? returned.epoch : -1, 2);

      const mail = yield* readMail;
      assert.equal(mail.length, 2);
      assert.isNotNull(mail.find((row) => row.mail_id === "mail:g3:return:before")?.closed_at);
      assert.isNull(mail.find((row) => row.mail_id === "mail:g3:return:after")?.closed_at);
      const citizen = yield* readCitizen(threadId);
      assert.equal(citizen?.thread_id, threadId, "identity is the same row");
      assert.equal(citizen?.epoch, 2);
      assert.isNull(citizen?.closed_at);
    }).pipe(Effect.provide(Layer.fresh(layerMemory))),
);

it.effect(
  "archive closes delivery and unarchive reopens it under the same rules as settlement",
  () =>
    Effect.gen(function* () {
      const sink = yield* EventSink.EventSinkV2;
      const now = yield* DateTime.now;
      const threadId = ThreadId.make("thread:g3:archive");
      const thread = makeThread(threadId, now);

      yield* sink.write({
        events: [threadCreatedEvent({ id: "event:g3:archive:created", thread, now })],
      });
      yield* ensureProbeSchema;
      yield* enrollCitizen(threadId, thread.projectId, "Fern");

      yield* sink.write({
        events: [
          threadLifecycleEvent({
            id: "event:g3:archive:archived",
            type: "thread.archived",
            thread,
            now,
          }),
        ],
        participants: [civilizationParticipant],
      });
      const rejected = yield* featureOffer({
        mailId: "mail:g3:archive:one",
        from: ThreadId.make("thread:g3:source"),
        to: threadId,
        now,
      });
      assert.deepEqual(rejected, { status: "rejected", reason: "closed" });

      yield* sink.write({
        events: [
          threadLifecycleEvent({
            id: "event:g3:archive:unarchived",
            type: "thread.unarchived",
            thread,
            now,
          }),
        ],
        participants: [civilizationParticipant],
      });
      const accepted = yield* featureOffer({
        mailId: "mail:g3:archive:two",
        from: ThreadId.make("thread:g3:source"),
        to: threadId,
        now,
      });
      assert.equal(accepted.status, "accepted");
      const citizen = yield* readCitizen(threadId);
      assert.equal(citizen?.epoch, 2);
      assert.isNull(citizen?.closed_at);
    }).pipe(Effect.provide(Layer.fresh(layerMemory))),
);

it.effect(
  "project delete closes every citizen in its transaction, and a failed participant blocks it",
  () =>
    Effect.gen(function* () {
      const sink = yield* EventSink.EventSinkV2;
      const now = yield* DateTime.now;
      const projectId = ProjectId.make("project:g3:delete");
      const threadId = ThreadId.make("thread:g3:project");
      const thread = makeThread(threadId, now, { projectId });

      yield* sink.commitProjectCommand({
        commandId: CommandId.make("command:g3:project-created"),
        projectId,
        commandType: "project.create",
        acceptedAt: now,
        event: {
          eventId: EventId.make("event:g3:project-created"),
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
            title: "G3 project",
            workspaceRoot: "C:\\probe\\g3",
            defaultModelSelection: null,
            scripts: [],
            createdAt: DateTime.formatIso(now),
            updatedAt: DateTime.formatIso(now),
          },
        },
      });
      yield* sink.write({
        events: [threadCreatedEvent({ id: "event:g3:project:created", thread, now })],
      });
      yield* ensureProbeSchema;
      yield* enrollCitizen(threadId, projectId, "Gia");

      assert.equal(
        (yield* featureOffer({
          mailId: "mail:g3:project:before",
          from: ThreadId.make("thread:g3:source"),
          to: threadId,
          now,
        })).status,
        "accepted",
      );

      yield* sink.commitProjectCommand({
        commandId: CommandId.make("command:g3:project-deleted"),
        projectId,
        commandType: "project.delete",
        acceptedAt: now,
        participants: [civilizationParticipant],
        event: {
          eventId: EventId.make("event:g3:project-deleted"),
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

      const citizen = yield* readCitizen(threadId);
      assert.equal(citizen?.epoch, 1);
      assert.isNotNull(citizen?.closed_at);
      const mail = yield* readMail;
      assert.isNotNull(mail[0]?.closed_at);
      const rejected = yield* featureOffer({
        mailId: "mail:g3:project:after",
        from: ThreadId.make("thread:g3:source"),
        to: threadId,
        now,
      });
      assert.deepEqual(rejected, { status: "rejected", reason: "closed" });

      const secondProjectId = ProjectId.make("project:g3:delete-blocked");
      const secondThreadId = ThreadId.make("thread:g3:project-blocked");
      const secondThread = makeThread(secondThreadId, now, { projectId: secondProjectId });
      yield* sink.write({
        events: [
          threadCreatedEvent({ id: "event:g3:project-blocked:created", thread: secondThread, now }),
        ],
      });
      yield* enrollCitizen(secondThreadId, secondProjectId, "Hana");

      const exit = yield* Effect.exit(
        sink.commitProjectCommand({
          commandId: CommandId.make("command:g3:project-deleted-blocked"),
          projectId: secondProjectId,
          commandType: "project.delete",
          acceptedAt: now,
          participants: [failingParticipant],
          event: {
            eventId: EventId.make("event:g3:project-deleted-blocked"),
            aggregateKind: "project",
            aggregateId: secondProjectId,
            occurredAt: DateTime.formatIso(now),
            commandId: null,
            causationEventId: null,
            correlationId: null,
            metadata: {},
            type: "project.deleted",
            payload: { projectId: secondProjectId, deletedAt: DateTime.formatIso(now) },
          },
        }),
      );
      assert.isTrue(Exit.isFailure(exit));
      const blockedCitizen = yield* readCitizen(secondThreadId);
      assert.isNull(blockedCitizen?.closed_at);
    }).pipe(Effect.provide(Layer.fresh(layerMemory))),
);

it.effect("config disable and re-enable each land on one side of the offer that reads them", () =>
  Effect.gen(function* () {
    const sink = yield* EventSink.EventSinkV2;
    const sql = yield* SqlClient.SqlClient;
    const now = yield* DateTime.now;
    const threadId = ThreadId.make("thread:g3:config");
    const thread = makeThread(threadId, now);

    yield* sink.write({
      events: [threadCreatedEvent({ id: "event:g3:config:created", thread, now })],
    });
    yield* ensureProbeSchema;
    yield* enrollCitizen(threadId, thread.projectId, "Iris");

    const before = yield* featureOffer({
      mailId: "mail:g3:config:one",
      from: ThreadId.make("thread:g3:source"),
      to: threadId,
      now,
    });
    assert.equal(before.status, "accepted");
    assert.equal(before.status === "accepted" ? before.configRevision : -1, 1);

    yield* sql.withTransaction(
      sql`UPDATE civilization_probe_config SET enabled = 0, revision = revision + 1 WHERE id = 1`,
    );
    const disabled = yield* featureOffer({
      mailId: "mail:g3:config:two",
      from: ThreadId.make("thread:g3:source"),
      to: threadId,
      now,
    });
    assert.deepEqual(disabled, { status: "rejected", reason: "config-disabled" });

    yield* sql.withTransaction(
      sql`UPDATE civilization_probe_config SET enabled = 1, revision = revision + 1 WHERE id = 1`,
    );
    const reenabled = yield* featureOffer({
      mailId: "mail:g3:config:three",
      from: ThreadId.make("thread:g3:source"),
      to: threadId,
      now,
    });
    assert.equal(reenabled.status, "accepted");
    assert.equal(reenabled.status === "accepted" ? reenabled.configRevision : -1, 3);

    const mail = yield* readMail;
    assert.deepEqual(
      mail.map((row) => [row.mail_id, row.config_revision]),
      [
        ["mail:g3:config:one", 1],
        ["mail:g3:config:three", 3],
      ],
    );
    assert.deepEqual(yield* readConfig, { enabled: 1, revision: 3 });
  }).pipe(Effect.provide(Layer.fresh(layerMemory))),
);

it.effect("a mode change serializes against delivery: accepted before, rejected after", () =>
  Effect.gen(function* () {
    const sink = yield* EventSink.EventSinkV2;
    const now = yield* DateTime.now;
    const threadId = ThreadId.make("thread:g3:mode");
    const thread = makeThread(threadId, now);

    yield* sink.write({
      events: [threadCreatedEvent({ id: "event:g3:mode:created", thread, now })],
    });
    yield* ensureProbeSchema;
    yield* enrollCitizen(threadId, thread.projectId, "Jonas");

    const accepted = yield* featureOffer({
      mailId: "mail:g3:mode:one",
      from: ThreadId.make("thread:g3:source"),
      to: threadId,
      now,
    });
    assert.equal(accepted.status, "accepted");
    assert.equal(accepted.status === "accepted" ? accepted.hostMode : "", "full-access");

    yield* sink.write({
      events: [
        threadRuntimeModeEvent({
          id: "event:g3:mode:changed",
          thread,
          runtimeMode: "auto-accept-edits",
          now,
        }),
      ],
    });
    const rejected = yield* featureOffer({
      mailId: "mail:g3:mode:two",
      from: ThreadId.make("thread:g3:source"),
      to: threadId,
      now,
    });
    assert.deepEqual(rejected, { status: "rejected", reason: "mode-not-full-access" });
    assert.equal((yield* readMail).length, 1);
  }).pipe(Effect.provide(Layer.fresh(layerMemory))),
);

it.effect("two connections racing for the last quota slot admit exactly one offer", () => {
  const dbPath = makeTempDbPath("quota");
  const threadId = ThreadId.make("thread:g3:quota");

  return Effect.gen(function* () {
    const sink = yield* EventSink.EventSinkV2;
    const sql = yield* SqlClient.SqlClient;
    const now = yield* DateTime.now;
    const thread = makeThread(threadId, now);

    yield* sink.write({
      events: [threadCreatedEvent({ id: "event:g3:quota:created", thread, now })],
    });
    yield* ensureProbeSchema;
    yield* enrollCitizen(threadId, thread.projectId, "Kai");
    yield* sql.withTransaction(
      sql`UPDATE civilization_probe_quota SET accepted_count = 0, limit_count = 1 WHERE id = 1`,
    );

    const contextB = yield* Layer.build(makeFileLayer(dbPath));
    const offerB = Effect.provide(
      featureOffer({
        mailId: "mail:g3:quota:b",
        from: ThreadId.make("thread:g3:source"),
        to: threadId,
        now,
      }),
      contextB,
    );
    const offerA = featureOffer({
      mailId: "mail:g3:quota:a",
      from: ThreadId.make("thread:g3:source"),
      to: threadId,
      now,
    });

    const fiberA = yield* Effect.forkChild(offerA);
    const fiberB = yield* Effect.forkChild(offerB);
    const resultA = yield* Fiber.join(fiberA);
    const resultB = yield* Fiber.join(fiberB);

    const outcomes = [resultA.status, resultB.status].sort();
    assert.deepEqual(outcomes, ["accepted", "rejected"]);
    assert.deepEqual(
      [resultA, resultB].find((result) => result.status === "rejected"),
      { status: "rejected", reason: "quota" },
    );
    assert.equal((yield* readMail).length, 1);
    assert.equal((yield* readQuota)?.accepted_count, 1);
  }).pipe(Effect.provide(makeFileLayer(dbPath)));
});

it.effect(
  "a busy writer retries at most three times, keeps no partial state, then succeeds",
  () => {
    const dbPath = makeTempDbPath("busy");
    const threadId = ThreadId.make("thread:g3:busy");

    return Effect.gen(function* () {
      const sink = yield* EventSink.EventSinkV2;
      const sql = yield* SqlClient.SqlClient;
      const now = yield* DateTime.now;
      const thread = makeThread(threadId, now);

      yield* sink.write({
        events: [threadCreatedEvent({ id: "event:g3:busy:created", thread, now })],
      });
      yield* ensureProbeSchema;
      yield* enrollCitizen(threadId, thread.projectId, "Lena");

      const contextB = yield* Layer.build(makeFileLayer(dbPath));
      const runB = <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.provide(effect, contextB);
      yield* runB(
        Effect.gen(function* () {
          const sqlB = yield* SqlClient.SqlClient;
          yield* sqlB`PRAGMA busy_timeout = 0;`;
        }),
      );

      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const holder = yield* Effect.forkChild(
        sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`UPDATE civilization_probe_config SET revision = revision WHERE id = 1`;
            yield* Deferred.succeed(started, undefined);
            yield* Deferred.await(release);
          }),
        ),
      );
      yield* Deferred.await(started);

      const attempts = yield* Ref.make(0);
      const failures = yield* Ref.make<ReadonlyArray<unknown>>([]);
      const first = yield* runB(
        offerWithBoundedRetry(
          {
            mailId: "mail:g3:busy:one",
            from: ThreadId.make("thread:g3:source"),
            to: threadId,
            now,
          },
          attempts,
          failures,
        ),
      );
      assert.equal(first.status, "retryable-error");
      assert.equal(yield* Ref.get(attempts), 3, "retries are bounded at three attempts");
      const seenFailures = yield* Ref.get(failures);
      assert.isTrue(
        seenFailures.every(
          (failure) => isSqlError(failure) && failure.reason._tag === "LockTimeoutError",
        ),
        `all attempts must fail as SQLITE_BUSY: ${seenFailures.map((failure) => String(failure)).join(" | ")}`,
      );
      assert.equal((yield* runB(readMail)).length, 0, "no partial mail from failed attempts");
      assert.equal((yield* runB(readQuota))?.accepted_count, 0, "no quota consumed");

      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(holder);

      const secondAttempts = yield* Ref.make(0);
      const secondFailures = yield* Ref.make<ReadonlyArray<unknown>>([]);
      const second = yield* runB(
        offerWithBoundedRetry(
          {
            mailId: "mail:g3:busy:two",
            from: ThreadId.make("thread:g3:source"),
            to: threadId,
            now,
          },
          secondAttempts,
          secondFailures,
        ),
      );
      assert.equal(second.status, "accepted");
      assert.equal(yield* Ref.get(secondAttempts), 1);
      assert.equal((yield* readMail).length, 1);
      assert.equal((yield* readQuota)?.accepted_count, 1);
    }).pipe(Effect.provide(makeFileLayer(dbPath)));
  },
);

it.effect(
  "the in-transaction participant keeps the watermark current, so compaction cannot strand it",
  () =>
    Effect.gen(function* () {
      const sink = yield* EventSink.EventSinkV2;
      const eventStore = yield* EventStore.EventStoreV2;
      const maintenance = yield* ProjectionMaintenance.ProjectionMaintenanceV2;
      const sql = yield* SqlClient.SqlClient;
      const now = yield* DateTime.now;
      const threadId = ThreadId.make("thread:g3:compaction");
      const thread = makeThread(threadId, now);

      yield* sink.write({
        events: [threadCreatedEvent({ id: "event:g3:compaction:created", thread, now })],
      });
      yield* ensureProbeSchema;
      yield* enrollCitizen(threadId, thread.projectId, "Mira");

      assert.equal(
        (yield* featureOffer({
          mailId: "mail:g3:compaction:before",
          from: ThreadId.make("thread:g3:source"),
          to: threadId,
          now,
        })).status,
        "accepted",
      );
      yield* sink.write({
        events: [
          threadLifecycleEvent({
            id: "event:g3:compaction:settled",
            type: "thread.settled",
            thread,
            now,
          }),
        ],
        participants: [civilizationParticipant],
      });
      const watermarkAfterSettle = (yield* readCitizen(threadId))?.last_applied_sequence;
      assert.equal(watermarkAfterSettle, yield* eventStore.latestSequence());

      yield* sink.write({
        events: [
          threadLifecycleEvent({
            id: "event:g3:compaction:unsettled",
            type: "thread.unsettled",
            thread,
            now,
          }),
        ],
        participants: [civilizationParticipant],
      });
      assert.equal(
        (yield* readCitizen(threadId))?.last_applied_sequence,
        yield* eventStore.latestSequence(),
        "an active citizen's watermark is the committed host sequence",
      );
      assert.equal(
        (yield* featureOffer({
          mailId: "mail:g3:compaction:after",
          from: ThreadId.make("thread:g3:source"),
          to: threadId,
          now,
        })).status,
        "accepted",
      );

      const summary = yield* maintenance.compactEventStore;
      assert.isAtLeast(summary.deletedEventCount, 1, "the superseded settle event is compacted");
      const deleted = yield* sql<{ readonly event_id: string }>`
      SELECT event_id FROM orchestration_events WHERE event_id = 'event:g3:compaction:settled'
    `;
      assert.equal(deleted.length, 0);

      assert.equal((yield* runLifecycleCatchUp(threadId)).applied, 0);
      const mail = yield* readMail;
      assert.isNotNull(mail.find((row) => row.mail_id === "mail:g3:compaction:before")?.closed_at);
      assert.isNull(mail.find((row) => row.mail_id === "mail:g3:compaction:after")?.closed_at);
      const citizen = yield* readCitizen(threadId);
      assert.equal(citizen?.epoch, 2);
      assert.isNull(citizen?.closed_at);
    }).pipe(Effect.provide(Layer.fresh(layerMemory))),
);

it.effect("compaction interleaved with catch-up keeps one serial ordering", () =>
  Effect.gen(function* () {
    const sink = yield* EventSink.EventSinkV2;
    const maintenance = yield* ProjectionMaintenance.ProjectionMaintenanceV2;
    const now = yield* DateTime.now;
    const threadId = ThreadId.make("thread:g3:interleave");
    const thread = makeThread(threadId, now);

    yield* sink.write({
      events: [threadCreatedEvent({ id: "event:g3:interleave:created", thread, now })],
    });
    yield* ensureProbeSchema;
    yield* enrollCitizen(threadId, thread.projectId, "Nico");
    yield* sink.write({
      events: [
        threadLifecycleEvent({
          id: "event:g3:interleave:settled",
          type: "thread.settled",
          thread,
          now,
        }),
      ],
      participants: [civilizationParticipant],
    });
    yield* sink.write({
      events: [
        threadLifecycleEvent({
          id: "event:g3:interleave:unsettled",
          type: "thread.unsettled",
          thread,
          now,
        }),
      ],
      participants: [civilizationParticipant],
    });

    const [summary, catchUps] = yield* Effect.all(
      [
        maintenance.compactEventStore,
        Effect.forEach([1, 2, 3], () => runLifecycleCatchUp(threadId), { concurrency: 1 }),
      ],
      { concurrency: 2 },
    );

    assert.isAtLeast(summary.deletedEventCount, 1);
    assert.deepEqual(
      catchUps.map((result) => result.applied),
      [0, 0, 0],
      "a current watermark makes catch-up independent of compaction ordering",
    );
    const citizen = yield* readCitizen(threadId);
    assert.equal(citizen?.epoch, 2);
    assert.isNull(citizen?.closed_at);
  }).pipe(Effect.provide(Layer.fresh(layerMemory))),
);

it.effect("hazard control: bypassing the participant lets compaction strand a closure", () =>
  Effect.gen(function* () {
    const sink = yield* EventSink.EventSinkV2;
    const maintenance = yield* ProjectionMaintenance.ProjectionMaintenanceV2;
    const sql = yield* SqlClient.SqlClient;
    const now = yield* DateTime.now;
    const threadId = ThreadId.make("thread:g3:hazard");
    const thread = makeThread(threadId, now);

    yield* sink.write({
      events: [threadCreatedEvent({ id: "event:g3:hazard:created", thread, now })],
    });
    yield* ensureProbeSchema;
    yield* enrollCitizen(threadId, thread.projectId, "Otto");
    assert.equal(
      (yield* featureOffer({
        mailId: "mail:g3:hazard:one",
        from: ThreadId.make("thread:g3:source"),
        to: threadId,
        now,
      })).status,
      "accepted",
    );

    // Simulate a lifecycle write that bypassed the participant: the settle and
    // unsettle events commit without feature bookkeeping, so the citizen stays
    // at its birth watermark.
    yield* sql.withTransaction(
      sql`UPDATE civilization_probe_citizens SET last_applied_sequence = birth_sequence WHERE thread_id = ${threadId}`,
    );
    yield* sink.write({
      events: [
        threadLifecycleEvent({
          id: "event:g3:hazard:settled",
          type: "thread.settled",
          thread,
          now,
        }),
      ],
    });
    yield* sink.write({
      events: [
        threadLifecycleEvent({
          id: "event:g3:hazard:unsettled",
          type: "thread.unsettled",
          thread,
          now,
        }),
      ],
    });

    const summary = yield* maintenance.compactEventStore;
    assert.isAtLeast(summary.deletedEventCount, 1);

    // Catch-up now sees only the retained unsettle event: the close that the
    // citizen never applied was compacted away, so the closure is lost and the
    // mail stays open. This is why every lifecycle-committing write path must
    // carry the participant (enumerated by G6), not merely rely on catch-up.
    const applied = yield* runLifecycleCatchUp(threadId);
    assert.equal(applied.applied, 1);
    const citizen = yield* readCitizen(threadId);
    assert.isNull(citizen?.closed_at);
    assert.equal(citizen?.epoch, 1);
    assert.isNull((yield* readMail)[0]?.closed_at);
  }).pipe(Effect.provide(Layer.fresh(layerMemory))),
);
