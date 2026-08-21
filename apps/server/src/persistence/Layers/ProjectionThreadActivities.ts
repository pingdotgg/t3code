import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import { EventId, NonNegativeInt, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";

import { toPersistenceDecodeError, toPersistenceSqlError } from "../Errors.ts";

import {
  DeleteProjectionThreadActivitiesInput,
  ListProjectionThreadActivitiesInput,
  ProjectionThreadActivity,
  ProjectionThreadActivityRepository,
  type ProjectionThreadActivityRepositoryShape,
} from "../Services/ProjectionThreadActivities.ts";

const ProjectionThreadActivityDbRowSchema = ProjectionThreadActivity.mapFields(
  Struct.assign({
    payload: Schema.fromJsonString(Schema.Unknown),
    sequence: Schema.NullOr(NonNegativeInt),
  }),
);
type ProjectionThreadActivityDbRow = typeof ProjectionThreadActivityDbRowSchema.Type;

const fromDbRow = (row: ProjectionThreadActivityDbRow): ProjectionThreadActivity => ({
  activityId: row.activityId,
  threadId: row.threadId,
  turnId: row.turnId,
  tone: row.tone,
  kind: row.kind,
  summary: row.summary,
  payload: row.payload,
  ...(row.sequence !== null ? { sequence: row.sequence } : {}),
  createdAt: row.createdAt,
});

const PendingUserInputCountRowSchema = Schema.Struct({
  count: NonNegativeInt,
});

const ExistingUserInputActivityRowSchema = Schema.Struct({
  threadId: ThreadId,
  requestId: Schema.NullOr(Schema.String),
});

const UserInputActivityKeySchema = Schema.Struct({
  threadId: ThreadId,
  requestId: Schema.String,
});
type UserInputActivityKey = typeof UserInputActivityKeySchema.Type;

const UserInputStateRowSchema = Schema.Struct({
  state: Schema.Literals(["pending", "cleared"]),
});
type UserInputState = typeof UserInputStateRowSchema.Type.state;

function userInputStateFromActivity(activity: {
  readonly kind: string;
  readonly payload: unknown;
}): { readonly requestId: string; readonly state: UserInputState } | null {
  if (typeof activity.payload !== "object" || activity.payload === null) {
    return null;
  }
  const payload = activity.payload as Record<string, unknown>;
  if (typeof payload.requestId !== "string") {
    return null;
  }
  if (activity.kind === "user-input.requested") {
    return { requestId: payload.requestId, state: "pending" };
  }
  if (activity.kind === "user-input.resolved") {
    return { requestId: payload.requestId, state: "cleared" };
  }
  if (activity.kind !== "provider.user-input.respond.failed") {
    return null;
  }
  const detail = typeof payload.detail === "string" ? payload.detail.toLowerCase() : "";
  if (
    !detail.includes("stale pending user-input request") &&
    !detail.includes("unknown pending user-input request") &&
    !detail.includes("unknown pending user input request") &&
    !detail.includes("unknown pending codex user input request")
  ) {
    return null;
  }
  return { requestId: payload.requestId, state: "cleared" };
}

function userInputKeyId(key: UserInputActivityKey): string {
  return `${key.threadId.length}:${key.threadId}${key.requestId}`;
}

function toPersistenceSqlOrDecodeError(sqlOperation: string, decodeOperation: string) {
  return (cause: unknown) =>
    Schema.isSchemaError(cause)
      ? toPersistenceDecodeError(decodeOperation)(cause)
      : toPersistenceSqlError(sqlOperation)(cause);
}

const makeProjectionThreadActivityRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const getExistingUserInputActivity = SqlSchema.findOneOption({
    Request: Schema.Struct({ activityId: EventId }),
    Result: ExistingUserInputActivityRowSchema,
    execute: ({ activityId }) =>
      sql`
        SELECT
          thread_id AS "threadId",
          user_input_request_id AS "requestId"
        FROM projection_thread_activities
        WHERE activity_id = ${activityId}
          AND user_input_state IS NOT NULL
        LIMIT 1
      `,
  });

  const getLatestUserInputState = SqlSchema.findOneOption({
    Request: UserInputActivityKeySchema,
    Result: UserInputStateRowSchema,
    execute: ({ threadId, requestId }) =>
      sql`
        SELECT user_input_state AS "state"
        FROM projection_thread_activities
        WHERE thread_id = ${threadId}
          AND user_input_request_id = ${requestId}
          AND user_input_state IS NOT NULL
        ORDER BY created_at DESC, activity_id DESC
        LIMIT 1
      `,
  });

  const upsertProjectionThreadActivityRow = SqlSchema.void({
    Request: ProjectionThreadActivity,
    execute: (row) => {
      const userInputState = userInputStateFromActivity(row);
      return sql`
            INSERT INTO projection_thread_activities (
              activity_id,
              thread_id,
              turn_id,
              tone,
              kind,
              summary,
              payload_json,
              sequence,
              created_at,
              user_input_request_id,
              user_input_state
            )
            VALUES (
              ${row.activityId},
              ${row.threadId},
              ${row.turnId},
              ${row.tone},
              ${row.kind},
              ${row.summary},
              ${JSON.stringify(row.payload)},
              ${row.sequence ?? null},
              ${row.createdAt},
              ${userInputState?.requestId ?? null},
              ${userInputState?.state ?? null}
            )
            ON CONFLICT (activity_id)
            DO UPDATE SET
              thread_id = excluded.thread_id,
              turn_id = excluded.turn_id,
              tone = excluded.tone,
              kind = excluded.kind,
              summary = excluded.summary,
              payload_json = excluded.payload_json,
              sequence = excluded.sequence,
              created_at = excluded.created_at,
              user_input_request_id = excluded.user_input_request_id,
              user_input_state = excluded.user_input_state
          `;
    },
  });

  const listProjectionThreadActivityRows = SqlSchema.findAll({
    Request: ListProjectionThreadActivitiesInput,
    Result: ProjectionThreadActivityDbRowSchema,
    execute: ({ threadId }) =>
      sql`
        SELECT
          activity_id AS "activityId",
          thread_id AS "threadId",
          turn_id AS "turnId",
          tone,
          kind,
          summary,
          payload_json AS "payload",
          sequence,
          created_at AS "createdAt"
        FROM projection_thread_activities
        WHERE thread_id = ${threadId}
        ORDER BY
          CASE WHEN sequence IS NULL THEN 0 ELSE 1 END ASC,
          sequence ASC,
          created_at ASC,
          activity_id ASC
      `,
  });

  const readPendingUserInputCount = SqlSchema.findOneOption({
    Request: ListProjectionThreadActivitiesInput,
    Result: PendingUserInputCountRowSchema,
    execute: ({ threadId }) =>
      sql`
        SELECT pending_count AS "count"
        FROM projection_thread_user_input_summaries
        WHERE thread_id = ${threadId}
        LIMIT 1
      `,
  });

  const rebuildPendingUserInputCount = SqlSchema.findOne({
    Request: ListProjectionThreadActivitiesInput,
    Result: PendingUserInputCountRowSchema,
    execute: ({ threadId }) =>
      sql`
        WITH ranked AS (
          SELECT
            user_input_state,
            ROW_NUMBER() OVER (
              PARTITION BY user_input_request_id
              ORDER BY created_at DESC, activity_id DESC
            ) AS row_number
          FROM projection_thread_activities
          WHERE thread_id = ${threadId}
            AND user_input_request_id IS NOT NULL
            AND user_input_state IS NOT NULL
        )
        SELECT COUNT(*) AS "count"
        FROM ranked
        WHERE row_number = 1
          AND user_input_state = 'pending'
      `,
  });

  const getOrRebuildPendingUserInputCount = Effect.fn(
    "ProjectionThreadActivityRepository.getOrRebuildPendingUserInputCount",
  )(function* (input: ListProjectionThreadActivitiesInput) {
    const existing = yield* readPendingUserInputCount(input);
    if (Option.isSome(existing)) {
      return existing.value.count;
    }

    const rebuilt = yield* rebuildPendingUserInputCount(input);
    yield* sql`
      INSERT INTO projection_thread_user_input_summaries (thread_id, pending_count)
      VALUES (${input.threadId}, ${rebuilt.count})
      ON CONFLICT (thread_id)
      DO UPDATE SET pending_count = excluded.pending_count
    `;
    return rebuilt.count;
  });

  const deleteProjectionThreadActivityRows = SqlSchema.void({
    Request: DeleteProjectionThreadActivitiesInput,
    execute: ({ threadId }) =>
      sql`
        DELETE FROM projection_thread_activities
        WHERE thread_id = ${threadId}
      `,
  });

  const resetPendingUserInputSummary = SqlSchema.void({
    Request: DeleteProjectionThreadActivitiesInput,
    execute: ({ threadId }) =>
      sql`
        INSERT INTO projection_thread_user_input_summaries (thread_id, pending_count)
        VALUES (${threadId}, 0)
        ON CONFLICT (thread_id)
        DO UPDATE SET pending_count = 0
      `,
  });

  const upsert: ProjectionThreadActivityRepositoryShape["upsert"] = (row) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          yield* getOrRebuildPendingUserInputCount({ threadId: row.threadId });
          const previous = yield* getExistingUserInputActivity({ activityId: row.activityId });
          if (Option.isSome(previous) && previous.value.threadId !== row.threadId) {
            yield* getOrRebuildPendingUserInputCount({ threadId: previous.value.threadId });
          }
          const next = userInputStateFromActivity(row);
          const keys = new Map<string, UserInputActivityKey>();
          if (Option.isSome(previous) && previous.value.requestId !== null) {
            const key = {
              threadId: previous.value.threadId,
              requestId: previous.value.requestId,
            };
            keys.set(userInputKeyId(key), key);
          }
          if (next !== null) {
            const key = { threadId: row.threadId, requestId: next.requestId };
            keys.set(userInputKeyId(key), key);
          }

          const before = new Map<string, boolean>();
          for (const [keyId, key] of keys) {
            const state = yield* getLatestUserInputState(key);
            before.set(keyId, Option.isSome(state) && state.value.state === "pending");
          }

          yield* upsertProjectionThreadActivityRow(row);

          const deltas = new Map<string, number>();
          for (const [keyId, key] of keys) {
            const state = yield* getLatestUserInputState(key);
            const wasPending = before.get(keyId) ?? false;
            const isPending = Option.isSome(state) && state.value.state === "pending";
            const delta = Number(isPending) - Number(wasPending);
            if (delta !== 0) {
              deltas.set(key.threadId, (deltas.get(key.threadId) ?? 0) + delta);
            }
          }
          for (const [threadId, delta] of deltas) {
            yield* sql`
              INSERT INTO projection_thread_user_input_summaries (thread_id, pending_count)
              VALUES (${threadId}, ${Math.max(delta, 0)})
              ON CONFLICT (thread_id)
              DO UPDATE SET pending_count = pending_count + ${delta}
            `;
          }

          const affectedThreadIds = new Set(Array.from(keys.values(), (key) => key.threadId));
          for (const threadId of affectedThreadIds) {
            const pendingUserInputCount = yield* getOrRebuildPendingUserInputCount({ threadId });
            yield* sql`
              UPDATE projection_threads
              SET pending_user_input_count = ${pendingUserInputCount}
              WHERE thread_id = ${threadId}
            `;
          }
        }),
      )
      .pipe(
        Effect.mapError(
          toPersistenceSqlOrDecodeError(
            "ProjectionThreadActivityRepository.upsert:query",
            "ProjectionThreadActivityRepository.upsert:encodeRequest",
          ),
        ),
      );

  const listByThreadId: ProjectionThreadActivityRepositoryShape["listByThreadId"] = (input) =>
    listProjectionThreadActivityRows(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ProjectionThreadActivityRepository.listByThreadId:query",
          "ProjectionThreadActivityRepository.listByThreadId:decodeRows",
        ),
      ),
      Effect.map((rows) => rows.map(fromDbRow)),
    );

  const countPendingUserInputsByThreadId: ProjectionThreadActivityRepositoryShape["countPendingUserInputsByThreadId"] =
    (input) =>
      sql
        .withTransaction(getOrRebuildPendingUserInputCount(input))
        .pipe(
          Effect.mapError(
            toPersistenceSqlOrDecodeError(
              "ProjectionThreadActivityRepository.countPendingUserInputsByThreadId:query",
              "ProjectionThreadActivityRepository.countPendingUserInputsByThreadId:decodeRow",
            ),
          ),
        );

  const deleteByThreadId: ProjectionThreadActivityRepositoryShape["deleteByThreadId"] = (input) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          yield* deleteProjectionThreadActivityRows(input);
          yield* resetPendingUserInputSummary(input);
          yield* sql`
            UPDATE projection_threads
            SET pending_user_input_count = 0
            WHERE thread_id = ${input.threadId}
          `;
        }),
      )
      .pipe(
        Effect.mapError(
          toPersistenceSqlError("ProjectionThreadActivityRepository.deleteByThreadId:query"),
        ),
      );

  return {
    upsert,
    listByThreadId,
    countPendingUserInputsByThreadId,
    deleteByThreadId,
  } satisfies ProjectionThreadActivityRepositoryShape;
});

export const ProjectionThreadActivityRepositoryLive = Layer.effect(
  ProjectionThreadActivityRepository,
  makeProjectionThreadActivityRepository,
);
