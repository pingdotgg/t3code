import { CommandId, NonNegativeInt, ThreadId } from "@t3tools/contracts";
import { Context, DateTime, Effect, Layer, Option, Schema } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * ERRORS
 */
export class CommandReceiptStoreWriteError extends Schema.TaggedErrorClass<CommandReceiptStoreWriteError>()(
  "CommandReceiptStoreWriteError",
  {
    commandId: CommandId,
    cause: Schema.optional(Schema.Defect),
  },
) {
  override get message(): string {
    return `Failed to write orchestration V2 command receipt ${this.commandId}.`;
  }
}

export class CommandReceiptStoreReadError extends Schema.TaggedErrorClass<CommandReceiptStoreReadError>()(
  "CommandReceiptStoreReadError",
  {
    commandId: CommandId,
    cause: Schema.optional(Schema.Defect),
  },
) {
  override get message(): string {
    return `Failed to read orchestration V2 command receipt ${this.commandId}.`;
  }
}

export const CommandReceiptStoreV2Error = Schema.Union([
  CommandReceiptStoreWriteError,
  CommandReceiptStoreReadError,
]);
export type CommandReceiptStoreV2Error = typeof CommandReceiptStoreV2Error.Type;

/**
 * SERVICE DEFINITION
 */
export const CommandReceiptV2Status = Schema.Literals(["accepted", "rejected"]);
export type CommandReceiptV2Status = typeof CommandReceiptV2Status.Type;

export const CommandReceiptV2 = Schema.Struct({
  commandId: CommandId,
  threadId: ThreadId,
  commandType: Schema.String,
  acceptedAt: Schema.DateTimeUtc,
  resultSequence: NonNegativeInt,
  status: CommandReceiptV2Status,
  error: Schema.NullOr(Schema.String),
});
export type CommandReceiptV2 = typeof CommandReceiptV2.Type;

export interface CommandReceiptStoreV2Shape {
  readonly upsert: (receipt: CommandReceiptV2) => Effect.Effect<void, CommandReceiptStoreV2Error>;
  readonly getByCommandId: (
    commandId: CommandId,
  ) => Effect.Effect<Option.Option<CommandReceiptV2>, CommandReceiptStoreV2Error>;
}

export class CommandReceiptStoreV2 extends Context.Service<
  CommandReceiptStoreV2,
  CommandReceiptStoreV2Shape
>()("t3/orchestration-v2/CommandReceiptStore") {}

/**
 * IMPLEMENTATIONS
 */
type CommandReceiptRow = {
  readonly command_id: string;
  readonly thread_id: string;
  readonly command_type: string;
  readonly accepted_at: string;
  readonly result_sequence: number;
  readonly status: string;
  readonly error: string | null;
};

const decodeReceipt = Schema.decodeUnknownEffect(
  CommandReceiptV2.mapFields((fields) => ({
    ...fields,
    acceptedAt: Schema.DateTimeUtcFromString,
  })),
);

function rowToReceipt(row: CommandReceiptRow) {
  return decodeReceipt({
    commandId: row.command_id,
    threadId: row.thread_id,
    commandType: row.command_type,
    acceptedAt: row.accepted_at,
    resultSequence: row.result_sequence,
    status: row.status,
    error: row.error,
  });
}

export const layer: Layer.Layer<CommandReceiptStoreV2, never, SqlClient.SqlClient> = Layer.effect(
  CommandReceiptStoreV2,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    return CommandReceiptStoreV2.of({
      upsert: (receipt) =>
        sql`
          INSERT INTO orchestration_v2_command_receipts (
            command_id,
            thread_id,
            command_type,
            accepted_at,
            result_sequence,
            status,
            error
          )
          VALUES (
            ${receipt.commandId},
            ${receipt.threadId},
            ${receipt.commandType},
            ${DateTime.formatIso(receipt.acceptedAt)},
            ${receipt.resultSequence},
            ${receipt.status},
            ${receipt.error}
          )
          ON CONFLICT(command_id)
          DO UPDATE SET
            thread_id = excluded.thread_id,
            command_type = excluded.command_type,
            accepted_at = excluded.accepted_at,
            result_sequence = excluded.result_sequence,
            status = excluded.status,
            error = excluded.error
        `.pipe(
          Effect.asVoid,
          Effect.mapError(
            (cause) =>
              new CommandReceiptStoreWriteError({
                commandId: receipt.commandId,
                cause,
              }),
          ),
        ),
      getByCommandId: (commandId) =>
        sql<CommandReceiptRow>`
          SELECT
            command_id,
            thread_id,
            command_type,
            accepted_at,
            result_sequence,
            status,
            error
          FROM orchestration_v2_command_receipts
          WHERE command_id = ${commandId}
        `.pipe(
          Effect.flatMap((rows) => {
            const row = rows[0];
            return row === undefined
              ? Effect.succeed(Option.none())
              : rowToReceipt(row).pipe(Effect.map(Option.some));
          }),
          Effect.mapError(
            (cause) =>
              new CommandReceiptStoreReadError({
                commandId,
                cause,
              }),
          ),
        ),
    } satisfies CommandReceiptStoreV2Shape);
  }),
);
