import { ProviderSessionId } from "@t3tools/contracts";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import { Effect, Layer, Option, Schema, Struct } from "effect";

import {
  toPersistenceDecodeError,
  toPersistenceSqlError,
  type ProviderSessionRuntimeRepositoryError,
} from "../Errors.ts";
import {
  ProviderSessionRuntime,
  ProviderSessionRuntimeRepository,
  type ProviderSessionRuntimeRepositoryShape,
} from "../Services/ProviderSessionRuntime.ts";

const ProviderSessionRuntimeDbRowSchema = ProviderSessionRuntime.mapFields(
  Struct.assign({
    resumeCursor: Schema.NullOr(Schema.fromJsonString(Schema.Unknown)),
    runtimePayload: Schema.NullOr(Schema.fromJsonString(Schema.Unknown)),
  }),
);

const decodeRuntime = Schema.decodeUnknownEffect(ProviderSessionRuntime);

const GetRuntimeRequestSchema = Schema.Struct({
  providerSessionId: ProviderSessionId,
});

const DeleteRuntimeRequestSchema = GetRuntimeRequestSchema;

function toPersistenceSqlOrDecodeError(sqlOperation: string, decodeOperation: string) {
  return (cause: unknown): ProviderSessionRuntimeRepositoryError =>
    Schema.isSchemaError(cause)
      ? toPersistenceDecodeError(decodeOperation)(cause)
      : toPersistenceSqlError(sqlOperation)(cause);
}

const makeProviderSessionRuntimeRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const upsertRuntimeRow = SqlSchema.void({
    Request: ProviderSessionRuntimeDbRowSchema,
    execute: (runtime) =>
      sql`
        INSERT INTO provider_session_runtime (
          provider_session_id,
          thread_id,
          provider_name,
          adapter_key,
          provider_thread_id,
          status,
          last_seen_at,
          resume_cursor_json,
          runtime_payload_json
        )
        VALUES (
          ${runtime.providerSessionId},
          ${runtime.threadId},
          ${runtime.providerName},
          ${runtime.adapterKey},
          ${runtime.providerThreadId},
          ${runtime.status},
          ${runtime.lastSeenAt},
          ${runtime.resumeCursor},
          ${runtime.runtimePayload}
        )
        ON CONFLICT (provider_session_id)
        DO UPDATE SET
          thread_id = excluded.thread_id,
          provider_name = excluded.provider_name,
          adapter_key = excluded.adapter_key,
          provider_thread_id = excluded.provider_thread_id,
          status = excluded.status,
          last_seen_at = excluded.last_seen_at,
          resume_cursor_json = excluded.resume_cursor_json,
          runtime_payload_json = excluded.runtime_payload_json
      `,
  });

  const getRuntimeRowBySessionId = SqlSchema.findOneOption({
    Request: GetRuntimeRequestSchema,
    Result: ProviderSessionRuntimeDbRowSchema,
    execute: ({ providerSessionId }) =>
      sql`
        SELECT
          provider_session_id AS "providerSessionId",
          thread_id AS "threadId",
          provider_name AS "providerName",
          adapter_key AS "adapterKey",
          provider_thread_id AS "providerThreadId",
          status,
          last_seen_at AS "lastSeenAt",
          resume_cursor_json AS "resumeCursor",
          runtime_payload_json AS "runtimePayload"
        FROM provider_session_runtime
        WHERE provider_session_id = ${providerSessionId}
      `,
  });

  const listRuntimeRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProviderSessionRuntimeDbRowSchema,
    execute: () =>
      sql`
        SELECT
          provider_session_id AS "providerSessionId",
          thread_id AS "threadId",
          provider_name AS "providerName",
          adapter_key AS "adapterKey",
          provider_thread_id AS "providerThreadId",
          status,
          last_seen_at AS "lastSeenAt",
          resume_cursor_json AS "resumeCursor",
          runtime_payload_json AS "runtimePayload"
        FROM provider_session_runtime
        ORDER BY last_seen_at ASC, provider_session_id ASC
      `,
  });

  const deleteRuntimeBySessionId = SqlSchema.void({
    Request: DeleteRuntimeRequestSchema,
    execute: ({ providerSessionId }) =>
      sql`
        DELETE FROM provider_session_runtime
        WHERE provider_session_id = ${providerSessionId}
      `,
  });

  const upsert: ProviderSessionRuntimeRepositoryShape["upsert"] = (runtime) =>
    upsertRuntimeRow(runtime).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ProviderSessionRuntimeRepository.upsert:query",
          "ProviderSessionRuntimeRepository.upsert:encodeRequest",
        ),
      ),
    );

  const getBySessionId: ProviderSessionRuntimeRepositoryShape["getBySessionId"] = (input) =>
    getRuntimeRowBySessionId(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ProviderSessionRuntimeRepository.getBySessionId:query",
          "ProviderSessionRuntimeRepository.getBySessionId:decodeRow",
        ),
      ),
      Effect.flatMap((runtimeRowOption) =>
        Option.match(runtimeRowOption, {
          onNone: () => Effect.succeed(Option.none()),
          onSome: (row) =>
            decodeRuntime(row).pipe(
              Effect.mapError(
                toPersistenceDecodeError(
                  "ProviderSessionRuntimeRepository.getBySessionId:rowToRuntime",
                ),
              ),
              Effect.map((runtime) => Option.some(runtime)),
            ),
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
          (row) =>
            decodeRuntime(row).pipe(
              Effect.mapError(
                toPersistenceDecodeError("ProviderSessionRuntimeRepository.list:rowToRuntime"),
              ),
            ),
          { concurrency: "unbounded" },
        ),
      ),
    );

  const deleteBySessionId: ProviderSessionRuntimeRepositoryShape["deleteBySessionId"] = (input) =>
    deleteRuntimeBySessionId(input).pipe(
      Effect.mapError(
        toPersistenceSqlError("ProviderSessionRuntimeRepository.deleteBySessionId:query"),
      ),
    );

  return {
    upsert,
    getBySessionId,
    list,
    deleteBySessionId,
  } satisfies ProviderSessionRuntimeRepositoryShape;
});

export const ProviderSessionRuntimeRepositoryLive = Layer.effect(
  ProviderSessionRuntimeRepository,
  makeProviderSessionRuntimeRepository,
);
