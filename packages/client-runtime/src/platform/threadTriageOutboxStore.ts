import { CommandId, EnvironmentId, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

export const PendingThreadTriage = Schema.Struct({
  environmentId: EnvironmentId,
  threadId: ThreadId,
  commandId: CommandId,
  action: Schema.Union([
    Schema.Struct({ type: Schema.Literal("settle") }),
    Schema.Struct({ type: Schema.Literal("snooze"), snoozedUntil: Schema.String }),
  ]),
  queuedAt: Schema.DateTimeUtcFromString,
  /** The thread as the user saw it; if it shows otherwise on reconnect, the change is dropped. */
  seen: Schema.String,
  /** Set before the first send and never cleared: the server may have it, so only it can undo. */
  attempted: Schema.optionalKey(Schema.Literal(true)),
});
export type PendingThreadTriage = typeof PendingThreadTriage.Type;
export type PendingThreadTriages = ReadonlyArray<PendingThreadTriage>;

const Stored = Schema.fromJsonString(Schema.Struct({ entries: Schema.Array(PendingThreadTriage) }));
const decodeStored = Schema.decodeUnknownExit(Stored);
const encodeStored = Schema.encodeSync(Stored);

export class ThreadTriageOutboxStorageError extends Schema.TaggedError<ThreadTriageOutboxStorageError>()(
  "ThreadTriageOutboxStorageError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Could not save the change for later sync.";
  }
}

/**
 * Settle and snooze taken while an environment is offline, kept apart from the environment
 * cache so clearing the cache does not drop them. Removing the environment does.
 */
export interface ThreadTriageOutboxStoreShape {
  /** Stores `change(stored)` in one step and returns it. Returning `stored` itself only reads. */
  readonly update: (
    change: (stored: PendingThreadTriages) => PendingThreadTriages,
  ) => Effect.Effect<PendingThreadTriages, ThreadTriageOutboxStorageError>;
  readonly clearEnvironment: (
    environmentId: EnvironmentId,
  ) => Effect.Effect<void, ThreadTriageOutboxStorageError>;
}

/**
 * `modify` replaces the stored text with `next(stored)`, or keeps it when that is null. Text that
 * no longer decodes reads as empty.
 */
export function makeThreadTriageOutboxStore(
  modify: (
    next: (stored: string | null) => string | null,
  ) => Effect.Effect<void, ThreadTriageOutboxStorageError>,
): ThreadTriageOutboxStoreShape {
  // Platforms whose `modify` reads and writes in separate steps rely on this to not interleave.
  const lock = Semaphore.makeUnsafe(1);
  const update: ThreadTriageOutboxStoreShape["update"] = (change) =>
    lock.withPermits(1)(
      Effect.suspend(() => {
        let result: PendingThreadTriages = [];
        return modify((raw) => {
          const decoded = raw === null ? undefined : decodeStored(raw);
          const stored =
            decoded !== undefined && Exit.isSuccess(decoded) ? decoded.value.entries : [];
          result = change(stored);
          return result === stored ? null : encodeStored({ entries: result });
        }).pipe(Effect.map(() => result));
      }),
    );
  return {
    update,
    clearEnvironment: (environmentId) =>
      update((stored) =>
        stored.some((entry) => entry.environmentId === environmentId)
          ? stored.filter((entry) => entry.environmentId !== environmentId)
          : stored,
      ).pipe(Effect.asVoid),
  };
}

export class ThreadTriageOutboxStore extends Context.Reference<ThreadTriageOutboxStoreShape>(
  "@t3tools/client-runtime/state/ThreadTriageOutboxStore",
  {
    defaultValue: () => {
      let value: string | null = null;
      return makeThreadTriageOutboxStore((next) =>
        Effect.sync(() => {
          value = next(value) ?? value;
        }),
      );
    },
  },
) {}
