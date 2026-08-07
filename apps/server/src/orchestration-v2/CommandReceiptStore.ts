import { CommandId, NonNegativeInt, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { OrchestrationCommandReceiptRepositoryLive } from "../persistence/Layers/OrchestrationCommandReceipts.ts";
import {
  OrchestrationCommandReceiptRepository,
  type OrchestrationCommandReceipt,
} from "../persistence/Services/OrchestrationCommandReceipts.ts";

/**
 * ERRORS
 */
export class CommandReceiptStoreWriteError extends Schema.TaggedErrorClass<CommandReceiptStoreWriteError>()(
  "CommandReceiptStoreWriteError",
  {
    commandId: CommandId,
    cause: Schema.optional(Schema.Defect()),
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
    cause: Schema.optional(Schema.Defect()),
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
  readonly insertIfAbsent: (
    receipt: CommandReceiptV2,
  ) => Effect.Effect<boolean, CommandReceiptStoreV2Error>;
  readonly upsert: (receipt: CommandReceiptV2) => Effect.Effect<void, CommandReceiptStoreV2Error>;
  readonly getByCommandId: (
    commandId: CommandId,
  ) => Effect.Effect<Option.Option<CommandReceiptV2>, CommandReceiptStoreV2Error>;
}

export class CommandReceiptStoreV2 extends Context.Service<
  CommandReceiptStoreV2,
  CommandReceiptStoreV2Shape
>()("t3/orchestration-v2/CommandReceiptStore/CommandReceiptStoreV2") {}

/**
 * IMPLEMENTATIONS
 */
const decodeReceipt = Schema.decodeUnknownEffect(
  CommandReceiptV2.mapFields((fields) => ({
    ...fields,
    acceptedAt: Schema.DateTimeUtcFromString,
  })),
);

function fromApplicationReceipt(receipt: OrchestrationCommandReceipt) {
  return decodeReceipt({
    commandId: receipt.commandId,
    threadId: receipt.aggregateId,
    commandType: receipt.commandType,
    acceptedAt: receipt.acceptedAt,
    resultSequence: receipt.resultSequence,
    status: receipt.status,
    error: receipt.error,
  });
}

function toApplicationReceipt(receipt: CommandReceiptV2): OrchestrationCommandReceipt {
  return {
    commandId: receipt.commandId,
    aggregateKind: "thread",
    aggregateId: receipt.threadId,
    commandType: receipt.commandType,
    acceptedAt: DateTime.formatIso(receipt.acceptedAt),
    resultSequence: receipt.resultSequence,
    status: receipt.status,
    error: receipt.error,
  };
}

const baseLayer: Layer.Layer<CommandReceiptStoreV2, never, OrchestrationCommandReceiptRepository> =
  Layer.effect(
    CommandReceiptStoreV2,
    Effect.gen(function* () {
      const receipts = yield* OrchestrationCommandReceiptRepository;

      return CommandReceiptStoreV2.of({
        insertIfAbsent: (receipt) =>
          receipts.insertIfAbsent(toApplicationReceipt(receipt)).pipe(
            Effect.mapError(
              (cause) =>
                new CommandReceiptStoreWriteError({
                  commandId: receipt.commandId,
                  cause,
                }),
            ),
          ),
        upsert: (receipt) =>
          receipts.upsert(toApplicationReceipt(receipt)).pipe(
            Effect.mapError(
              (cause) =>
                new CommandReceiptStoreWriteError({
                  commandId: receipt.commandId,
                  cause,
                }),
            ),
          ),
        getByCommandId: (commandId) =>
          receipts.getByCommandId({ commandId }).pipe(
            Effect.flatMap(
              Option.match({
                onNone: () => Effect.succeed(Option.none()),
                onSome: (receipt) =>
                  receipt.aggregateKind !== "thread"
                    ? Effect.succeed(Option.none())
                    : fromApplicationReceipt(receipt).pipe(Effect.map(Option.some)),
              }),
            ),
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

export const layer = baseLayer.pipe(Layer.provide(OrchestrationCommandReceiptRepositoryLive));

export const layerFromApplicationReceipts = baseLayer;
