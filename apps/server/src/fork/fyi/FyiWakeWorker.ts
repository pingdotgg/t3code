import {
  ProjectId,
  ProviderInstanceId,
  resolveProjectProviderInstanceEnabled,
  type ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import * as ThreadManagement from "../../orchestration-v2/ThreadManagementService.ts";
import * as DueHint from "../../scheduling/DueHint.ts";
import * as Scheduler from "../../scheduling/Scheduler.ts";
import * as ServerSettings from "../../serverSettings.ts";
import { decideWake, ENDED_RUN_STATUSES, FYI_WAITING_SQL, wakeCommand } from "./Fyi.ts";

/**
 * Keeps the reads of FYI items off the rest of the turn items. Building it is one pass over the
 * turn items, so it runs at startup like a migration; a failed build delays wakes, not the server.
 */
const createFyiItemIndex = (sql: SqlClient.SqlClient) =>
  sql`CREATE INDEX IF NOT EXISTS fork_fyi_turn_items_idx
    ON orchestration_v2_projection_turn_items(thread_id, ordinal)
    WHERE type = 'user_message' AND json_extract(payload_json, '$.fyi') = 1`.pipe(
    Effect.as(true),
    Effect.catchCause((cause) =>
      Effect.logWarning("fork.fyi.index-failed", { cause }).pipe(Effect.as(false)),
    ),
  );

interface WakeCandidate {
  readonly thread_id: ThreadId;
  readonly project_id: string;
  readonly instance_id: string;
  readonly created_at: string;
  readonly snoozed_until: string | null;
  readonly last_activity: string | null;
  readonly limit_reset_at: string | null;
}

/**
 * Idle threads with a waiting FYI that a wake may reach: not archived, deleted or settled, with no
 * run that has not ended and no pending runtime request. It returns raw instants and `decideWake`
 * alone compares them. `last_activity` mirrors `wakeRuns` in Fyi.ts; the `latest` run and its root
 * error mirror the orchestrator's wake gate.
 */
const readCandidates = (sql: SqlClient.SqlClient) =>
  sql<WakeCandidate>`
    SELECT t.thread_id, t.project_id, t.created_at,
      json_extract(t.payload_json, '$.modelSelection.instanceId') AS instance_id,
      json_extract(t.payload_json, '$.snoozedUntil') AS snoozed_until,
      (
        SELECT MAX(COALESCE(
          run.completed_at, json_extract(run.payload_json, '$.startedAt'), run.requested_at
        ))
        FROM orchestration_v2_projection_runs run
        WHERE run.thread_id = t.thread_id
      ) AS last_activity,
      CASE WHEN json_extract(failure.payload_json, '$.failure.class') = 'usage_limit'
        THEN json_extract(failure.payload_json, '$.failure.resetAt')
      END AS limit_reset_at
    FROM (
      SELECT item.thread_id
      FROM orchestration_v2_projection_turn_items item
      LEFT JOIN orchestration_v2_projection_runs run ON run.run_id = item.run_id
      WHERE ${sql.literal(FYI_WAITING_SQL)}
      GROUP BY item.thread_id
    ) waiting
    JOIN orchestration_v2_projection_threads t ON t.thread_id = waiting.thread_id
    LEFT JOIN orchestration_v2_projection_runs latest ON latest.run_id = (
      SELECT executed.run_id FROM orchestration_v2_projection_runs executed
      WHERE executed.thread_id = t.thread_id
        AND executed.status <> 'queued'
        AND NOT (
          executed.status = 'cancelled'
          AND json_extract(executed.payload_json, '$.startedAt') IS NULL
        )
      -- latestExecutedRun: the run that ended last (runRanAfter).
      ORDER BY executed.completed_at IS NULL DESC, executed.completed_at DESC,
        executed.ordinal DESC, executed.run_id DESC
      LIMIT 1
    )
    -- latestRootProviderFailure of that run, which is null unless it failed, and only while the
    -- thread still uses that run's provider instance.
    LEFT JOIN orchestration_v2_projection_turn_items failure
      ON latest.status = 'failed'
      AND latest.provider_instance_id = t.provider_instance_id
      AND failure.turn_item_id = (
        SELECT error.turn_item_id FROM orchestration_v2_projection_turn_items error
        WHERE error.thread_id = t.thread_id AND error.run_id = latest.run_id
          AND error.type = 'error' AND error.status = 'failed'
          AND error.node_id IS json_extract(latest.payload_json, '$.rootNodeId')
        ORDER BY error.updated_at DESC, error.ordinal DESC, error.turn_item_id DESC
        LIMIT 1
      )
    WHERE t.deleted_at IS NULL
      AND json_extract(t.payload_json, '$.archivedAt') IS NULL
      AND json_extract(t.payload_json, '$.settledOverride') IS NOT 'settled'
      AND NOT EXISTS (
        SELECT 1 FROM orchestration_v2_projection_runs busy
        WHERE busy.thread_id = t.thread_id
          AND busy.status NOT IN ${sql.in(ENDED_RUN_STATUSES)}
      )
      AND NOT EXISTS (
        SELECT 1 FROM orchestration_v2_projection_runtime_requests request
        WHERE request.thread_id = t.thread_id AND request.status = 'pending'
      )`;

const utc = (iso: string | null) => (iso === null ? undefined : DateTime.makeUnsafe(iso));

const makeSweep = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const settings = yield* ServerSettings.ServerSettingsService;
  let indexed = yield* createFyiItemIndex(sql);
  // No event invalidates it: a 6-hour wake may run up to the hint's maximum age late.
  const due = DueHint.make();
  return Effect.fn("FyiWakeWorker.sweep")(function* () {
    const now = yield* DateTime.now;
    const nowMs = DateTime.toEpochMillis(now);
    if (yield* due.isIdle(nowMs)) return;
    // Without the index the candidate read scans every turn item, so it waits for the build.
    if (!indexed) indexed = yield* createFyiItemIndex(sql);
    if (!indexed) return;
    const readVersion = yield* due.version;
    const preferences = yield* settings.getSettings;
    let nextDueMs = Infinity;
    for (const candidate of yield* readCandidates(sql)) {
      const decision = decideWake({
        thread: {
          archivedAt: null,
          deletedAt: null,
          settledOverride: null,
          createdAt: DateTime.makeUnsafe(candidate.created_at),
          snoozedUntil: utc(candidate.snoozed_until) ?? null,
        },
        fyiWaiting: true,
        runs: { busy: undefined, lastActivity: utc(candidate.last_activity) },
        limitResetAt: utc(candidate.limit_reset_at),
        pendingRequest: false,
        providerEnabled: resolveProjectProviderInstanceEnabled(
          preferences,
          ProjectId.make(candidate.project_id),
          ProviderInstanceId.make(candidate.instance_id),
        ),
        now,
      });
      if (!decision.due) {
        if (decision.reason === "not_yet")
          nextDueMs = Math.min(nextDueMs, DateTime.toEpochMillis(decision.dueAt));
        continue;
      }
      // A woken thread is busy at the next sweep. A wake refused before it made a run leaves no
      // receipt, so it is sent again once the hint ages out.
      yield* threads
        .dispatch(wakeCommand(candidate.thread_id, decision.idleFrom))
        .pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("fork.fyi.wake-failed", { threadId: candidate.thread_id, cause }),
          ),
        );
    }
    yield* due.record(readVersion, nextDueMs, nowMs);
  });
});

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const sweep = yield* makeSweep;
    const scheduler = yield* Scheduler.Scheduler;
    yield* scheduler.register("fyi-wake", sweep());
  }),
);
