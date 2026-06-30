import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";

import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { WorkflowEventStoreError } from "../Services/Errors.ts";
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
  const orchestration = yield* Effect.serviceOption(OrchestrationEngineService);

  const collectBoardThreads: WorkflowThreadJanitorShape["collectBoardThreads"] = (boardId) =>
    wrap(sql<{ readonly threadId: string }>`
      SELECT DISTINCT thread_id AS "threadId"
      FROM workflow_dispatch_outbox
      WHERE ticket_id IN (
        SELECT ticket_id
        FROM projection_ticket
        WHERE board_id = ${boardId}
      )
    `).pipe(Effect.map((rows) => rows.map((row) => row.threadId)));

  const collectTicketThreads: WorkflowThreadJanitorShape["collectTicketThreads"] = (ticketId) =>
    wrap(sql<{ readonly threadId: string }>`
      SELECT DISTINCT thread_id AS "threadId"
      FROM workflow_dispatch_outbox
      WHERE ticket_id = ${ticketId}
    `).pipe(Effect.map((rows) => rows.map((row) => row.threadId)));

  const deleteThreads: WorkflowThreadJanitorShape["deleteThreads"] = (threadIds) =>
    Effect.gen(function* () {
      if (Option.isNone(orchestration) || threadIds.length === 0) {
        return;
      }
      for (const threadId of threadIds) {
        // Best-effort per thread: a thread that never materialized (or was
        // already deleted) must not abort cleanup of the rest.
        yield* orchestration.value
          .dispatch({
            type: "thread.delete",
            commandId: `workflow-thread-delete-${threadId}` as never,
            threadId: threadId as never,
          })
          .pipe(Effect.catch(() => Effect.void));
      }
    });

  return {
    collectBoardThreads,
    collectTicketThreads,
    deleteThreads,
  } satisfies WorkflowThreadJanitorShape;
});

export const WorkflowThreadJanitorLive = Layer.effect(WorkflowThreadJanitor, make);
