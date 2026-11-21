import { CommandId, NonNegativeInt, ProjectId, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as OrchestrationCommandReceipts from "../persistence/OrchestrationCommandReceipts.ts";

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

class CommandReceiptStoreLifecycleError extends Schema.TaggedError<CommandReceiptStoreLifecycleError>()(
  "CommandReceiptStoreLifecycleError",
  { threadId: ThreadId, cause: Schema.Defect() },
) {
  override get message(): string {
    return `Failed to read orchestration V2 lifecycle receipt for thread ${this.threadId}.`;
  }
}

export const CommandReceiptStoreV2Error = Schema.Union([
  CommandReceiptStoreWriteError,
  CommandReceiptStoreReadError,
  CommandReceiptStoreLifecycleError,
]);
export type CommandReceiptStoreV2Error = typeof CommandReceiptStoreV2Error.Type;

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
  archiveSourceCommandId: Schema.optional(CommandId),
});
export type CommandReceiptV2 = typeof CommandReceiptV2.Type;

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

export type AnyCommandReceiptV2 = CommandReceiptV2 | ProjectCommandReceiptV2;

export interface CommandReceiptStoreV2Shape {
  readonly getLatestLifecycle: (
    threadId: ThreadId,
    commandTypes?: ReadonlyArray<OrchestrationCommandReceipts.LifecycleCommandType>,
  ) => Effect.Effect<CommandReceiptV2 | null, CommandReceiptStoreV2Error>;
  readonly insertIfAbsent: (
    receipt: AnyCommandReceiptV2,
  ) => Effect.Effect<boolean, CommandReceiptStoreV2Error>;
  readonly upsert: (
    receipt: AnyCommandReceiptV2,
  ) => Effect.Effect<void, CommandReceiptStoreV2Error>;
  readonly getAnyByCommandId: (
    commandId: CommandId,
  ) => Effect.Effect<Option.Option<AnyCommandReceiptV2>, CommandReceiptStoreV2Error>;
  /** None for project command ids. */
  readonly getByCommandId: (
    commandId: CommandId,
  ) => Effect.Effect<Option.Option<CommandReceiptV2>, CommandReceiptStoreV2Error>;
  /** None for thread command ids. */
  readonly getProjectByCommandId: (
    commandId: CommandId,
  ) => Effect.Effect<Option.Option<ProjectCommandReceiptV2>, CommandReceiptStoreV2Error>;
}

export class CommandReceiptStoreV2 extends Context.Service<
  CommandReceiptStoreV2,
  CommandReceiptStoreV2Shape
>()("t3/orchestration-v2/CommandReceiptStore/CommandReceiptStoreV2") {}

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
    ...(receipt.archiveSourceCommandId == null
      ? {}
      : { archiveSourceCommandId: receipt.archiveSourceCommandId }),
  });
}

function fromProjectApplicationReceipt(
  receipt: OrchestrationCommandReceipts.OrchestrationCommandReceipt,
) {
  return decodeProjectReceipt({
    commandId: receipt.commandId,
    projectId: receipt.aggregateId,
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
      : {
          aggregateKind: "thread" as const,
          aggregateId: receipt.threadId,
          archiveSourceCommandId: receipt.archiveSourceCommandId,
        }),
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
      getLatestLifecycle: Effect.fn("CommandReceiptStore.getLatestLifecycle")(
        (threadId, commandTypes) =>
          receipts.getLatestLifecycle({ threadId, commandTypes }).pipe(
            Effect.flatMap((receipt) =>
              Option.isSome(receipt) ? fromApplicationReceipt(receipt.value) : Effect.succeed(null),
            ),
            Effect.mapError((cause) => new CommandReceiptStoreLifecycleError({ threadId, cause })),
          ),
      ),
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
      getAnyByCommandId: Effect.fn("CommandReceiptStore.getAnyByCommandId")((commandId) =>
        receipts.getByCommandId({ commandId }).pipe(
          Effect.flatMap((receipt) => {
            if (Option.isNone(receipt)) return Effect.succeedNone;
            const decode: Effect.Effect<AnyCommandReceiptV2, Schema.SchemaError> =
              receipt.value.aggregateKind === "project"
                ? fromProjectApplicationReceipt(receipt.value)
                : fromApplicationReceipt(receipt.value);
            return decode.pipe(Effect.asSome);
          }),
          Effect.mapError((cause) => new CommandReceiptStoreReadError({ commandId, cause })),
        ),
      ),
      getByCommandId: (commandId) =>
        receipts.getByCommandId({ commandId }).pipe(
          Effect.flatMap(
            Option.match({
              onNone: () => Effect.succeedNone,
              onSome: (receipt) =>
                receipt.aggregateKind !== "thread"
                  ? Effect.succeedNone
                  : fromApplicationReceipt(receipt).pipe(Effect.asSome),
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
              ? Effect.succeedNone
              : fromProjectApplicationReceipt(receipt.value).pipe(Effect.asSome),
          ),
          Effect.mapError((cause) => new CommandReceiptStoreReadError({ commandId, cause })),
        ),
    } satisfies CommandReceiptStoreV2Shape);
  }),
);

export const layer = layerBase.pipe(Layer.provide(OrchestrationCommandReceipts.layer));

export const layerFromApplicationReceipts = layerBase;

export const cascadeCommandIdLimit = 32;

export const cascadeCommandIdAt = (base: CommandId, retry: number) =>
  retry === 0 ? base : CommandId.make(`${base}:retry:${retry}`);

/** Older receipts encode cascade ownership in the command ID. */
export const legacyCascadeCommandId = Effect.fn("CommandReceiptStore.cascadeCommandId")(function* (
  receipts: CommandReceiptStoreV2Shape,
  base: CommandId,
) {
  for (let retry = 0; retry < cascadeCommandIdLimit; retry++) {
    const id = cascadeCommandIdAt(base, retry);
    const receipt = yield* receipts.getByCommandId(id);
    if (Option.isNone(receipt) || receipt.value.status === "accepted") return id;
  }
  return undefined;
});

export const matchesLegacyCascadePath = Effect.fn("CommandReceiptStore.matchesLegacyCascadePath")(
  function* (
    receipts: CommandReceiptStoreV2Shape,
    anchorId: CommandId,
    path: ReadonlyArray<ThreadId>,
    completedId: CommandId,
  ) {
    const retries: Array<{ baseId: CommandId; retry: number }> = [];
    let id: string = completedId;
    for (const threadId of path.toReversed()) {
      const segment = `:subagent:${threadId}`;
      if (!id.endsWith(segment)) {
        const suffix = /:retry:([1-9][0-9]*)$/.exec(id);
        if (suffix === null) return false;
        const retry = Number(suffix[1]);
        if (retry >= cascadeCommandIdLimit) return false;
        id = id.slice(0, suffix.index);
        retries.push({ baseId: CommandId.make(id), retry });
      }
      if (!id.endsWith(segment)) return false;
      id = id.slice(0, -segment.length);
    }
    if (id !== anchorId) return false;

    // Legacy selection could only reach a suffix after rejecting every earlier ID.
    for (const { baseId, retry } of retries) {
      for (let previous = 0; previous < retry; previous++) {
        const receipt = yield* receipts.getByCommandId(cascadeCommandIdAt(baseId, previous));
        if (Option.isNone(receipt) || receipt.value.status !== "rejected") return false;
      }
    }
    return true;
  },
);

/** A lifecycle choice made after the cascade's source command, other than `ownCommandId`. */
export const supersedesCascade = (
  latest: CommandReceiptV2 | null,
  cutoff: number,
  ownCommandId?: CommandId,
) => latest !== null && latest.resultSequence > cutoff && latest.commandId !== ownCommandId;

/** Whether a cascade from an archive of `rootThreadId`, along `path`, archived this thread. */
export const archivedByCascade = Effect.fn("CommandReceiptStore.archivedByCascade")(function* (
  receipts: CommandReceiptStoreV2Shape,
  latest: CommandReceiptV2 | null,
  rootThreadId: ThreadId,
  path: ReadonlyArray<ThreadId>,
  expectedArchiveCommandId?: CommandId,
) {
  if (latest?.commandType !== "thread.archive") return false;
  let archive = latest;
  let depth = path.length;
  while (depth > 0 && archive.archiveSourceCommandId !== undefined) {
    if (archive.archiveSourceCommandId === archive.commandId) return false;
    const source = Option.getOrUndefined(
      yield* receipts.getByCommandId(archive.archiveSourceCommandId),
    );
    if (
      source?.status !== "accepted" ||
      source.commandType !== "thread.archive" ||
      source.resultSequence > archive.resultSequence
    )
      return false;
    // A cascade can pass through an already archived thread without claiming its archive.
    const ancestor =
      source.threadId === rootThreadId
        ? 0
        : depth < 2
          ? -1
          : path.lastIndexOf(source.threadId, depth - 2) + 1;
    if (ancestor <= 0 && source.threadId !== rootThreadId) return false;
    depth = ancestor;
    archive = source;
  }
  if (depth === 0)
    return expectedArchiveCommandId === undefined || archive.commandId === expectedArchiveCommandId;

  const legacyPath = path.slice(0, depth);
  let rootCommandId: string = archive.commandId;
  for (const threadId of legacyPath.toReversed()) {
    const segment = `:subagent:${threadId}`;
    if (!rootCommandId.endsWith(segment)) rootCommandId = rootCommandId.replace(/:retry:\d+$/, "");
    if (!rootCommandId.endsWith(segment)) return false;
    rootCommandId = rootCommandId.slice(0, -segment.length);
  }
  if (expectedArchiveCommandId !== undefined && rootCommandId !== expectedArchiveCommandId)
    return false;
  const root = Option.getOrNull(yield* receipts.getByCommandId(CommandId.make(rootCommandId)));
  const valid = root?.status === "accepted" && root.threadId === rootThreadId;
  // Derive the IDs again, so a user ID only shaped like a cascade retry is not counted.
  let derived = valid && root.commandType === "thread.archive" ? root.commandId : undefined;
  for (const threadId of legacyPath) {
    if (derived === undefined) return false;
    derived = yield* legacyCascadeCommandId(
      receipts,
      CommandId.make(`${derived}:subagent:${threadId}`),
    );
  }
  return derived === archive.commandId && (root?.resultSequence ?? 0) <= archive.resultSequence;
});
