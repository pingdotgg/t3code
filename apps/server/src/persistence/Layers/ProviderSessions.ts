import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import { Effect, Layer, Option, Schema } from "effect";

import {
  ProviderSessionRepositoryPersistenceError,
  ProviderSessionRepositoryValidationError,
} from "../Errors.ts";
import {
  ProviderSessionRepository,
  type ProviderSessionEntry,
  type ProviderSessionRepositoryShape,
} from "../Services/ProviderSessions.ts";

const NonEmptyString = Schema.NonEmptyString;

const ProviderKindSchema = Schema.Literals(["codex", "claudeCode"]);

const ProviderSessionRowSchema = Schema.Struct({
  sessionId: Schema.String,
  provider: ProviderKindSchema,
  threadId: Schema.NullOr(Schema.String),
  createdAt: Schema.String,
  updatedAt: Schema.String,
});

const SessionIdRequestSchema = Schema.Struct({
  sessionId: NonEmptyString,
});

const UpsertSessionRequestSchema = Schema.Struct({
  sessionId: NonEmptyString,
  provider: ProviderKindSchema,
  threadId: Schema.NullOr(NonEmptyString),
});

function errorMessage(cause: unknown, fallback: string): string {
  if (cause instanceof Error && cause.message.length > 0) {
    return cause.message;
  }
  return fallback;
}

function toValidationError(
  operation: string,
  cause: unknown,
): ProviderSessionRepositoryValidationError {
  return new ProviderSessionRepositoryValidationError({
    operation,
    issue: errorMessage(cause, "Invalid provider session repository input."),
    cause,
  });
}

function decodeInput<A>(
  schema: Schema.Schema<A>,
  input: unknown,
  operation: string,
): Effect.Effect<A, ProviderSessionRepositoryValidationError> {
  return Schema.decodeUnknownEffect(schema)(input).pipe(
    Effect.mapError((cause) => toValidationError(operation, cause)),
  ) as Effect.Effect<A, ProviderSessionRepositoryValidationError>;
}

function toPersistenceError(
  operation: string,
  cause: unknown,
): ProviderSessionRepositoryPersistenceError {
  return new ProviderSessionRepositoryPersistenceError({
    operation,
    detail: `Failed to execute ${operation}.`,
    cause,
  });
}

function toEntry(
  row: Schema.Schema.Type<typeof ProviderSessionRowSchema>,
): ProviderSessionEntry {
  return {
    sessionId: row.sessionId,
    provider: row.provider,
    ...(row.threadId !== null ? { threadId: row.threadId } : {}),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

const makeProviderSessionRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const upsertSessionRow = SqlSchema.findOne({
    Request: UpsertSessionRequestSchema,
    Result: ProviderSessionRowSchema,
    execute: (request) =>
      sql`
        INSERT INTO provider_sessions (
          session_id,
          provider,
          thread_id,
          created_at,
          updated_at
        )
        VALUES (
          ${request.sessionId},
          ${request.provider},
          ${request.threadId},
          CURRENT_TIMESTAMP,
          CURRENT_TIMESTAMP
        )
        ON CONFLICT (session_id)
        DO UPDATE SET
          provider = excluded.provider,
          thread_id = excluded.thread_id,
          updated_at = CURRENT_TIMESTAMP
        RETURNING
          session_id AS "sessionId",
          provider,
          thread_id AS "threadId",
          created_at AS "createdAt",
          updated_at AS "updatedAt"
      `,
  });

  const findSessionRow = SqlSchema.findOneOption({
    Request: SessionIdRequestSchema,
    Result: ProviderSessionRowSchema,
    execute: ({ sessionId }) =>
      sql`
        SELECT
          session_id AS "sessionId",
          provider,
          thread_id AS "threadId",
          created_at AS "createdAt",
          updated_at AS "updatedAt"
        FROM provider_sessions
        WHERE session_id = ${sessionId}
      `,
  });

  const listSessionRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProviderSessionRowSchema,
    execute: () =>
      sql`
        SELECT
          session_id AS "sessionId",
          provider,
          thread_id AS "threadId",
          created_at AS "createdAt",
          updated_at AS "updatedAt"
        FROM provider_sessions
        ORDER BY created_at ASC, session_id ASC
      `,
  });

  const deleteSessionRow = SqlSchema.void({
    Request: SessionIdRequestSchema,
    execute: ({ sessionId }) => sql`DELETE FROM provider_sessions WHERE session_id = ${sessionId}`,
  });

  const upsertSession: ProviderSessionRepositoryShape["upsertSession"] = (input) =>
    Effect.gen(function* () {
      const parsed = yield* decodeInput(
        UpsertSessionRequestSchema,
        {
          sessionId: input.sessionId.trim(),
          provider: input.provider,
          threadId: input.threadId?.trim() || null,
        },
        "ProviderSessionRepository.upsertSession",
      );

      yield* upsertSessionRow(parsed).pipe(
        Effect.mapError((cause) =>
          toPersistenceError("ProviderSessionRepository.upsertSession:query", cause),
        ),
        Effect.asVoid,
      );
    });

  const getSession: ProviderSessionRepositoryShape["getSession"] = (input) =>
    Effect.gen(function* () {
      const parsed = yield* decodeInput(
        SessionIdRequestSchema,
        { sessionId: input.sessionId.trim() },
        "ProviderSessionRepository.getSession",
      );

      const row = yield* findSessionRow(parsed).pipe(
        Effect.mapError((cause) =>
          toPersistenceError("ProviderSessionRepository.getSession:query", cause),
        ),
      );

      return Option.map(row, toEntry);
    });

  const listSessions: ProviderSessionRepositoryShape["listSessions"] = () =>
    listSessionRows(undefined).pipe(
      Effect.mapError((cause) =>
        toPersistenceError("ProviderSessionRepository.listSessions:query", cause),
      ),
      Effect.map((rows) => rows.map(toEntry)),
    );

  const deleteSession: ProviderSessionRepositoryShape["deleteSession"] = (input) =>
    Effect.gen(function* () {
      const parsed = yield* decodeInput(
        SessionIdRequestSchema,
        { sessionId: input.sessionId.trim() },
        "ProviderSessionRepository.deleteSession",
      );

      yield* deleteSessionRow(parsed).pipe(
        Effect.mapError((cause) =>
          toPersistenceError("ProviderSessionRepository.deleteSession:query", cause),
        ),
      );
    });

  return {
    upsertSession,
    getSession,
    listSessions,
    deleteSession,
  } satisfies ProviderSessionRepositoryShape;
});

export const ProviderSessionRepositoryLive = Layer.effect(
  ProviderSessionRepository,
  makeProviderSessionRepository,
);
