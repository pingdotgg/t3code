import {
  IsoDateTime,
  ProviderSessionRuntimeStatus,
  RuntimeMode,
  ThreadId,
} from "@t3tools/contracts";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import { Effect, Layer, Option, Schema, Struct } from "effect";

import {
  toPersistenceDecodeError,
  toPersistenceSqlError,
  PersistenceDecodeError,
  type ProviderSessionRuntimeRepositoryError,
} from "../Errors.ts";
import {
  ProviderSessionRuntime,
  ProviderSessionRuntimeRepository,
  type ProviderSessionRuntimeRepositoryShape,
} from "../Services/ProviderSessionRuntime.ts";

const LaxExecutionTarget = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("local") }),
  Schema.Struct({
    kind: Schema.Literal("wsl"),
    distroName: Schema.String,
    user: Schema.optional(Schema.String),
  }),
]);

const ProviderSessionRuntimeWriteSchema = ProviderSessionRuntime.mapFields(
  Struct.assign({
    executionTarget: Schema.NullOr(Schema.fromJsonString(LaxExecutionTarget)),
    resumeCursor: Schema.NullOr(Schema.fromJsonString(Schema.Unknown)),
    runtimePayload: Schema.NullOr(Schema.fromJsonString(Schema.Unknown)),
  }),
);

const ProviderSessionRuntimeDbRowSchema = Schema.Struct({
  threadId: ThreadId,
  providerName: Schema.String,
  adapterKey: Schema.String,
  runtimeMode: RuntimeMode,
  status: ProviderSessionRuntimeStatus,
  lastSeenAt: IsoDateTime,
  executionTarget: Schema.NullOr(Schema.String),
  resumeCursor: Schema.NullOr(Schema.String),
  runtimePayload: Schema.NullOr(Schema.String),
});
type ProviderSessionRuntimeDbRow = typeof ProviderSessionRuntimeDbRowSchema.Type;

const decodeRuntime = Schema.decodeUnknownEffect(ProviderSessionRuntime);

const GetRuntimeRequestSchema = Schema.Struct({
  threadId: ThreadId,
});

const DeleteRuntimeRequestSchema = GetRuntimeRequestSchema;

function toPersistenceSqlOrDecodeError(sqlOperation: string, decodeOperation: string) {
  return (cause: unknown): ProviderSessionRuntimeRepositoryError =>
    Schema.isSchemaError(cause)
      ? toPersistenceDecodeError(decodeOperation)(cause)
      : toPersistenceSqlError(sqlOperation)(cause);
}

function parseJsonField(value: string | null): unknown | null {
  if (value === null) return null;
  return JSON.parse(value);
}

function decodeRuntimeRow(
  row: ProviderSessionRuntimeDbRow,
  operation: string,
): Effect.Effect<ProviderSessionRuntime, ProviderSessionRuntimeRepositoryError> {
  const toJsonParseError = (cause: unknown) =>
    new PersistenceDecodeError({
      operation: `${operation}:parseJsonFields`,
      issue: "Failed to parse provider session runtime JSON fields.",
      cause,
    });

  return Effect.try({
    try: () => ({
      ...row,
      executionTarget: parseJsonField(row.executionTarget),
      resumeCursor: parseJsonField(row.resumeCursor),
      runtimePayload: parseJsonField(row.runtimePayload),
    }),
    catch: toJsonParseError,
  }).pipe(
    Effect.flatMap((runtime) =>
      decodeRuntime(runtime).pipe(Effect.mapError(toPersistenceDecodeError(operation))),
    ),
  );
}

const makeProviderSessionRuntimeRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const upsertRuntimeRow = SqlSchema.void({
    Request: ProviderSessionRuntimeWriteSchema,
    execute: (runtime) =>
      sql`
        INSERT INTO provider_session_runtime (
          thread_id,
          provider_name,
          adapter_key,
          runtime_mode,
          status,
          last_seen_at,
          execution_target_json,
          resume_cursor_json,
          runtime_payload_json
        )
        VALUES (
          ${runtime.threadId},
          ${runtime.providerName},
          ${runtime.adapterKey},
          ${runtime.runtimeMode},
          ${runtime.status},
          ${runtime.lastSeenAt},
          ${runtime.executionTarget},
          ${runtime.resumeCursor},
          ${runtime.runtimePayload}
        )
        ON CONFLICT (thread_id)
        DO UPDATE SET
          provider_name = excluded.provider_name,
          adapter_key = excluded.adapter_key,
          runtime_mode = excluded.runtime_mode,
          status = excluded.status,
          last_seen_at = excluded.last_seen_at,
          execution_target_json = excluded.execution_target_json,
          resume_cursor_json = excluded.resume_cursor_json,
          runtime_payload_json = excluded.runtime_payload_json
      `,
  });

  const getRuntimeRowByThreadId = SqlSchema.findOneOption({
    Request: GetRuntimeRequestSchema,
    Result: ProviderSessionRuntimeDbRowSchema,
    execute: ({ threadId }) =>
      sql`
        SELECT
          thread_id AS "threadId",
          provider_name AS "providerName",
          adapter_key AS "adapterKey",
          runtime_mode AS "runtimeMode",
          status,
          last_seen_at AS "lastSeenAt",
          execution_target_json AS "executionTarget",
          resume_cursor_json AS "resumeCursor",
          runtime_payload_json AS "runtimePayload"
        FROM provider_session_runtime
        WHERE thread_id = ${threadId}
      `,
  });

  const listRuntimeRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProviderSessionRuntimeDbRowSchema,
    execute: () =>
      sql`
        SELECT
          thread_id AS "threadId",
          provider_name AS "providerName",
          adapter_key AS "adapterKey",
          runtime_mode AS "runtimeMode",
          status,
          last_seen_at AS "lastSeenAt",
          execution_target_json AS "executionTarget",
          resume_cursor_json AS "resumeCursor",
          runtime_payload_json AS "runtimePayload"
        FROM provider_session_runtime
        ORDER BY last_seen_at ASC, thread_id ASC
      `,
  });

  const deleteRuntimeByThreadId = SqlSchema.void({
    Request: DeleteRuntimeRequestSchema,
    execute: ({ threadId }) =>
      sql`
        DELETE FROM provider_session_runtime
        WHERE thread_id = ${threadId}
      `,
  });

  const upsert: ProviderSessionRuntimeRepositoryShape["upsert"] = (runtime) =>
    upsertRuntimeRow({ ...runtime, executionTarget: runtime.executionTarget ?? null }).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ProviderSessionRuntimeRepository.upsert:query",
          "ProviderSessionRuntimeRepository.upsert:encodeRequest",
        ),
      ),
    );

  const getByThreadId: ProviderSessionRuntimeRepositoryShape["getByThreadId"] = (input) =>
    getRuntimeRowByThreadId(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ProviderSessionRuntimeRepository.getByThreadId:query",
          "ProviderSessionRuntimeRepository.getByThreadId:decodeRow",
        ),
      ),
      Effect.flatMap((runtimeRowOption) =>
        Option.match(runtimeRowOption, {
          onNone: () => Effect.succeed(Option.none()),
          onSome: (row) =>
            decodeRuntimeRow(
              row,
              "ProviderSessionRuntimeRepository.getByThreadId:rowToRuntime",
            ).pipe(Effect.map((runtime) => Option.some(runtime))),
        }),
      ),
    );

  const list: ProviderSessionRuntimeRepositoryShape["list"] = () =>
    listRuntimeRows(undefined).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ProviderSessionRuntimeRepository.list:query",
          "ProviderSessionRuntimeRepository.list:decodeRows",
        ),
      ),
      Effect.flatMap((rows) =>
        Effect.forEach(
          rows,
          (row) => decodeRuntimeRow(row, "ProviderSessionRuntimeRepository.list:rowToRuntime"),
          { concurrency: "unbounded" },
        ),
      ),
    );

  const deleteByThreadId: ProviderSessionRuntimeRepositoryShape["deleteByThreadId"] = (input) =>
    deleteRuntimeByThreadId(input).pipe(
      Effect.mapError(
        toPersistenceSqlError("ProviderSessionRuntimeRepository.deleteByThreadId:query"),
      ),
    );

  return {
    upsert,
    getByThreadId,
    list,
    deleteByThreadId,
  } satisfies ProviderSessionRuntimeRepositoryShape;
});

export const ProviderSessionRuntimeRepositoryLive = Layer.effect(
  ProviderSessionRuntimeRepository,
  makeProviderSessionRuntimeRepository,
);
