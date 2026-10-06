import { CommandId, NonNegativeInt, ProjectId, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as OrchestrationCommandReceipts from "../persistence/OrchestrationCommandReceipts.ts";

/**
 * ERRORS
 */
export class CommandReceiptStoreWriteError extends Schema.TaggedError<CommandReceiptStoreWriteError>()(
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

export class CommandReceiptStoreReadError extends Schema.TaggedError<CommandReceiptStoreReadError>()(
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

/** Receipt for a project command; shares the receipt table with thread commands. */
export const ProjectCommandReceiptV2 = Schema.Struct({
  commandId: CommandId,
  projectId: ProjectId,
  commandType: Schema.String,
  acceptedAt: Schema.DateTimeUtc,
  resultSequence: NonNegativeInt,
  status: CommandReceiptV2Status,
  error: Schema.NullOr(Schema.String),
});
export type ProjectCommandReceiptV2 = typeof ProjectCommandReceiptV2.Type;

type AnyCommandReceiptV2 = CommandReceiptV2 | ProjectCommandReceiptV2;

export interface CommandReceiptStoreV2Shape {
  readonly insertIfAbsent: (
    receipt: AnyCommandReceiptV2,
  ) => Effect.Effect<boolean, CommandReceiptStoreV2Error>;
  readonly upsert: (
    receipt: AnyCommandReceiptV2,
  ) => Effect.Effect<void, CommandReceiptStoreV2Error>;
  /** A thread command's receipt; none when the command id belongs to a project command. */
  readonly getByCommandId: (
    commandId: CommandId,
  ) => Effect.Effect<Option.Option<CommandReceiptV2>, CommandReceiptStoreV2Error>;
  /** A project command's receipt; none when the command id belongs to a thread command. */
  readonly getProjectByCommandId: (
    commandId: CommandId,
  ) => Effect.Effect<Option.Option<ProjectCommandReceiptV2>, CommandReceiptStoreV2Error>;
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
const decodeProjectReceipt = Schema.decodeUnknownEffect(
  ProjectCommandReceiptV2.mapFields((fields) => ({
    ...fields,
    acceptedAt: Schema.DateTimeUtcFromString,
  })),
);

function fromApplicationReceipt(receipt: OrchestrationCommandReceipts.OrchestrationCommandReceipt) {
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

function toApplicationReceipt(
  receipt: AnyCommandReceiptV2,
): OrchestrationCommandReceipts.OrchestrationCommandReceipt {
  return {
    commandId: receipt.commandId,
    ...("projectId" in receipt
      ? { aggregateKind: "project" as const, aggregateId: receipt.projectId }
      : { aggregateKind: "thread" as const, aggregateId: receipt.threadId }),
    commandType: receipt.commandType,
    acceptedAt: DateTime.formatIso(receipt.acceptedAt),
    resultSequence: receipt.resultSequence,
    status: receipt.status,
    error: receipt.error,
  };
}

const layerBase: Layer.Layer<
  CommandReceiptStoreV2,
  never,
  OrchestrationCommandReceipts.OrchestrationCommandReceiptRepository
> = Layer.effect(
  CommandReceiptStoreV2,
  Effect.gen(function* () {
    const receipts = yield* OrchestrationCommandReceipts.OrchestrationCommandReceiptRepository;

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
      getProjectByCommandId: (commandId) =>
        receipts.getByCommandId({ commandId }).pipe(
          Effect.flatMap((receipt) =>
            Option.isNone(receipt) || receipt.value.aggregateKind !== "project"
              ? Effect.succeed(Option.none())
              : decodeProjectReceipt({
                  commandId: receipt.value.commandId,
                  projectId: receipt.value.aggregateId,
                  commandType: receipt.value.commandType,
                  acceptedAt: receipt.value.acceptedAt,
                  resultSequence: receipt.value.resultSequence,
                  status: receipt.value.status,
                  error: receipt.value.error,
                }).pipe(Effect.map(Option.some)),
          ),
          Effect.mapError((cause) => new CommandReceiptStoreReadError({ commandId, cause })),
        ),
    } satisfies CommandReceiptStoreV2Shape);
  }),
);

export const layer = layerBase.pipe(Layer.provide(OrchestrationCommandReceipts.layer));

export const layerFromApplicationReceipts = layerBase;
