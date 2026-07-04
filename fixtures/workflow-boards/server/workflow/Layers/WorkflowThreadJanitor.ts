import { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";

import { WorkflowEventStoreError } from "../Services/Errors.ts";
import { WorkflowAgentsCapability } from "../Services/WorkflowAgentPort.ts";
import {
  WorkflowThreadJanitor,
  type WorkflowThreadJanitorShape,
} from "../Services/WorkflowThreadJanitor.ts";

const toJanitorError = (cause: unknown) =>
  new WorkflowEventStoreError({ message: "workflow thread janitor failed", cause });

const wrap = <A>(effect: Effect.Effect<A, SqlError>) =>
  effect.pipe(Effect.mapError(toJanitorError));

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const agents = yield* WorkflowAgentsCapability;

  const collectBoardThreads: WorkflowThreadJanitorShape["collectBoardThreads"] = (boardId) =>
    wrap(sql<{ readonly threadId: string }>`
      SELECT DISTINCT thread_id AS "threadId"
      FROM p_workflow_boards_dispatch_outbox
      WHERE ticket_id IN (
        SELECT ticket_id
        FROM p_workflow_boards_projection_ticket
        WHERE board_id = ${boardId}
      )
    `).pipe(Effect.map((rows) => rows.map((row) => row.threadId)));

  const collectTicketThreads: WorkflowThreadJanitorShape["collectTicketThreads"] = (ticketId) =>
    wrap(sql<{ readonly threadId: string }>`
      SELECT DISTINCT thread_id AS "threadId"
      FROM p_workflow_boards_dispatch_outbox
      WHERE ticket_id = ${ticketId}
    `).pipe(Effect.map((rows) => rows.map((row) => row.threadId)));

  const deleteThreads: WorkflowThreadJanitorShape["deleteThreads"] = (threadIds) =>
    Effect.gen(function* () {
      if (threadIds.length === 0) {
        return;
      }
      for (const threadId of threadIds) {
        yield* agents.deleteThread({ threadId: ThreadId.make(threadId) }).pipe(
          Effect.mapError(toJanitorError),
          Effect.catch(() => Effect.void),
        );
      }
    });

  return {
    collectBoardThreads,
    collectTicketThreads,
    deleteThreads,
  } satisfies WorkflowThreadJanitorShape;
});

export const WorkflowThreadJanitorLive = Layer.effect(WorkflowThreadJanitor, make);
