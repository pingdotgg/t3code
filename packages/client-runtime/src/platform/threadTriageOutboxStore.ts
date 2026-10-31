import { CommandId, EnvironmentId, NonNegativeInt, ThreadId } from "@t3tools/contracts";
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
  /** Shell sequence the action was taken against; the server rejects it after newer changes. */
  snapshotSequence: NonNegativeInt,
  /** Set before the first send and never cleared: the server may have it, so only it can undo. */
  attempted: Schema.optionalKey(Schema.Literal(true)),
});
export type PendingThreadTriage = typeof PendingThreadTriage.Type;

const ThreadTriageOutboxDocument = Schema.Struct({
  entries: Schema.Array(PendingThreadTriage),
  /** Environments whose last loaded session could change threads. */
  operableEnvironmentIds: Schema.Array(EnvironmentId),
});
export type ThreadTriageOutboxDocument = typeof ThreadTriageOutboxDocument.Type;

const EMPTY_DOCUMENT: ThreadTriageOutboxDocument = { entries: [], operableEnvironmentIds: [] };
const StoredDocument = Schema.fromJsonString(ThreadTriageOutboxDocument);
const decodeStored = Schema.decodeUnknownExit(StoredDocument);
const encodeStored = Schema.encodeSync(StoredDocument);

export class ThreadTriageOutboxStorageError extends Schema.TaggedError<ThreadTriageOutboxStorageError>()(
  "ThreadTriageOutboxStorageError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Could not save the change for later sync.";
  }
}

export type ThreadTriageKey = Pick<PendingThreadTriage, "environmentId" | "threadId">;

export const sameThreadTriage = (a: ThreadTriageKey, b: ThreadTriageKey) =>
  a.environmentId === b.environmentId && a.threadId === b.threadId;

/**
 * Settle and snooze taken while an environment is offline, kept apart from the environment
 * cache so clearing the cache does not drop them. Removing the environment does.
 */
export interface ThreadTriageOutboxStoreShape {
  readonly load: Effect.Effect<ThreadTriageOutboxDocument, ThreadTriageOutboxStorageError>;
  /**
   * Replaces any entry for the same thread, keeping its `attempted` mark. `stillCurrent` runs
   * inside the store's lock, after any earlier removal, so a write for a removed environment is
   * skipped.
   */
  readonly put: (
    entry: PendingThreadTriage,
    stillCurrent?: () => boolean,
  ) => Effect.Effect<void, ThreadTriageOutboxStorageError>;
  /** Only removes the entry if it still has this command id. */
  readonly remove: (
    entry: ThreadTriageKey & Pick<PendingThreadTriage, "commandId">,
  ) => Effect.Effect<void, ThreadTriageOutboxStorageError>;
  /**
   * Marks whatever is stored for the thread as sent and returns it, which may be another tab's
   * replacement. Returns nothing when the thread has no stored change.
   */
  readonly markAttempted: (
    key: ThreadTriageKey,
  ) => Effect.Effect<PendingThreadTriage | undefined, ThreadTriageOutboxStorageError>;
  /**
   * Removes the entry only if it still has this command id and was never sent. Otherwise it
   * reports whether the entry was sent or is gone, and leaves storage as it is.
   */
  readonly cancel: (
    entry: ThreadTriageKey & Pick<PendingThreadTriage, "commandId">,
  ) => Effect.Effect<"cancelled" | "attempted" | "gone", ThreadTriageOutboxStorageError>;
  readonly setOperable: (
    environmentId: EnvironmentId,
    operable: boolean,
    stillCurrent?: () => boolean,
  ) => Effect.Effect<void, ThreadTriageOutboxStorageError>;
  readonly clearEnvironment: (
    environmentId: EnvironmentId,
  ) => Effect.Effect<void, ThreadTriageOutboxStorageError>;
  /**
   * Lets in-memory copies drop a removed environment's entries; returns the unsubscribe.
   * Listeners run inside the store's lock, before any later write.
   */
  readonly subscribeCleared: (listener: (environmentId: EnvironmentId) => void) => () => void;
}

export class ThreadTriageOutboxStore extends Context.Reference<ThreadTriageOutboxStoreShape>(
  "@t3tools/client-runtime/state/ThreadTriageOutboxStore",
  {
    defaultValue: () => {
      let value: string | null = null;
      return makeThreadTriageOutboxStore({
        read: Effect.sync(() => value),
        modify: (next) =>
          Effect.try({
            try: () => {
              value = next(value) ?? value;
            },
            catch: (cause) => new ThreadTriageOutboxStorageError({ cause }),
          }),
      });
    },
  },
) {}

export function makeThreadTriageOutboxStore(storage: {
  readonly read: Effect.Effect<string | null, ThreadTriageOutboxStorageError>;
  /**
   * Replaces the stored value with `next(stored)`, or keeps it when that is null, in one step
   * that other processes sharing the storage, such as tabs, cannot interleave.
   */
  readonly modify: (
    next: (stored: string | null) => string | null,
  ) => Effect.Effect<void, ThreadTriageOutboxStorageError>;
}): ThreadTriageOutboxStoreShape {
  const lock = Semaphore.makeUnsafe(1);
  const clearedListeners = new Set<(environmentId: EnvironmentId) => void>();
  const parse = (raw: string | null) =>
    raw === null ? Exit.succeed(EMPTY_DOCUMENT) : decodeStored(raw);
  const discardUnreadable = (cause: unknown) =>
    Effect.logWarning("Discarding unreadable offline thread changes.", { cause: String(cause) });
  const load = storage.read.pipe(
    Effect.flatMap((raw) =>
      Exit.match(parse(raw), {
        onSuccess: Effect.succeed,
        onFailure: (cause) => discardUnreadable(cause).pipe(Effect.as(EMPTY_DOCUMENT)),
      }),
    ),
  );
  /** A null transform skips the write. `after` still runs inside the lock. */
  const update = (
    transform: (document: ThreadTriageOutboxDocument) => ThreadTriageOutboxDocument | null,
    after: Effect.Effect<void> = Effect.void,
  ) =>
    lock.withPermits(1)(
      Effect.suspend(() => {
        let parsed = parse(null);
        return storage
          .modify((raw) => {
            parsed = parse(raw);
            const next = transform(Exit.isSuccess(parsed) ? parsed.value : EMPTY_DOCUMENT);
            return next === null ? null : encodeStored(next);
          })
          .pipe(
            Effect.tap(() =>
              Exit.isFailure(parsed) ? discardUnreadable(parsed.cause) : Effect.void,
            ),
          );
      }).pipe(Effect.ensuring(after)),
    );
  const updateEntries = (
    transform: (entries: ReadonlyArray<PendingThreadTriage>) => ReadonlyArray<PendingThreadTriage>,
  ) => update((document) => ({ ...document, entries: transform(document.entries) }));
  return {
    load: lock.withPermits(1)(load),
    put: (entry, stillCurrent) =>
      Effect.suspend(() => {
        let blocked = false;
        return update((document) => {
          if (stillCurrent?.() === false) return null;
          const replaced = document.entries.find((current) => sameThreadTriage(current, entry));
          if (replaced?.action.type === "settle" && entry.action.type === "snooze") {
            blocked = true;
            return null;
          }
          return {
            ...document,
            entries: [
              ...document.entries.filter((current) => current !== replaced),
              // The replaced change may have reached the server, so the server must undo this one.
              replaced?.attempted === true ? { ...entry, attempted: true as const } : entry,
            ],
          };
        }).pipe(
          Effect.flatMap(() =>
            blocked
              ? Effect.fail(
                  new ThreadTriageOutboxStorageError({
                    cause: new Error("Undo the pending settle before snoozing while offline."),
                  }),
                )
              : Effect.void,
          ),
        );
      }),
    remove: (entry) =>
      updateEntries((entries) =>
        entries.filter(
          (current) => !sameThreadTriage(current, entry) || current.commandId !== entry.commandId,
        ),
      ),
    markAttempted: (key) =>
      Effect.suspend(() => {
        let marked: PendingThreadTriage | undefined;
        return update((document) => {
          const stored = document.entries.find((current) => sameThreadTriage(current, key));
          if (stored === undefined) return null;
          if (stored.attempted === true) {
            marked = stored;
            return null;
          }
          const next = { ...stored, attempted: true as const };
          marked = next;
          return {
            ...document,
            entries: document.entries.map((current) => (current === stored ? next : current)),
          };
        }).pipe(Effect.map(() => marked));
      }),
    cancel: (entry) =>
      Effect.suspend(() => {
        let outcome: "cancelled" | "attempted" | "gone" = "gone";
        return update((document) => {
          const stored = document.entries.find((current) => sameThreadTriage(current, entry));
          if (stored?.commandId !== entry.commandId) return null;
          if (stored.attempted === true) {
            outcome = "attempted";
            return null;
          }
          outcome = "cancelled";
          return { ...document, entries: document.entries.filter((current) => current !== stored) };
        }).pipe(Effect.map(() => outcome));
      }),
    setOperable: (environmentId, operable, stillCurrent) =>
      update((document) =>
        stillCurrent?.() === false
          ? null
          : {
              ...document,
              operableEnvironmentIds: [
                ...document.operableEnvironmentIds.filter((id) => id !== environmentId),
                ...(operable ? [environmentId] : []),
              ],
            },
      ),
    clearEnvironment: (environmentId) =>
      update(
        (document) => ({
          entries: document.entries.filter((entry) => entry.environmentId !== environmentId),
          operableEnvironmentIds: document.operableEnvironmentIds.filter(
            (id) => id !== environmentId,
          ),
        }),
        // The environment is gone even if storage failed, so memory must not replay it.
        Effect.sync(() => {
          for (const listener of clearedListeners) listener(environmentId);
        }),
      ),
    subscribeCleared: (listener) => {
      clearedListeners.add(listener);
      return () => clearedListeners.delete(listener);
    },
  };
}
