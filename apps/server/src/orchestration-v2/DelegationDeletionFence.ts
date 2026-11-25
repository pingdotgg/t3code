import type { OrchestrationV2DomainEvent } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

class DelegationOwnerDeletedError extends Schema.TaggedError<DelegationOwnerDeletedError>()(
  "DelegationOwnerDeletedError",
  {},
) {
  override get message() {
    return "Cannot start delegated work after its owning thread or project was deleted.";
  }
}

// EventSink owns the transaction span; provider snapshots also pass through this guard.
export const prepareDeletionFence = Effect.fnUntraced(function* (
  events: ReadonlyArray<OrchestrationV2DomainEvent>,
) {
  const sql = yield* SqlClient.SqlClient;
  const admissions = new Set<string>();
  for (const event of events) {
    if (
      event.type === "thread.created" &&
      event.payload.lineage.relationshipToParent === "subagent"
    ) {
      admissions.add(event.threadId);
    }
    if (
      event.type === "subagent.updated" &&
      event.payload.origin === "app_owned" &&
      ["idle", "pending", "running", "waiting"].includes(event.payload.status)
    ) {
      const rows = yield* sql<{ status: string }>`
        SELECT status FROM orchestration_v2_projection_subagents
        WHERE subagent_id = ${event.payload.id} AND thread_id = ${event.threadId}
      `;
      if (rows[0]?.status !== event.payload.status) admissions.add(event.threadId);
    }
    if (
      (event.type !== "run.created" && event.type !== "run.updated") ||
      !["queued", "preparing", "starting", "running", "waiting"].includes(event.payload.status)
    )
      continue;
    const rows = yield* sql<{ status: string; attempt: string | null; held: number | null }>`
      SELECT status, json_extract(payload_json, '$.activeAttemptId') AS attempt,
        json_extract(payload_json, '$.queueHeld') AS held
      FROM orchestration_v2_projection_runs WHERE run_id = ${event.payload.id}
        AND thread_id = ${event.threadId}
    `;
    if (
      rows[0]?.status !== event.payload.status ||
      rows[0]?.attempt !== event.payload.activeAttemptId ||
      (event.payload.status === "queued" && rows[0]?.held === 1 && event.payload.queueHeld !== true)
    ) {
      admissions.add(event.threadId);
    }
  }
  return Effect.gen(function* () {
    if (admissions.size === 0) return;
    const deleted = yield* sql`
      WITH RECURSIVE owners(thread_id) AS (
        SELECT thread_id FROM orchestration_v2_projection_threads
        WHERE thread_id IN ${sql.in([...admissions])}
        UNION
        SELECT json_extract(thread.payload_json, '$.lineage.parentThreadId')
        FROM owners JOIN orchestration_v2_projection_threads AS thread USING (thread_id)
        WHERE json_extract(thread.payload_json, '$.lineage.relationshipToParent') = 'subagent'
      )
      SELECT 1 FROM owners
      JOIN orchestration_v2_projection_threads AS thread USING (thread_id)
      LEFT JOIN projection_projects AS project ON project.project_id = thread.project_id
      WHERE thread.deleted_at IS NOT NULL OR project.deleted_at IS NOT NULL
      LIMIT 1
    `;
    if (deleted.length > 0) return yield* new DelegationOwnerDeletedError();
  });
});
