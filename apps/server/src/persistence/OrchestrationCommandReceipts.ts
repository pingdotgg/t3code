import { CommandId, IsoDateTime, NonNegativeInt, ProjectId, ThreadId } from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import {
  toPersistenceSqlError,
  type OrchestrationCommandReceiptRepositoryError,
} from "./Errors.ts";

export const OrchestrationCommandReceipt = Schema.Struct({
  commandId: CommandId,
  aggregateKind: Schema.Literals(["project", "thread"]),
  aggregateId: Schema.Union([ProjectId, ThreadId]),
  commandType: Schema.String,
  acceptedAt: IsoDateTime,
  resultSequence: NonNegativeInt,
  status: Schema.Literals(["accepted", "rejected"]),
  error: Schema.NullOr(Schema.String),
  archiveSourceCommandId: Schema.optional(Schema.NullOr(CommandId)),
});
export type OrchestrationCommandReceipt = typeof OrchestrationCommandReceipt.Type;

export const GetByCommandIdInput = Schema.Struct({
  commandId: CommandId,
});
export type GetByCommandIdInput = typeof GetByCommandIdInput.Type;

const LifecycleCommandType = Schema.Literals([
  "thread.archive",
  "thread.unarchive",
  "thread.delete",
]);
export type LifecycleCommandType = typeof LifecycleCommandType.Type;
const GetLatestLifecycleInput = Schema.Struct({
  threadId: ThreadId,
  commandTypes: Schema.optional(Schema.Array(LifecycleCommandType)),
});

export class OrchestrationCommandReceiptRepository extends Context.Service<
  OrchestrationCommandReceiptRepository,
  {
    readonly insertIfAbsent: (
      receipt: OrchestrationCommandReceipt,
    ) => Effect.Effect<boolean, OrchestrationCommandReceiptRepositoryError>;

    readonly upsert: (
      receipt: OrchestrationCommandReceipt,
    ) => Effect.Effect<void, OrchestrationCommandReceiptRepositoryError>;

    readonly setArchiveSourceIfMissing: (input: {
      readonly commandId: CommandId;
      readonly threadId: ThreadId;
      readonly resultSequence: number;
      readonly sourceCommandId: CommandId;
    }) => Effect.Effect<boolean, OrchestrationCommandReceiptRepositoryError>;

    readonly getLatestLifecycle: (
      input: typeof GetLatestLifecycleInput.Type,
    ) => Effect.Effect<
      Option.Option<OrchestrationCommandReceipt>,
      OrchestrationCommandReceiptRepositoryError
    >;

    readonly getByCommandId: (
      input: GetByCommandIdInput,
    ) => Effect.Effect<
      Option.Option<OrchestrationCommandReceipt>,
      OrchestrationCommandReceiptRepositoryError
    >;
  }
>()("t3/persistence/OrchestrationCommandReceipts/OrchestrationCommandReceiptRepository") {}

const makeOrchestrationCommandReceiptRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const upsertReceiptRow = SqlSchema.void({
    Request: OrchestrationCommandReceipt,
    execute: (receipt) =>
      sql`
        INSERT INTO orchestration_command_receipts (
          command_id,
          aggregate_kind,
          aggregate_id,
          command_type,
          accepted_at,
          result_sequence,
          status,
          error,
          archive_source_command_id
        )
        VALUES (
          ${receipt.commandId},
          ${receipt.aggregateKind},
          ${receipt.aggregateId},
          ${receipt.commandType},
          ${receipt.acceptedAt},
          ${receipt.resultSequence},
          ${receipt.status},
          ${receipt.error},
          ${receipt.archiveSourceCommandId ?? null}
        )
        ON CONFLICT (command_id)
        DO UPDATE SET
          aggregate_kind = excluded.aggregate_kind,
            aggregate_id = excluded.aggregate_id,
            command_type = excluded.command_type,
          accepted_at = excluded.accepted_at,
          result_sequence = excluded.result_sequence,
          status = excluded.status,
          error = excluded.error,
          archive_source_command_id = excluded.archive_source_command_id
      `,
  });

  const findReceiptByCommandId = SqlSchema.findOneOption({
    Request: GetByCommandIdInput,
    Result: OrchestrationCommandReceipt,
    execute: ({ commandId }) =>
      sql`
        SELECT
          command_id AS "commandId",
          aggregate_kind AS "aggregateKind",
          aggregate_id AS "aggregateId",
          command_type AS "commandType",
          accepted_at AS "acceptedAt",
          result_sequence AS "resultSequence",
          status,
          error,
          archive_source_command_id AS "archiveSourceCommandId"
        FROM orchestration_command_receipts
        WHERE command_id = ${commandId}
      `,
  });

  const findLatestLifecycle = SqlSchema.findOneOption({
    Request: GetLatestLifecycleInput,
    Result: OrchestrationCommandReceipt,
    execute: ({ threadId, commandTypes }) => sql`
      SELECT command_id AS "commandId", aggregate_kind AS "aggregateKind",
        aggregate_id AS "aggregateId", command_type AS "commandType",
        accepted_at AS "acceptedAt", result_sequence AS "resultSequence", status, error,
        archive_source_command_id AS "archiveSourceCommandId"
      FROM orchestration_command_receipts
      WHERE aggregate_kind = 'thread' AND aggregate_id = ${threadId}
        AND status = 'accepted' AND command_type IN ('thread.archive', 'thread.unarchive', 'thread.delete')
        ${commandTypes === undefined ? sql`` : sql`AND command_type IN ${sql.in(commandTypes)}`}
      ORDER BY result_sequence DESC LIMIT 1
    `,
  });

  const upsert: OrchestrationCommandReceiptRepository["Service"]["upsert"] = (receipt) =>
    upsertReceiptRow(receipt).pipe(
      Effect.mapError(toPersistenceSqlError("OrchestrationCommandReceiptRepository.upsert:query")),
    );

  const insertIfAbsent: OrchestrationCommandReceiptRepository["Service"]["insertIfAbsent"] = (
    receipt,
  ) =>
    sql<{ readonly command_id: string }>`
      INSERT INTO orchestration_command_receipts (
        command_id,
        aggregate_kind,
        aggregate_id,
        command_type,
        accepted_at,
        result_sequence,
        status,
        error,
        archive_source_command_id
      )
      VALUES (
        ${receipt.commandId},
        ${receipt.aggregateKind},
        ${receipt.aggregateId},
        ${receipt.commandType},
        ${receipt.acceptedAt},
        ${receipt.resultSequence},
        ${receipt.status},
        ${receipt.error},
        ${receipt.archiveSourceCommandId ?? null}
      )
      ON CONFLICT(command_id) DO NOTHING
      RETURNING command_id
    `.pipe(
      Effect.map((rows) => rows.length === 1),
      Effect.mapError(
        toPersistenceSqlError("OrchestrationCommandReceiptRepository.insertIfAbsent:query"),
      ),
    );

  const getByCommandId: OrchestrationCommandReceiptRepository["Service"]["getByCommandId"] = (
    input,
  ) =>
    findReceiptByCommandId(input).pipe(
      NodeSqliteClient.readOnly,
      Effect.mapError(
        toPersistenceSqlError("OrchestrationCommandReceiptRepository.getByCommandId:query"),
      ),
    );

  return {
    setArchiveSourceIfMissing: Effect.fn(
      "OrchestrationCommandReceiptRepository.setArchiveSourceIfMissing",
    )(({ commandId, threadId, resultSequence, sourceCommandId }) =>
      sql<{ readonly command_id: string }>`
          UPDATE orchestration_command_receipts
          SET archive_source_command_id = ${sourceCommandId}
          WHERE command_id = ${commandId}
            AND aggregate_kind = 'thread' AND aggregate_id = ${threadId}
            AND status = 'accepted' AND command_type = 'thread.archive'
            AND result_sequence = ${resultSequence} AND archive_source_command_id IS NULL
          RETURNING command_id
        `.pipe(
        Effect.map((rows) => rows.length === 1),
        Effect.mapError(
          toPersistenceSqlError(
            "OrchestrationCommandReceiptRepository.setArchiveSourceIfMissing:query",
          ),
        ),
      ),
    ),
    getLatestLifecycle: (input) =>
      findLatestLifecycle(input).pipe(
        Effect.mapError(
          toPersistenceSqlError("OrchestrationCommandReceiptRepository.getLatestLifecycle:query"),
        ),
      ),
    insertIfAbsent,
    upsert,
    getByCommandId,
  } satisfies OrchestrationCommandReceiptRepository["Service"];
});

export const layer = Layer.effect(
  OrchestrationCommandReceiptRepository,
  makeOrchestrationCommandReceiptRepository,
);
