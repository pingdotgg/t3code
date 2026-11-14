import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";

const timestamp = (value: string | null) =>
  value === null ? undefined : Option.getOrUndefined(DateTime.make(value));

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // Manual settles have the same shape; only the affected builds' dense sweeps qualify.
  const settlements = yield* sql<{ readonly thread_id: string; readonly occurred_at: string }>`
    WITH
    legacy_settlements AS (
      SELECT
        stream_id AS thread_id,
        occurred_at,
        unixepoch(occurred_at, 'subsec') AS occurred_seconds
      FROM orchestration_events
      WHERE aggregate_kind = 'thread'
        AND event_type = 'thread.settled'
        AND actor_kind = 'client'
        AND application_event_version = 1
        AND json_type(payload_json, '$.settledAt') = 'text'
        AND json_extract(payload_json, '$.settledAt') = occurred_at
        AND json_extract(metadata_json, '$.origin.appVersion') IN ('0.0.35', '0.0.36', '0.0.37', '0.0.38')
        AND julianday(occurred_at) < julianday('2026-09-05T00:00:00.000Z')
    ),
    ordered AS (
      SELECT
        thread_id,
        occurred_at,
        occurred_seconds,
        occurred_seconds - LAG(occurred_seconds) OVER (ORDER BY occurred_seconds, thread_id)
          AS gap_seconds
      FROM legacy_settlements
    ),
    clustered AS (
      SELECT
        thread_id,
        occurred_at,
        occurred_seconds,
        SUM(CASE WHEN gap_seconds IS NULL OR gap_seconds > 30 THEN 1 ELSE 0 END)
          OVER (ORDER BY occurred_seconds, thread_id) AS cluster_id
      FROM ordered
    ),
    burst_clusters AS (
      SELECT
        cluster_id,
        COUNT(DISTINCT thread_id) AS distinct_thread_count,
        MAX(occurred_seconds) - MIN(occurred_seconds) AS span_seconds
      FROM clustered
      GROUP BY cluster_id
    ),
    automatic_settlements AS (
      SELECT clustered.thread_id, clustered.occurred_at
      FROM clustered
      JOIN burst_clusters ON burst_clusters.cluster_id = clustered.cluster_id
      WHERE burst_clusters.distinct_thread_count >= 10
        AND burst_clusters.span_seconds <= 120
    )
    SELECT DISTINCT thread_id, occurred_at FROM automatic_settlements
    ORDER BY thread_id, occurred_at
  `;
  const byThread = Map.groupBy(settlements, (settlement) => settlement.thread_id);

  for (const [threadId, sweeps] of byThread) {
    const repairs = sweeps.map((sweep) => ({
      occurredAt: sweep.occurred_at,
      cutoff: DateTime.toEpochMillis(DateTime.makeUnsafe(sweep.occurred_at)),
      activityAt: null as string | null,
      activityTime: -Infinity,
    }));
    const recordActivity = (value: string | null) => {
      const date = timestamp(value);
      if (date === undefined) return;
      const time = DateTime.toEpochMillis(date);
      for (const repair of repairs) {
        if (time <= repair.cutoff && time > repair.activityTime) {
          repair.activityAt = value;
          repair.activityTime = time;
        }
      }
    };

    for (const repair of repairs) {
      const messages = yield* sql<{ readonly created_at: string }>`
        SELECT created_at FROM projection_thread_messages
        WHERE thread_id = ${threadId} AND role = 'user'
          AND julianday(created_at) <= julianday(${repair.occurredAt})
        ORDER BY julianday(created_at) DESC LIMIT 1
      `;
      recordActivity(messages[0]?.created_at ?? null);
    }

    // 063 dropped projection_turns. Track open turns from retained V1 events so an
    // idle session stopping cannot masquerade as a turn finishing.
    const turns = new Map<
      string,
      { state: "running" | "completed" | "interrupted" | "error"; checkpoint: number | null }
    >();
    const runningTurnIds = new Set<string>();
    let activeTurnId: string | null = null;
    let afterSequence = 0;
    const pageSize = 500;
    while (true) {
      const events = yield* sql<{
        readonly sequence: number;
        readonly event_type: string;
        readonly occurred_at: string;
        readonly turn_id: string | null;
        readonly created_at: string | null;
        readonly updated_at: string | null;
        readonly completed_at: string | null;
        readonly role: string | null;
        readonly streaming: number | null;
        readonly status: string | null;
        readonly session_turn_id: string | null;
        readonly session_updated_at: string | null;
        readonly checkpoint: number | null;
        readonly turn_count: number | null;
      }>`
        SELECT sequence, event_type, occurred_at,
          json_extract(payload_json, '$.turnId') AS turn_id,
          json_extract(payload_json, '$.createdAt') AS created_at,
          json_extract(payload_json, '$.updatedAt') AS updated_at,
          json_extract(payload_json, '$.completedAt') AS completed_at,
          json_extract(payload_json, '$.role') AS role,
          json_extract(payload_json, '$.streaming') AS streaming,
          json_extract(payload_json, '$.session.status') AS status,
          json_extract(payload_json, '$.session.activeTurnId') AS session_turn_id,
          json_extract(payload_json, '$.session.updatedAt') AS session_updated_at,
          json_extract(payload_json, '$.checkpointTurnCount') AS checkpoint,
          json_extract(payload_json, '$.turnCount') AS turn_count
        FROM orchestration_events INDEXED BY idx_orch_events_stream_sequence
        WHERE aggregate_kind = 'thread' AND stream_id = ${threadId}
          AND application_event_version = 1 AND sequence > ${afterSequence}
          AND event_type IN (
            'thread.created', 'thread.turn-start-requested', 'thread.session-set',
            'thread.message-sent', 'thread.turn-interrupt-requested',
            'thread.turn-diff-completed', 'thread.reverted'
          )
        ORDER BY sequence LIMIT ${pageSize}
      `;
      for (const event of events) {
        const turn = event.turn_id === null ? undefined : turns.get(event.turn_id);
        switch (event.event_type) {
          case "thread.created":
            turns.clear();
            runningTurnIds.clear();
            activeTurnId = null;
            break;
          case "thread.turn-start-requested":
            recordActivity(event.created_at);
            break;
          case "thread.session-set": {
            activeTurnId = event.status === "running" ? event.session_turn_id : null;
            const endedAt = timestamp(event.session_updated_at)
              ? event.session_updated_at
              : event.occurred_at;
            if (activeTurnId !== null) {
              for (const id of runningTurnIds) {
                if (id !== activeTurnId) {
                  turns.get(id)!.state = "completed";
                  runningTurnIds.delete(id);
                  recordActivity(endedAt);
                }
              }
              const active = turns.get(activeTurnId);
              if (active === undefined) {
                turns.set(activeTurnId, { state: "running", checkpoint: null });
                runningTurnIds.add(activeTurnId);
                recordActivity(event.occurred_at);
              } else if (active.state === "interrupted") {
                active.state = "running";
                runningTurnIds.add(activeTurnId);
              }
            } else if (
              event.status === "idle" ||
              event.status === "ready" ||
              event.status === "error" ||
              event.status === "interrupted" ||
              event.status === "stopped"
            ) {
              for (const id of runningTurnIds) {
                const running = turns.get(id)!;
                running.state =
                  event.status === "error"
                    ? "error"
                    : event.status === "interrupted" || event.status === "stopped"
                      ? "interrupted"
                      : "completed";
                recordActivity(endedAt);
              }
              runningTurnIds.clear();
            }
            break;
          }
          case "thread.message-sent":
            if (event.role !== "assistant" || event.turn_id === null) break;
            recordActivity(event.created_at);
            if (event.streaming === 0 && activeTurnId !== event.turn_id) {
              if (turn === undefined || turn.state === "running") recordActivity(event.updated_at);
              if (turn === undefined) {
                turns.set(event.turn_id, { state: "completed", checkpoint: null });
              } else if (turn.state === "running") {
                turn.state = "completed";
              }
              runningTurnIds.delete(event.turn_id);
            } else if (turn === undefined) {
              turns.set(event.turn_id, { state: "running", checkpoint: null });
              runningTurnIds.add(event.turn_id);
            }
            break;
          case "thread.turn-interrupt-requested":
            if (event.turn_id === null) break;
            recordActivity(event.created_at);
            turns.set(event.turn_id, {
              state: "interrupted",
              checkpoint: turn?.checkpoint ?? null,
            });
            runningTurnIds.delete(event.turn_id);
            break;
          case "thread.turn-diff-completed":
            if (event.turn_id === null) break;
            recordActivity(event.completed_at);
            turns.set(event.turn_id, {
              state:
                activeTurnId === event.turn_id
                  ? (turn?.state ?? "running")
                  : turn?.state === "interrupted"
                    ? "interrupted"
                    : "completed",
              checkpoint: event.checkpoint,
            });
            if (turns.get(event.turn_id)!.state === "running") {
              runningTurnIds.add(event.turn_id);
            } else {
              runningTurnIds.delete(event.turn_id);
            }
            break;
          case "thread.reverted":
            for (const [id, previous] of turns) {
              if (previous.checkpoint === null || previous.checkpoint > (event.turn_count ?? 0)) {
                turns.delete(id);
                runningTurnIds.delete(id);
              }
            }
            break;
        }
      }
      if (events.length < pageSize) break;
      afterSequence = events.at(-1)!.sequence;
    }

    for (const repair of repairs) {
      yield* sql`
        UPDATE projection_threads
        SET settled_at = COALESCE(${repair.activityAt}, created_at)
        WHERE thread_id = ${threadId} AND settled_override = 'settled'
          AND settled_at = ${repair.occurredAt}
      `;
      yield* sql`
        UPDATE orchestration_v2_projection_threads
        SET payload_json = json_set(payload_json, '$.settledAt',
          COALESCE(${repair.activityAt}, json_extract(payload_json, '$.createdAt')))
        WHERE thread_id = ${threadId}
          AND json_extract(payload_json, '$.settledOverride') = 'settled'
          AND json_extract(payload_json, '$.settledAt') = ${repair.occurredAt}
      `;
      // V2 snapshots must retain the repair after a rebuild; V1 history stays immutable.
      yield* sql`
        UPDATE orchestration_events
        SET payload_json = json_set(payload_json, '$.settledAt',
          COALESCE(${repair.activityAt}, json_extract(payload_json, '$.createdAt'),
            json_extract(payload_json, '$.settledAt')))
        WHERE aggregate_kind = 'thread' AND stream_id = ${threadId}
          AND application_event_version = 2
          AND json_extract(payload_json, '$.settledOverride') = 'settled'
          AND json_extract(payload_json, '$.settledAt') = ${repair.occurredAt}
      `;
    }
  }
});
