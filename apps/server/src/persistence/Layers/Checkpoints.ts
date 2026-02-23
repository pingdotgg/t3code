/**
 * CheckpointRepositoryLive - SQLite-backed checkpoint metadata repository layer.
 *
 * Persists and queries checkpoint metadata (`turnCount`, labels, previews,
 * message counts) and the associated hidden Git ref for each turn.
 *
 * This layer does not read/write Git refs and does not perform provider-thread
 * rollback. Those responsibilities remain in `CheckpointStore` and
 * `CheckpointService`.
 *
 * @module CheckpointRepositoryLive
 */
import type { ProviderCheckpoint } from "@t3tools/contracts";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import { Effect, Layer, Option, Schema } from "effect";

import {
  CheckpointRepositoryPersistenceError,
  CheckpointRepositoryValidationError,
  type CheckpointRepositoryError,
} from "../Errors.ts";
import { makeSqlitePersistenceLive } from "./Sqlite.ts";
import {
  CheckpointRepository,
  type CheckpointRepositoryEntry,
  type CheckpointRepositoryShape,
} from "../Services/Checkpoints.ts";

const NonEmptyString = Schema.NonEmptyString;

const CheckpointRowSchema = Schema.Struct({
  providerSessionId: Schema.String,
  threadId: Schema.String,
  checkpointId: Schema.String,
  checkpointRef: Schema.String,
  turnCount: Schema.Number,
  messageCount: Schema.Number,
  label: Schema.String,
  preview: Schema.NullOr(Schema.String),
  createdAt: Schema.String,
});

const SessionRequestSchema = Schema.Struct({
  providerSessionId: NonEmptyString,
});

const UpsertRequestSchema = Schema.Struct({
  providerSessionId: NonEmptyString,
  threadId: NonEmptyString,
  checkpointId: NonEmptyString,
  checkpointRef: NonEmptyString,
  turnCount: Schema.Int,
  messageCount: Schema.Int,
  label: NonEmptyString,
  preview: Schema.NullOr(Schema.String),
  createdAt: NonEmptyString,
});

const GetCheckpointRequestSchema = Schema.Struct({
  providerSessionId: NonEmptyString,
  turnCount: Schema.Int,
});

const DeleteAfterTurnRequestSchema = Schema.Struct({
  providerSessionId: NonEmptyString,
  maxTurnCount: Schema.Int,
});

function errorMessage(cause: unknown, fallback: string): string {
  if (cause instanceof Error && cause.message.length > 0) {
    return cause.message;
  }
  return fallback;
}

function toValidationError(operation: string, cause: unknown): CheckpointRepositoryValidationError {
  return new CheckpointRepositoryValidationError({
    operation,
    issue: errorMessage(cause, "Invalid checkpoint repository input."),
    cause,
  });
}

function decodeInput<A>(
  schema: Schema.Schema<A>,
  input: unknown,
  operation: string,
): Effect.Effect<A, CheckpointRepositoryValidationError> {
  return Schema.decodeUnknownEffect(schema)(input).pipe(
    Effect.mapError((cause) => toValidationError(operation, cause)),
  ) as Effect.Effect<A, CheckpointRepositoryValidationError>;
}

function ensureNonNegativeInt(
  operation: string,
  field: string,
  value: number,
): Effect.Effect<number, CheckpointRepositoryValidationError> {
  if (value < 0) {
    return Effect.fail(
      new CheckpointRepositoryValidationError({
        operation,
        issue: `${field} must be an integer >= 0.`,
      }),
    );
  }
  return Effect.succeed(value);
}

function toPersistenceError(
  operation: string,
  cause: unknown,
): CheckpointRepositoryPersistenceError {
  return new CheckpointRepositoryPersistenceError({
    operation,
    detail: `Failed to execute ${operation}.`,
    cause,
  });
}

function toCheckpointEntry(
  row: Schema.Schema.Type<typeof CheckpointRowSchema>,
  isCurrent: boolean,
): CheckpointRepositoryEntry {
  return {
    id: row.checkpointId,
    threadId: row.threadId,
    checkpointRef: row.checkpointRef,
    turnCount: row.turnCount,
    messageCount: row.messageCount,
    label: row.label,
    ...(row.preview !== null ? { preview: row.preview } : {}),
    createdAt: row.createdAt,
    isCurrent,
  };
}

function toProviderCheckpoint(entry: CheckpointRepositoryEntry): ProviderCheckpoint {
  return {
    id: entry.id,
    turnCount: entry.turnCount,
    messageCount: entry.messageCount,
    label: entry.label,
    ...(entry.preview !== undefined ? { preview: entry.preview } : {}),
    isCurrent: entry.isCurrent,
  };
}

const makeCheckpointRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const upsertCheckpointRow = SqlSchema.findOne({
    Request: UpsertRequestSchema,
    Result: CheckpointRowSchema,
    execute: (request) =>
      sql`
        INSERT INTO provider_checkpoints (
          provider_session_id,
          thread_id,
          checkpoint_id,
          checkpoint_ref,
          turn_count,
          message_count,
          label,
          preview,
          created_at
        )
        VALUES (
          ${request.providerSessionId},
          ${request.threadId},
          ${request.checkpointId},
          ${request.checkpointRef},
          ${request.turnCount},
          ${request.messageCount},
          ${request.label},
          ${request.preview},
          ${request.createdAt}
        )
        ON CONFLICT (provider_session_id, turn_count)
        DO UPDATE SET
          thread_id = excluded.thread_id,
          checkpoint_id = excluded.checkpoint_id,
          checkpoint_ref = excluded.checkpoint_ref,
          message_count = excluded.message_count,
          label = excluded.label,
          preview = excluded.preview,
          created_at = excluded.created_at
        RETURNING
          provider_session_id AS "providerSessionId",
          thread_id AS "threadId",
          checkpoint_id AS "checkpointId",
          checkpoint_ref AS "checkpointRef",
          turn_count AS "turnCount",
          message_count AS "messageCount",
          label,
          preview,
          created_at AS "createdAt"
      `,
  });

  const listCheckpointRows = SqlSchema.findAll({
    Request: SessionRequestSchema,
    Result: CheckpointRowSchema,
    execute: ({ providerSessionId }) =>
      sql`
        SELECT
          provider_session_id AS "providerSessionId",
          thread_id AS "threadId",
          checkpoint_id AS "checkpointId",
          checkpoint_ref AS "checkpointRef",
          turn_count AS "turnCount",
          message_count AS "messageCount",
          label,
          preview,
          created_at AS "createdAt"
        FROM provider_checkpoints
        WHERE provider_session_id = ${providerSessionId}
        ORDER BY turn_count ASC
      `,
  });

  const listForSession = (
    providerSessionId: string,
  ): Effect.Effect<ReadonlyArray<CheckpointRepositoryEntry>, CheckpointRepositoryError> =>
    listCheckpointRows({ providerSessionId }).pipe(
      Effect.mapError((cause) =>
        toPersistenceError("CheckpointRepository.listCheckpoints:query", cause),
      ),
      Effect.map((rows) => {
        const currentTurnCount = rows[rows.length - 1]?.turnCount;
        return rows.map((row) => toCheckpointEntry(row, row.turnCount === currentTurnCount));
      }),
    );

  const upsertCheckpoint: CheckpointRepositoryShape["upsertCheckpoint"] = (input) =>
    Effect.gen(function* () {
      const operation = "CheckpointRepository.upsertCheckpoint";
      const parsed = yield* decodeInput(
        UpsertRequestSchema,
        {
          providerSessionId: input.providerSessionId.trim(),
          threadId: input.threadId.trim(),
          checkpointId: input.checkpointId.trim(),
          checkpointRef: input.checkpointRef.trim(),
          turnCount: input.turnCount,
          messageCount: input.messageCount,
          label: input.label.trim(),
          preview: input.preview?.trim() || null,
          createdAt: input.createdAt.trim(),
        },
        operation,
      );
      yield* ensureNonNegativeInt(operation, "turnCount", parsed.turnCount);
      yield* ensureNonNegativeInt(operation, "messageCount", parsed.messageCount);

      yield* upsertCheckpointRow(parsed).pipe(
        Effect.mapError((cause) =>
          toPersistenceError("CheckpointRepository.upsertCheckpoint:query", cause),
        ),
        Effect.asVoid,
      );
    });

  const listCheckpoints: CheckpointRepositoryShape["listCheckpoints"] = (input) =>
    Effect.gen(function* () {
      const parsed = yield* decodeInput(
        SessionRequestSchema,
        {
          providerSessionId: input.providerSessionId.trim(),
        },
        "CheckpointRepository.listCheckpoints",
      );

      const entries = yield* listForSession(parsed.providerSessionId);
      return entries.map(toProviderCheckpoint);
    });

  const getCheckpoint: CheckpointRepositoryShape["getCheckpoint"] = (input) =>
    Effect.gen(function* () {
      const parsed = yield* decodeInput(
        GetCheckpointRequestSchema,
        {
          providerSessionId: input.providerSessionId.trim(),
          turnCount: input.turnCount,
        },
        "CheckpointRepository.getCheckpoint",
      );
      yield* ensureNonNegativeInt(
        "CheckpointRepository.getCheckpoint",
        "turnCount",
        parsed.turnCount,
      );

      const entries = yield* listForSession(parsed.providerSessionId);
      const checkpoint = entries.find((entry) => entry.turnCount === parsed.turnCount);
      return Option.fromNullishOr(checkpoint);
    });

  const deleteAfterTurn: CheckpointRepositoryShape["deleteAfterTurn"] = (input) =>
    Effect.gen(function* () {
      const parsed = yield* decodeInput(
        DeleteAfterTurnRequestSchema,
        {
          providerSessionId: input.providerSessionId.trim(),
          maxTurnCount: input.maxTurnCount,
        },
        "CheckpointRepository.deleteAfterTurn",
      );
      yield* ensureNonNegativeInt(
        "CheckpointRepository.deleteAfterTurn",
        "maxTurnCount",
        parsed.maxTurnCount,
      );

      yield* sql`
        DELETE FROM provider_checkpoints
        WHERE provider_session_id = ${parsed.providerSessionId}
          AND turn_count > ${parsed.maxTurnCount}
      `.pipe(
        Effect.mapError((cause) =>
          toPersistenceError("CheckpointRepository.deleteAfterTurn:query", cause),
        ),
      );
    });

  const deleteAllForSession: CheckpointRepositoryShape["deleteAllForSession"] = (input) =>
    Effect.gen(function* () {
      const parsed = yield* decodeInput(
        SessionRequestSchema,
        {
          providerSessionId: input.providerSessionId.trim(),
        },
        "CheckpointRepository.deleteAllForSession",
      );

      yield* sql`
        DELETE FROM provider_checkpoints
        WHERE provider_session_id = ${parsed.providerSessionId}
      `.pipe(
        Effect.mapError((cause) =>
          toPersistenceError("CheckpointRepository.deleteAllForSession:query", cause),
        ),
      );
    });

  return {
    upsertCheckpoint,
    listCheckpoints,
    getCheckpoint,
    deleteAfterTurn,
    deleteAllForSession,
  } satisfies CheckpointRepositoryShape;
});

export const CheckpointRepositoryLive = Layer.effect(
  CheckpointRepository,
  makeCheckpointRepository,
);

export function makeSqliteCheckpointRepositoryLive(dbPath: string) {
  return CheckpointRepositoryLive.pipe(Layer.provide(makeSqlitePersistenceLive(dbPath)));
}
