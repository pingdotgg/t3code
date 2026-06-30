import type { BoardId, LaneKey, TicketId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";

import { WorkflowEventStoreError } from "../Services/Errors.ts";
import {
  WorkflowAgentSessionStore,
  type WorkflowAgentSessionRow,
  type WorkflowAgentSessionStoreShape,
} from "../Services/WorkflowAgentSessionStore.ts";

const toStoreError = (message: string) => (cause: unknown) =>
  new WorkflowEventStoreError({ message, cause });

const wrap = <A>(message: string, effect: Effect.Effect<A, SqlError>) =>
  effect.pipe(Effect.mapError(toStoreError(message)));

interface RawRow {
  readonly ticketId: string;
  readonly laneKey: string;
  readonly agentKey: string;
  readonly threadId: string;
  readonly createdAt: string;
  readonly lastUsedAt: string;
}

const decodeRow = (row: RawRow): WorkflowAgentSessionRow => ({
  ticketId: row.ticketId as TicketId,
  laneKey: row.laneKey as LaneKey,
  agentKey: row.agentKey,
  threadId: row.threadId,
  createdAt: row.createdAt,
  lastUsedAt: row.lastUsedAt,
});

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const upsert: WorkflowAgentSessionStoreShape["upsert"] = (
    ticketId,
    laneKey,
    agentKey,
    threadId,
  ) =>
    Effect.gen(function* () {
      const now = DateTime.formatIso(yield* DateTime.now);
      yield* wrap(
        "WorkflowAgentSessionStore.upsert",
        sql`
          INSERT INTO workflow_agent_session
            (ticket_id, lane_key, agent_key, thread_id, created_at, last_used_at)
          VALUES
            (${String(ticketId)}, ${String(laneKey)}, ${agentKey}, ${threadId}, ${now}, ${now})
          ON CONFLICT (ticket_id, lane_key, agent_key)
          DO UPDATE SET last_used_at = ${now}
        `,
      );
    });

  const getThreadId: WorkflowAgentSessionStoreShape["getThreadId"] = (
    ticketId,
    laneKey,
    agentKey,
  ) =>
    wrap(
      "WorkflowAgentSessionStore.getThreadId",
      sql<{ readonly threadId: string }>`
        SELECT thread_id AS "threadId"
        FROM workflow_agent_session
        WHERE ticket_id = ${String(ticketId)}
          AND lane_key = ${String(laneKey)}
          AND agent_key = ${agentKey}
        LIMIT 1
      `,
    ).pipe(Effect.map((rows) => rows[0]?.threadId ?? null));

  const listByTicket: WorkflowAgentSessionStoreShape["listByTicket"] = (ticketId) =>
    wrap(
      "WorkflowAgentSessionStore.listByTicket",
      sql<RawRow>`
        SELECT
          ticket_id    AS "ticketId",
          lane_key     AS "laneKey",
          agent_key    AS "agentKey",
          thread_id    AS "threadId",
          created_at   AS "createdAt",
          last_used_at AS "lastUsedAt"
        FROM workflow_agent_session
        WHERE ticket_id = ${String(ticketId)}
      `,
    ).pipe(Effect.map((rows) => rows.map(decodeRow)));

  const deleteByTicket: WorkflowAgentSessionStoreShape["deleteByTicket"] = (ticketId) =>
    wrap(
      "WorkflowAgentSessionStore.deleteByTicket",
      sql`
        DELETE FROM workflow_agent_session
        WHERE ticket_id = ${String(ticketId)}
      `,
    ).pipe(Effect.asVoid);

  const listByBoard: WorkflowAgentSessionStoreShape["listByBoard"] = (boardId) =>
    wrap(
      "WorkflowAgentSessionStore.listByBoard",
      sql<RawRow>`
        SELECT
          s.ticket_id    AS "ticketId",
          s.lane_key     AS "laneKey",
          s.agent_key    AS "agentKey",
          s.thread_id    AS "threadId",
          s.created_at   AS "createdAt",
          s.last_used_at AS "lastUsedAt"
        FROM workflow_agent_session AS s
        JOIN projection_ticket AS t ON t.ticket_id = s.ticket_id
        WHERE t.board_id = ${String(boardId)}
      `,
    ).pipe(Effect.map((rows) => rows.map(decodeRow)));

  const deleteByBoard: WorkflowAgentSessionStoreShape["deleteByBoard"] = (boardId) =>
    wrap(
      "WorkflowAgentSessionStore.deleteByBoard",
      sql`
        DELETE FROM workflow_agent_session
        WHERE ticket_id IN (
          SELECT ticket_id FROM projection_ticket WHERE board_id = ${String(boardId)}
        )
      `,
    ).pipe(Effect.asVoid);

  return {
    upsert,
    getThreadId,
    listByTicket,
    deleteByTicket,
    listByBoard,
    deleteByBoard,
  } satisfies WorkflowAgentSessionStoreShape;
});

export const WorkflowAgentSessionStoreLive = Layer.effect(WorkflowAgentSessionStore, make);
