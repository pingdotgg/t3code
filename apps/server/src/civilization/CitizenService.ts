import {
  type CivilizationCitizenSummary,
  type CivilizationLineageStatus,
  type CivilizationRelationshipToParent,
  type ProjectId,
  ThreadId,
  type ThreadId as ThreadIdType,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

import * as EventStore from "../orchestration-v2/EventStore.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import { getEffectiveCivilizationConfig } from "./ConfigService.ts";
import {
  enrollCivilizationThread,
  reconcileCivilizationStoredEvent,
} from "./PersistenceParticipant.ts";

type AdoptionRow = {
  readonly thread_id: string;
  readonly project_id: string;
};

const ADOPTION_BATCH_SIZE = 100;

type RecoveryRow = {
  readonly thread_id: string;
  readonly last_applied_sequence: number;
};

type CitizenSummaryRow = {
  readonly thread_id: ThreadIdType;
  readonly project_id: ProjectId;
  readonly name_display: string;
  readonly profile_entry_id: string;
  readonly profile_label: string;
  readonly generation: number;
  readonly lineage_status: CivilizationLineageStatus;
  readonly parent_thread_id: ThreadIdType | null;
  readonly relationship_to_parent: CivilizationRelationshipToParent;
  readonly observed_only: number;
  readonly epoch: number;
  readonly closed: number;
  readonly deleted: number;
  readonly title_managed: number;
  readonly revision: number;
};

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const eventStore = yield* EventStore.EventStoreV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const provideSql = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
    effect.pipe(Effect.provideService(SqlClient.SqlClient, sql));

  const adoptExisting = Effect.fn("CivilizationCitizenService.adoptExisting")(function* (input?: {
    readonly projectId?: ProjectId;
  }) {
    let afterProjectId: string | undefined;
    let afterThreadId: string | undefined;
    let candidates = 0;
    let adopted = 0;
    let skipped = 0;
    while (true) {
      const rows =
        input?.projectId === undefined
          ? afterProjectId === undefined || afterThreadId === undefined
            ? yield* sql<AdoptionRow>`
              SELECT t.thread_id, t.project_id
              FROM orchestration_v2_projection_threads t
              LEFT JOIN civilization_citizens c ON c.thread_id = t.thread_id
              WHERE t.deleted_at IS NULL AND c.thread_id IS NULL
              ORDER BY t.project_id ASC, t.thread_id ASC
              LIMIT ${ADOPTION_BATCH_SIZE}
            `
            : yield* sql<AdoptionRow>`
              SELECT t.thread_id, t.project_id
              FROM orchestration_v2_projection_threads t
              LEFT JOIN civilization_citizens c ON c.thread_id = t.thread_id
              WHERE t.deleted_at IS NULL AND c.thread_id IS NULL
                AND (t.project_id > ${afterProjectId}
                  OR (t.project_id = ${afterProjectId} AND t.thread_id > ${afterThreadId}))
              ORDER BY t.project_id ASC, t.thread_id ASC
              LIMIT ${ADOPTION_BATCH_SIZE}
            `
          : afterThreadId === undefined
            ? yield* sql<AdoptionRow>`
              SELECT t.thread_id, t.project_id
              FROM orchestration_v2_projection_threads t
              LEFT JOIN civilization_citizens c ON c.thread_id = t.thread_id
              WHERE t.deleted_at IS NULL AND c.thread_id IS NULL AND t.project_id = ${input.projectId}
              ORDER BY t.thread_id ASC
              LIMIT ${ADOPTION_BATCH_SIZE}
            `
            : yield* sql<AdoptionRow>`
              SELECT t.thread_id, t.project_id
              FROM orchestration_v2_projection_threads t
              LEFT JOIN civilization_citizens c ON c.thread_id = t.thread_id
              WHERE t.deleted_at IS NULL AND c.thread_id IS NULL AND t.project_id = ${input.projectId}
                AND t.thread_id > ${afterThreadId}
              ORDER BY t.thread_id ASC
              LIMIT ${ADOPTION_BATCH_SIZE}
            `;
      if (rows.length === 0) break;

      candidates += rows.length;
      for (const row of rows) {
        const projectId = row.project_id as ProjectId;
        const effective = yield* provideSql(getEffectiveCivilizationConfig(projectId));
        if (
          !effective.config.participation.enabled ||
          effective.config.participation.emergencyOff ||
          effective.config.participation.adoption !== "all_existing"
        ) {
          skipped += 1;
          continue;
        }
        const threadId = ThreadId.make(row.thread_id);
        const thread = yield* projections.getThread(threadId);
        const sequence = yield* eventStore.latestSequence({ threadId });
        const inserted = yield* sql.withTransaction(
          provideSql(enrollCivilizationThread({ sequence, thread, adoption: true })),
        );
        if (inserted) adopted += 1;
        else skipped += 1;
      }
      const last = rows.at(-1)!;
      afterProjectId = last.project_id;
      afterThreadId = last.thread_id;
      yield* Effect.yieldNow;
      if (rows.length < ADOPTION_BATCH_SIZE) break;
    }
    return { candidates, adopted, skipped } as const;
  });

  const reconcileExisting = Effect.fn("CivilizationCitizenService.reconcileExisting")(function* () {
    const rows = yield* sql<RecoveryRow>`
      SELECT thread_id, last_applied_sequence
      FROM civilization_citizens
      ORDER BY thread_id ASC
    `;
    let appliedEventCount = 0;
    let caughtUpCitizenCount = 0;
    for (const row of rows) {
      const threadId = ThreadId.make(row.thread_id);
      const eventChunk = yield* eventStore
        .read({ threadId, afterSequence: row.last_applied_sequence })
        .pipe(Stream.runCollect);
      const events = Array.from(eventChunk);
      if (events.length === 0) continue;
      yield* sql.withTransaction(
        Effect.forEach(
          events,
          (stored) =>
            provideSql(reconcileCivilizationStoredEvent({ stored, allowEnrollment: false })),
          { concurrency: 1, discard: true },
        ),
      );
      appliedEventCount += events.length;
      caughtUpCitizenCount += 1;
      if (caughtUpCitizenCount % 100 === 0) yield* Effect.yieldNow;
    }
    return { citizenCount: rows.length, caughtUpCitizenCount, appliedEventCount } as const;
  });

  const getCitizen = Effect.fn("CivilizationCitizenService.getCitizen")(function* (
    threadId: ThreadIdType,
  ) {
    const row = (yield* sql<CitizenSummaryRow>`
        SELECT thread_id, project_id, name_display, profile_entry_id, profile_label,
               generation, lineage_status, parent_thread_id, relationship_to_parent, observed_only,
               epoch, closed, deleted, title_managed, revision
        FROM civilization_citizens
        WHERE thread_id = ${threadId}
        LIMIT 1
      `)[0];
    if (row === undefined) return null;
    return {
      threadId: row.thread_id,
      projectId: row.project_id,
      name: row.name_display,
      profileId: row.profile_entry_id,
      profileLabel: row.profile_label,
      generation: row.generation,
      lineageStatus: row.lineage_status,
      parentThreadId: row.parent_thread_id,
      relationshipToParent: row.relationship_to_parent,
      observedOnly: row.observed_only === 1,
      epoch: row.epoch,
      closed: row.closed === 1,
      deleted: row.deleted === 1,
      titleManaged: row.title_managed === 1,
      revision: row.revision,
    } satisfies CivilizationCitizenSummary;
  });

  return { adoptExisting, reconcileExisting, getCitizen } as const;
});

export class CivilizationCitizenService extends Context.Service<
  CivilizationCitizenService,
  Effect.Success<typeof make>
>()("t3/civilization/CitizenService/CivilizationCitizenService") {}

export const layer = Layer.effect(CivilizationCitizenService, make);
