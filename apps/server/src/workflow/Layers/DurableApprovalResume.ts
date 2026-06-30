import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";

import { ApprovalGate } from "../Services/ApprovalGate.ts";
import {
  DurableApprovalResume,
  type DurableApprovalResumeShape,
} from "../Services/DurableApprovalResume.ts";
import { WorkflowEventStoreError } from "../Services/Errors.ts";

interface PendingWaitRow {
  readonly providerRequestId: string | null;
  readonly providerThreadId: string | null;
  readonly stepRunId: string;
}

const toResumeError = (message: string) => (cause: unknown) =>
  new WorkflowEventStoreError({ message, cause });

const wrapSql = <A>(effect: Effect.Effect<A, SqlError>) =>
  effect.pipe(Effect.mapError(toResumeError("approval resume sql failed")));
const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));

const make = Effect.gen(function* () {
  const approvals = yield* ApprovalGate;
  const sql = yield* SqlClient.SqlClient;

  const resetProviderDispatch = (stepRunId: string) =>
    Effect.gen(function* () {
      const interruptedAt = yield* nowIso;
      yield* wrapSql(sql`
        UPDATE projection_turns
        SET state = 'interrupted',
            completed_at = ${interruptedAt}
        WHERE state IN ('pending', 'running')
          AND EXISTS (
            SELECT 1
            FROM workflow_dispatch_outbox AS outbox
            WHERE outbox.step_run_id = ${stepRunId}
              AND outbox.status != 'confirmed'
              AND outbox.thread_id = projection_turns.thread_id
              AND outbox.turn_id = projection_turns.turn_id
          )
      `);
      yield* wrapSql(sql`
        UPDATE workflow_dispatch_outbox
        SET status = 'pending',
            turn_id = NULL,
            started_at = NULL,
            confirmed_at = NULL
        WHERE step_run_id = ${stepRunId}
          AND status != 'confirmed'
      `);
    });

  const resume: DurableApprovalResumeShape["resume"] = () =>
    Effect.gen(function* () {
      const pendingWaits = yield* wrapSql(sql<PendingWaitRow>`
        SELECT
          json_extract(await.payload_json, '$.providerRequestId') AS "providerRequestId",
          json_extract(await.payload_json, '$.providerThreadId') AS "providerThreadId",
          json_extract(await.payload_json, '$.stepRunId') AS "stepRunId"
        FROM workflow_events AS await
        WHERE await.event_type = 'StepAwaitingUser'
          AND NOT EXISTS (
            SELECT 1
            FROM workflow_events AS resolved
            WHERE resolved.event_type = 'StepUserResolved'
              AND json_extract(resolved.payload_json, '$.stepRunId')
                = json_extract(await.payload_json, '$.stepRunId')
          )
        ORDER BY await.sequence ASC
      `);

      for (const pending of pendingWaits) {
        if (pending.providerThreadId && pending.providerRequestId) {
          yield* resetProviderDispatch(pending.stepRunId);
        } else {
          yield* approvals.park(pending.stepRunId as never);
        }
      }
    });

  return { resume } satisfies DurableApprovalResumeShape;
});

export const DurableApprovalResumeLive = Layer.effect(DurableApprovalResume, make);
