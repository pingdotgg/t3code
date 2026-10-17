// @effect-diagnostics preferSchemaOverJson:off
import {
  CIVILIZATION_NAME_GENERATOR_VERSION,
  type CivilizationLineageStatus,
  isProviderNativeSubagentThread,
  OrchestrationV2AppThread,
  type OrchestrationV2StoredEvent,
  type ProjectId,
  type ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Random from "effect/Random";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import type { EventSinkPersistenceParticipant } from "../orchestration-v2/EventSink.ts";
import {
  getEffectiveCivilizationConfig,
  normalizeCivilizationName,
  weightedCivilizationEntry,
} from "./ConfigService.ts";

type CitizenLifecycleRow = {
  readonly thread_id: string;
  readonly epoch: number;
  readonly closed: number;
  readonly deleted: number;
  readonly delivery_epoch: number;
  readonly delivery_settled: number;
  readonly delivery_archived: number;
  readonly delivery_deleted: number;
  readonly last_applied_sequence: number;
  readonly title_managed: number;
  readonly preserved_title: string | null;
  readonly last_managed_title: string | null;
  readonly pending_title_command_id: string | null;
  readonly pending_managed_title: string | null;
  readonly pending_title_topic: string | null;
};

type ProjectionLineageRow = {
  readonly project_id: string;
  readonly parent_thread_id: string | null;
};

const CIVILIZATION_MAX_LINEAGE_DEPTH = 256;

const isAppThread = Schema.is(OrchestrationV2AppThread);

export function civilizationThreadClosed(thread: OrchestrationV2AppThread): boolean {
  return (
    thread.settledOverride === "settled" || thread.archivedAt !== null || thread.deletedAt !== null
  );
}

function civilizationDeliveryState(thread: OrchestrationV2AppThread) {
  return {
    settled: thread.settledOverride === "settled",
    archived: thread.archivedAt !== null,
    deleted: thread.deletedAt !== null,
  } as const;
}

const deriveCivilizationLineage = Effect.fn("civilization.deriveLineage")(function* (
  thread: OrchestrationV2AppThread,
) {
  if (thread.lineage.parentThreadId === null) {
    return { generation: 0, lineageStatus: "resolved" as const };
  }

  const sql = yield* SqlClient.SqlClient;
  const seen = new Set<string>([thread.id]);
  let generation = 0;
  let cursor: string | null = thread.lineage.parentThreadId;
  let lineageStatus: CivilizationLineageStatus = "resolved";

  while (cursor !== null) {
    if (generation >= CIVILIZATION_MAX_LINEAGE_DEPTH) {
      lineageStatus = "depth_limit";
      break;
    }
    generation += 1;
    if (seen.has(cursor)) {
      lineageStatus = "cycle";
      break;
    }
    seen.add(cursor);

    const lineageRows: ReadonlyArray<ProjectionLineageRow> = yield* sql<ProjectionLineageRow>`
      SELECT project_id,
             json_extract(payload_json, '$.lineage.parentThreadId') AS parent_thread_id
      FROM orchestration_v2_projection_threads
      WHERE thread_id = ${cursor}
      LIMIT 1
    `;
    const row: ProjectionLineageRow | undefined = lineageRows[0];
    if (row === undefined) {
      lineageStatus = "missing";
      break;
    }
    if (row.project_id !== thread.projectId) {
      lineageStatus = "cross_project";
      break;
    }
    cursor = row.parent_thread_id;
  }

  return { generation, lineageStatus } as const;
});

function fitCollisionName(base: string, suffix: string): string {
  const tail = `~${suffix}`;
  const budget = 128 - Buffer.byteLength(tail, "utf8");
  let prefix = "";
  for (const character of base) {
    if (Buffer.byteLength(prefix + character, "utf8") > budget) break;
    prefix += character;
  }
  return `${prefix}${tail}`;
}

function collisionCandidates(base: string, threadId: ThreadId): ReadonlyArray<string> {
  const source = threadId.replace(/[^a-z0-9]/gi, "").toLocaleLowerCase("en-US") || "thread";
  const lengths = [4, 8, 12, source.length];
  return [base, ...new Set(lengths.map((length) => fitCollisionName(base, source.slice(-length))))];
}

export const resolveCivilizationAvailableName = Effect.fn("civilization.findAvailableName")(
  function* (projectId: ProjectId, base: string, threadId: ThreadId) {
    const sql = yield* SqlClient.SqlClient;
    for (const displayName of collisionCandidates(base, threadId)) {
      const nameKey = normalizeCivilizationName(displayName);
      const rows = yield* sql<{ readonly thread_id: string }>`
      SELECT thread_id FROM civilization_citizens
      WHERE project_id = ${projectId} AND name_key = ${nameKey}
      LIMIT 1
    `;
      if (rows.length === 0 || rows[0]?.thread_id === threadId) return { displayName, nameKey };
    }
    return yield* Effect.die(`Unable to derive a unique Civilization name for ${threadId}.`);
  },
);

export const enrollCivilizationThread = Effect.fn("civilization.enrollThread")(function* (input: {
  readonly sequence: number;
  readonly thread: OrchestrationV2AppThread;
  readonly adoption: boolean;
}) {
  const { thread } = input;
  const sql = yield* SqlClient.SqlClient;
  const existing = yield* sql<{ readonly thread_id: string }>`
    SELECT thread_id FROM civilization_citizens WHERE thread_id = ${thread.id} LIMIT 1
  `;
  if (existing.length > 0) return false;

  const effective = yield* getEffectiveCivilizationConfig(thread.projectId).pipe(
    Effect.catchTags({
      CivilizationUnavailableError: (error) =>
        Effect.logWarning(
          "Civilization enrollment skipped because configuration is unavailable",
        ).pipe(
          Effect.annotateLogs({ projectId: thread.projectId, reason: error.reason }),
          Effect.as(undefined),
        ),
    }),
  );
  if (effective === undefined) return false;
  const participation = effective.config.participation;
  if (!participation.enabled || participation.emergencyOff) return false;
  const observedOnly = isProviderNativeSubagentThread(thread);
  const controllableChild = thread.lineage.parentThreadId !== null && !observedOnly;
  if (controllableChild && !participation.includeControllableChildren) {
    return false;
  }

  const namePool = effective.config.names.pools.find(
    (pool) => pool.id === effective.config.names.selectedPoolId,
  )!;
  const profilePool = effective.config.personalities.pools.find(
    (pool) => pool.id === effective.config.personalities.selectedPoolId,
  )!;
  const nameTotal = namePool.entries.reduce((sum, entry) => sum + entry.weight, 0);
  const profileTotal = profilePool.entries.reduce((sum, entry) => sum + entry.weight, 0);
  const nameDraw = yield* Random.nextIntBetween(0, nameTotal, { halfOpen: true });
  const profileDraw = yield* Random.nextIntBetween(0, profileTotal, { halfOpen: true });
  const nameEntry = weightedCivilizationEntry(namePool.entries, nameDraw);
  const profileEntry = weightedCivilizationEntry(profilePool.entries, profileDraw);
  const name = yield* resolveCivilizationAvailableName(
    thread.projectId,
    nameEntry.displayName,
    thread.id,
  );
  const lineage = yield* deriveCivilizationLineage(thread);
  const closed = civilizationThreadClosed(thread);
  const delivery = civilizationDeliveryState(thread);
  const createdAt = DateTime.formatIso(thread.createdAt);
  const updatedAt = DateTime.formatIso(thread.updatedAt);
  const titleManaged =
    effective.config.names.automaticTitles &&
    !observedOnly &&
    (!input.adoption || effective.config.names.adoptionTitlePolicy === "managed");

  yield* sql`
    INSERT INTO civilization_citizens (
      thread_id, project_id, parent_thread_id, relationship_to_parent, root_thread_id, generation, lineage_status, observed_only,
      birth_sequence, last_applied_sequence,
      name_entry_id, name_generator_version, name_base, name_display, name_key, name_pool_id,
      name_environment_revision, name_project_revision,
      profile_entry_id, profile_label, profile_traits_json, profile_style_text, profile_pool_id,
      profile_rich_label, profile_rich_traits_json, profile_rich_axiom, profile_rich_voice, profile_rich_style_text,
      profile_environment_revision, profile_project_revision,
      title_managed, preserved_title, last_managed_title, title_topic,
      pending_title_command_id, pending_managed_title, pending_title_topic,
      epoch, closed, deleted,
      delivery_epoch, delivery_settled, delivery_archived, delivery_deleted,
      revision, created_at, updated_at
    ) VALUES (
      ${thread.id}, ${thread.projectId}, ${thread.lineage.parentThreadId}, ${thread.lineage.relationshipToParent}, ${thread.lineage.rootThreadId}, ${lineage.generation}, ${lineage.lineageStatus}, ${observedOnly ? 1 : 0},
      ${input.sequence}, ${input.sequence},
      ${nameEntry.id}, ${CIVILIZATION_NAME_GENERATOR_VERSION}, ${nameEntry.displayName}, ${name.displayName}, ${name.nameKey}, ${namePool.id},
      ${effective.environmentRevision}, ${effective.projectRevision},
      ${profileEntry.id}, ${profileEntry.label}, ${JSON.stringify(profileEntry.traits)}, ${profileEntry.styleText}, ${profilePool.id},
      ${profileEntry.rich.label}, ${JSON.stringify(profileEntry.rich.traits)}, ${profileEntry.rich.axiom}, ${profileEntry.rich.voice}, ${profileEntry.rich.styleText},
      ${effective.environmentRevision}, ${effective.projectRevision},
      ${titleManaged ? 1 : 0}, ${thread.title}, NULL, ${thread.title},
      NULL, NULL, NULL,
      0, ${closed ? 1 : 0}, ${thread.deletedAt === null ? 0 : 1},
      0, ${delivery.settled ? 1 : 0}, ${delivery.archived ? 1 : 0}, ${delivery.deleted ? 1 : 0},
      1, ${createdAt}, ${updatedAt}
    )
  `;
  return true;
});

export const reconcileCivilizationStoredEvent = Effect.fn("civilization.reconcileThreadEvent")(
  function* (input: {
    readonly stored: OrchestrationV2StoredEvent;
    readonly allowEnrollment: boolean;
  }) {
    const { stored } = input;
    const sql = yield* SqlClient.SqlClient;
    if (input.allowEnrollment && stored.event.type === "thread.created") {
      yield* enrollCivilizationThread({
        sequence: stored.sequence,
        thread: stored.event.payload,
        adoption: false,
      });
    }
    const thread = isAppThread(stored.event.payload) ? stored.event.payload : undefined;
    const row = (yield* sql<CitizenLifecycleRow>`
      SELECT thread_id, epoch, closed, deleted,
             delivery_epoch, delivery_settled, delivery_archived, delivery_deleted,
             last_applied_sequence, title_managed,
             preserved_title, last_managed_title,
             pending_title_command_id, pending_managed_title, pending_title_topic
      FROM civilization_citizens
      WHERE thread_id = ${stored.event.threadId}
      LIMIT 1
    `)[0];
    if (row === undefined || stored.sequence <= row.last_applied_sequence) return;

    if (thread === undefined || thread.id !== stored.event.threadId) {
      yield* sql`
      UPDATE civilization_citizens
      SET last_applied_sequence = ${stored.sequence}, updated_at = datetime('now')
      WHERE thread_id = ${stored.event.threadId}
    `;
      return;
    }

    const nextClosed = civilizationThreadClosed(thread);
    const nextDeleted = thread.deletedAt === null ? 0 : 1;
    const changedLifecycle = nextClosed !== (row.closed === 1);
    const delivery = civilizationDeliveryState(thread);
    const enteredSettled = delivery.settled && row.delivery_settled === 0;
    const enteredArchived = delivery.archived && row.delivery_archived === 0;
    const enteredDeleted = delivery.deleted && row.delivery_deleted === 0;
    const deliveryEpochAdvance =
      (enteredSettled ? 1 : 0) + (enteredArchived ? 1 : 0) + (enteredDeleted ? 1 : 0);
    const deliveryStateChanged =
      delivery.settled !== (row.delivery_settled === 1) ||
      delivery.archived !== (row.delivery_archived === 1) ||
      delivery.deleted !== (row.delivery_deleted === 1);
    const terminalReason = enteredDeleted
      ? "recipient_deleted"
      : enteredArchived
        ? "recipient_archived"
        : enteredSettled
          ? "recipient_settled"
          : null;
    const pendingTitleLanded =
      row.title_managed === 1 &&
      row.pending_title_command_id !== null &&
      stored.commandId === row.pending_title_command_id &&
      row.pending_managed_title !== null &&
      thread.title === row.pending_managed_title;
    const expectedManagedTitle = row.last_managed_title ?? row.preserved_title;
    const titleRelinquished =
      row.title_managed === 1 &&
      !pendingTitleLanded &&
      thread.titleRegeneration == null &&
      expectedManagedTitle !== null &&
      thread.title !== expectedManagedTitle;
    const citizenStateChanged =
      changedLifecycle ||
      nextDeleted !== row.deleted ||
      deliveryStateChanged ||
      pendingTitleLanded ||
      titleRelinquished;
    yield* sql`
    UPDATE civilization_citizens
    SET epoch = epoch + ${changedLifecycle ? 1 : 0},
        closed = ${nextClosed ? 1 : 0},
        deleted = ${nextDeleted},
        delivery_epoch = delivery_epoch + ${deliveryEpochAdvance},
        delivery_settled = ${delivery.settled ? 1 : 0},
        delivery_archived = ${delivery.archived ? 1 : 0},
        delivery_deleted = ${delivery.deleted ? 1 : 0},
        last_applied_sequence = ${stored.sequence},
        title_managed = ${titleRelinquished ? 0 : row.title_managed},
        preserved_title = CASE WHEN ${titleRelinquished ? 1 : 0} = 1 THEN ${thread.title} ELSE preserved_title END,
        last_managed_title = CASE WHEN ${pendingTitleLanded ? 1 : 0} = 1 THEN ${row.pending_managed_title} ELSE last_managed_title END,
        title_topic = CASE WHEN ${pendingTitleLanded ? 1 : 0} = 1 THEN ${row.pending_title_topic} ELSE title_topic END,
        pending_title_command_id = CASE WHEN ${pendingTitleLanded || titleRelinquished ? 1 : 0} = 1 THEN NULL ELSE pending_title_command_id END,
        pending_managed_title = CASE WHEN ${pendingTitleLanded || titleRelinquished ? 1 : 0} = 1 THEN NULL ELSE pending_managed_title END,
        pending_title_topic = CASE WHEN ${pendingTitleLanded || titleRelinquished ? 1 : 0} = 1 THEN NULL ELSE pending_title_topic END,
        revision = revision + ${citizenStateChanged ? 1 : 0},
        updated_at = ${DateTime.formatIso(thread.updatedAt)}
    WHERE thread_id = ${stored.event.threadId}
  `;
    if (terminalReason !== null) {
      const terminalAt = DateTime.formatIso(stored.event.occurredAt);
      yield* sql`
      UPDATE civilization_messages
      SET terminal_at = ${terminalAt}, terminal_reason = ${terminalReason}
      WHERE recipient_thread_id = ${stored.event.threadId}
        AND terminal_at IS NULL
        AND acknowledged_at IS NULL
    `;
    }
  },
);

const reconcileProjectEvent = Effect.fn("civilization.reconcileProjectEvent")(function* (
  event: Parameters<EventSinkPersistenceParticipant["apply"]>[0]["projectEvents"][number],
) {
  if (event.type !== "project.deleted") return;
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    UPDATE civilization_citizens
    SET epoch = epoch + CASE WHEN closed = 0 THEN 1 ELSE 0 END,
        closed = 1,
        deleted = 1,
        delivery_epoch = delivery_epoch + CASE WHEN delivery_deleted = 0 THEN 1 ELSE 0 END,
        delivery_deleted = 1,
        last_applied_sequence = CASE
          WHEN last_applied_sequence < ${event.sequence} THEN ${event.sequence}
          ELSE last_applied_sequence
        END,
        revision = revision + 1,
        updated_at = ${event.occurredAt}
    WHERE project_id = ${event.aggregateId}
  `;
  yield* sql`
    UPDATE civilization_messages
    SET terminal_at = ${event.occurredAt}, terminal_reason = 'project_deleted'
    WHERE project_id = ${event.aggregateId}
      AND terminal_at IS NULL
      AND acknowledged_at IS NULL
  `;
});

export const civilizationPersistenceParticipant: EventSinkPersistenceParticipant = {
  name: "civilization",
  apply: ({ storedEvents, projectEvents }) =>
    Effect.gen(function* () {
      yield* Effect.forEach(
        storedEvents,
        (stored) => reconcileCivilizationStoredEvent({ stored, allowEnrollment: true }),
        { concurrency: 1, discard: true },
      );
      yield* Effect.forEach(projectEvents, reconcileProjectEvent, {
        concurrency: 1,
        discard: true,
      });
    }),
};
