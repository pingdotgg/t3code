import { EnvironmentId, SandboxRecord } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

import { PersistenceDecodeError, PersistenceSqlError } from "./Errors.ts";

const RecordRow = Schema.Struct({
  record: Schema.fromJsonString(SandboxRecord),
});

export class SandboxRecordRepository extends Context.Service<
  SandboxRecordRepository,
  {
    readonly list: Effect.Effect<
      ReadonlyArray<SandboxRecord>,
      PersistenceSqlError | PersistenceDecodeError
    >;
    readonly get: (
      environmentId: EnvironmentId,
    ) => Effect.Effect<Option.Option<SandboxRecord>, PersistenceSqlError | PersistenceDecodeError>;
    readonly put: (
      record: SandboxRecord,
    ) => Effect.Effect<void, PersistenceSqlError | PersistenceDecodeError>;
    readonly remove: (environmentId: EnvironmentId) => Effect.Effect<void, PersistenceSqlError>;
  }
>()("t3/persistence/SandboxRecords/SandboxRecordRepository") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const findOne = SqlSchema.findOneOption({
    Request: EnvironmentId,
    Result: RecordRow,
    execute: (environmentId) =>
      sql`
        SELECT record_json AS "record"
        FROM sandbox_records
        WHERE environment_id = ${environmentId}
      `,
  });
  const listAll = SqlSchema.findAll({
    Request: Schema.Void,
    Result: RecordRow,
    execute: () =>
      sql`
        SELECT record_json AS "record"
        FROM sandbox_records
        ORDER BY updated_at DESC
      `,
  });
  const encodeRecord = Schema.encodeEffect(Schema.fromJsonString(SandboxRecord));

  return SandboxRecordRepository.of({
    list: listAll(undefined).pipe(
      NodeSqliteClient.readOnly,
      Effect.mapError((cause) =>
        Schema.isSchemaError(cause)
          ? PersistenceDecodeError.fromSchemaError("SandboxRecord", cause)
          : new PersistenceSqlError({ operation: "listSandboxRecords", cause }),
      ),
      Effect.map((rows): ReadonlyArray<SandboxRecord> => rows.map((row) => row.record)),
    ),
    get: Effect.fn("SandboxRecordRepository.get")(function (environmentId) {
      return findOne(environmentId).pipe(
        NodeSqliteClient.readOnly,
        Effect.map(Option.map((row) => row.record)),
        Effect.mapError((cause) =>
          Schema.isSchemaError(cause)
            ? PersistenceDecodeError.fromSchemaError("SandboxRecord", cause)
            : new PersistenceSqlError({ operation: "getSandboxRecord", cause }),
        ),
      );
    }),
    put: Effect.fn("SandboxRecordRepository.put")(function (record) {
      return encodeRecord(record).pipe(
        Effect.mapError((cause) => PersistenceDecodeError.fromSchemaError("SandboxRecord", cause)),
        Effect.flatMap((recordJson) =>
          sql`
            INSERT INTO sandbox_records (environment_id, record_json, updated_at)
            VALUES (${record.environmentId}, ${recordJson}, ${record.updatedAt})
            ON CONFLICT (environment_id) DO UPDATE SET
              record_json = excluded.record_json,
              updated_at = excluded.updated_at
          `.pipe(
            Effect.mapError(
              (cause) => new PersistenceSqlError({ operation: "putSandboxRecord", cause }),
            ),
          ),
        ),
        Effect.asVoid,
      );
    }),
    remove: Effect.fn("SandboxRecordRepository.remove")(function (environmentId) {
      return sql`
        DELETE FROM sandbox_records WHERE environment_id = ${environmentId}
      `.pipe(
        Effect.mapError(
          (cause) => new PersistenceSqlError({ operation: "removeSandboxRecord", cause }),
        ),
        Effect.asVoid,
      );
    }),
  });
});

export const layer = Layer.effect(SandboxRecordRepository, make);
