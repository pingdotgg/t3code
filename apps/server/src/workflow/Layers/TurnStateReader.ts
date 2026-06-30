import { ApprovalRequestId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { ProjectionTurnRepository } from "../../persistence/Services/ProjectionTurns.ts";
import {
  TurnProjectionPort,
  TurnStateReader,
  type TurnProjectionPortShape,
  type TurnState,
  type TurnStateReaderShape,
} from "../Services/TurnStateReader.ts";

interface PendingProviderRequestRow {
  readonly requestId: string;
}

interface PendingUserInputRow {
  readonly requestId: string;
  readonly prompt: string | null;
  readonly questionId: string | null;
}

const toTurnState = (state: string): TurnState => {
  if (state === "completed") {
    return { _tag: "completed" };
  }
  if (state === "error" || state === "interrupted") {
    return { _tag: "failed", error: state };
  }
  return { _tag: "running" };
};

const make = Effect.gen(function* () {
  const port = yield* TurnProjectionPort;
  const sql = yield* SqlClient.SqlClient;

  const pendingProviderRequest = (threadId: ThreadId) =>
    sql<PendingProviderRequestRow>`
      SELECT request_id AS "requestId"
      FROM projection_pending_approvals
      WHERE thread_id = ${threadId}
        AND status = 'pending'
      ORDER BY created_at ASC
      LIMIT 1
    `.pipe(
      Effect.map((rows) => rows[0] ?? null),
      Effect.orElseSucceed(() => null),
    );

  const pendingUserInputRequest = (threadId: ThreadId) =>
    sql<PendingUserInputRow>`
      WITH latest_user_input_states AS (
        SELECT
          latest.request_id AS "requestId",
          latest.question_id AS "questionId",
          latest.prompt,
          latest.kind,
          latest.detail
        FROM (
          SELECT
            json_extract(activity.payload_json, '$.requestId') AS request_id,
            json_extract(activity.payload_json, '$.questions[0].id') AS question_id,
            json_extract(activity.payload_json, '$.questions[0].question') AS prompt,
            activity.kind,
            lower(COALESCE(json_extract(activity.payload_json, '$.detail'), '')) AS detail,
            ROW_NUMBER() OVER (
              PARTITION BY json_extract(activity.payload_json, '$.requestId')
              ORDER BY activity.created_at DESC, activity.activity_id DESC
            ) AS row_number
          FROM projection_thread_activities AS activity
          WHERE activity.thread_id = ${threadId}
            AND json_extract(activity.payload_json, '$.requestId') IS NOT NULL
            AND activity.kind IN (
              'user-input.requested',
              'user-input.resolved',
              'provider.user-input.respond.failed'
            )
        ) AS latest
        WHERE latest.row_number = 1
      )
      SELECT "requestId"
        , "questionId"
        , prompt
      FROM latest_user_input_states
      WHERE kind = 'user-input.requested'
        OR (
          kind = 'provider.user-input.respond.failed'
          AND detail NOT LIKE '%stale pending user-input request%'
          AND detail NOT LIKE '%unknown pending user-input request%'
          AND detail NOT LIKE '%unknown pending user input request%'
          AND detail NOT LIKE '%unknown pending codex user input request%'
        )
      ORDER BY "requestId" ASC
      LIMIT 1
    `.pipe(
      Effect.map((rows) => rows[0] ?? null),
      Effect.orElseSucceed(() => null),
    );

  const read: TurnStateReaderShape["read"] = (threadId) =>
    Effect.gen(function* () {
      const { state } = yield* port.getLatestTurnState(threadId);
      const turnState = toTurnState(state);
      if (turnState._tag !== "running") {
        return turnState;
      }

      const pending = yield* pendingProviderRequest(threadId);
      if (pending) {
        return {
          _tag: "awaiting_user",
          waitingReason: "Provider is waiting for user input",
          providerThreadId: threadId,
          providerRequestId: ApprovalRequestId.make(pending.requestId),
          providerResponseKind: "request",
        } satisfies TurnState;
      }
      const pendingUserInput = yield* pendingUserInputRequest(threadId);
      if (pendingUserInput) {
        return {
          _tag: "awaiting_user",
          waitingReason: pendingUserInput.prompt ?? "Provider is waiting for user input",
          providerThreadId: threadId,
          providerRequestId: ApprovalRequestId.make(pendingUserInput.requestId),
          providerResponseKind: "user-input",
          ...(pendingUserInput.questionId === null
            ? {}
            : { providerQuestionId: pendingUserInput.questionId }),
        } satisfies TurnState;
      }
      return turnState;
    });

  return { read } satisfies TurnStateReaderShape;
});

export const TurnStateReaderLive = Layer.effect(TurnStateReader, make);

export const TurnProjectionPortLive = Layer.effect(
  TurnProjectionPort,
  Effect.gen(function* () {
    const turns = yield* ProjectionTurnRepository;

    const getLatestTurnState: TurnProjectionPortShape["getLatestTurnState"] = (threadId) =>
      turns.listByThreadId({ threadId }).pipe(
        Effect.map((rows) => rows.at(-1)),
        Effect.map((turn) => ({
          state: turn?.state ?? "pending",
          // Mirrors toTurnState: interrupted turns are terminal too.
          completed:
            turn?.state === "completed" || turn?.state === "error" || turn?.state === "interrupted",
        })),
        Effect.orElseSucceed(() => ({ state: "pending", completed: false })),
      );

    return { getLatestTurnState } satisfies TurnProjectionPortShape;
  }),
);
