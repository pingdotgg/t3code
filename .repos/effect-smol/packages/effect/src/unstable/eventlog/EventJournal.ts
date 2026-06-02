/**
 * Persistence boundary for unstable event-log entries and replication state.
 *
 * `EventJournal` stores committed entries, exposes them for replay, publishes
 * local changes, and records the remote metadata needed to exchange entries
 * with other journals. Higher-level event-log schemas and handlers build on
 * this service when rebuilding projections, syncing offline clients, importing
 * remote changes, or coordinating writes per store.
 *
 * **Mental model**
 *
 * A local write creates a UUID v7 entry id, runs the caller-provided effect,
 * and commits the entry only when that effect succeeds. Remote writes first
 * split duplicate entries from new entries, optionally compact the new remote
 * history, run replay effects with conflict entries, and then persist the
 * imported entries. Remote metadata tracks the last known sequence number and
 * which local entries each remote still needs.
 *
 * **Common tasks**
 *
 * Use `entries` to replay the full journal, `changes` to subscribe to local
 * writes, `writeFromRemote` to import replicated entries, and
 * `withRemoteUncommited` to send entries a remote has not yet acknowledged. Use
 * `withLock` when multiple event-log operations must serialize work for the
 * same store id.
 *
 * **Gotchas**
 *
 * Entry ordering comes from UUID v7 timestamps, so conflict detection is tied
 * to clock-derived ids. Payloads are opaque encoded bytes and must remain
 * compatible with the schemas that decode historical entries. Remote imports
 * can include duplicates, and replay handlers should expect entries that arrive
 * after local changes for the same event and primary key.
 *
 * @since 4.0.0
 */
import * as Uuid from "uuid"
import type { Brand } from "../../Brand.ts"
import * as Context from "../../Context.ts"
import * as Data from "../../Data.ts"
import * as DateTime from "../../DateTime.ts"
import * as Effect from "../../Effect.ts"
import * as Layer from "../../Layer.ts"
import * as Order from "../../Order.ts"
import * as PubSub from "../../PubSub.ts"
import * as Schema from "../../Schema.ts"
import type { Scope } from "../../Scope.ts"
import * as Semaphore from "../../Semaphore.ts"
import * as Msgpack from "../encoding/Msgpack.ts"
import type { StoreId } from "./EventLogMessage.ts"

/**
 * Context service for storing and replaying event journal entries.
 *
 * **Details**
 *
 * The service writes local entries, imports entries from remote journals, exposes
 * a stream of local changes, and provides per-store locking.
 *
 * @category context
 * @since 4.0.0
 */
export class EventJournal extends Context.Service<EventJournal, {
  /**
   * Read all the entries in the journal.
   */
  readonly entries: Effect.Effect<ReadonlyArray<Entry>, EventJournalError>

  /**
   * Write an event to the journal, performing an effect before committing the
   * event.
   */
  readonly write: <A, E, R>(options: {
    readonly event: string
    readonly primaryKey: string
    readonly payload: Uint8Array
    readonly effect: (entry: Entry) => Effect.Effect<A, E, R>
  }) => Effect.Effect<A, EventJournalError | E, R>

  /**
   * Write events from a remote source to the journal.
   *
   * **Details**
   *
   * Effects run sequentially in compaction bracket order.
   */
  readonly writeFromRemote: (
    options: {
      readonly remoteId: RemoteId
      readonly entries: ReadonlyArray<RemoteEntry>
      readonly compact?:
        | ((uncommitted: ReadonlyArray<RemoteEntry>) => Effect.Effect<ReadonlyArray<Entry>, EventJournalError>)
        | undefined
      readonly effect: (options: {
        readonly entry: Entry
        readonly conflicts: ReadonlyArray<Entry>
      }) => Effect.Effect<void, EventJournalError>
    }
  ) => Effect.Effect<{
    readonly duplicateEntries: ReadonlyArray<Entry>
  }, EventJournalError>

  /**
   * Return the uncommitted entries for a remote source.
   */
  readonly withRemoteUncommited: <A, E, R>(
    remoteId: RemoteId,
    f: (entries: ReadonlyArray<Entry>) => Effect.Effect<A, E, R>
  ) => Effect.Effect<A, EventJournalError | E, R>

  /**
   * Retrieve the last known sequence number for a remote source.
   */
  readonly nextRemoteSequence: (remoteId: RemoteId) => Effect.Effect<number, EventJournalError>

  /**
   * The entries added to the local journal.
   */
  readonly changes: Effect.Effect<PubSub.Subscription<Entry>, never, Scope>

  /**
   * Remove all data
   */
  readonly destroy: Effect.Effect<void, EventJournalError>

  /**
   * Run an effect with a lock on the journal.
   */
  readonly withLock: (storeId: StoreId) => <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>
}>()("effect/eventlog/EventJournal") {}

const TypeId = "effect/eventlog/EventJournal/EventJournalError" as const

/**
 * Error raised by event journal operations.
 *
 * **Details**
 *
 * The error records the journal method that failed and the underlying cause.
 *
 * @category errors
 * @since 4.0.0
 */
export class EventJournalError extends Data.TaggedError("EventJournalError")<{
  readonly method: string
  readonly cause: unknown
}> {
  /**
   * Marks this value as an event journal error for runtime guards.
   *
   * @since 4.0.0
   */
  readonly [TypeId] = TypeId
}

/**
 * Brand identifier used for `RemoteId` values.
 *
 * @category type IDs
 * @since 4.0.0
 */
export type RemoteIdTypeId = "effect/eventlog/EventJournal/RemoteId"

/**
 * Runtime brand identifier used for `RemoteId` values.
 *
 * @category type IDs
 * @since 4.0.0
 */
export const RemoteIdTypeId: RemoteIdTypeId = "effect/eventlog/EventJournal/RemoteId"

/**
 * Branded byte identifier for a remote event journal source.
 *
 * @category remote
 * @since 4.0.0
 */
export type RemoteId = Uint8Array & Brand<RemoteIdTypeId>

/**
 * Schema for branded remote event journal identifiers.
 *
 * @category remote
 * @since 4.0.0
 */
export const RemoteId = Schema.Uint8Array.pipe(Schema.brand(RemoteIdTypeId))

/**
 * Generates a new random `RemoteId`.
 *
 * **Gotchas**
 *
 * This is unsafe because the generated UUID bytes are cast to the brand without
 * schema validation.
 *
 * @category remote
 * @since 4.0.0
 */
export const makeRemoteIdUnsafe = (): RemoteId => Uuid.v4({}, new globalThis.Uint8Array(16)) as RemoteId

/**
 * Runtime brand identifier used for `EntryId` values.
 *
 * @category type IDs
 * @since 4.0.0
 */
export const EntryIdTypeId: EntryIdTypeId = "effect/eventlog/EventJournal/EntryId"

/**
 * Brand identifier used for `EntryId` values.
 *
 * @category type IDs
 * @since 4.0.0
 */
export type EntryIdTypeId = "effect/eventlog/EventJournal/EntryId"

/**
 * Branded byte identifier for an event journal entry.
 *
 * @category entry
 * @since 4.0.0
 */
export type EntryId = Uint8Array<ArrayBuffer> & Brand<EntryIdTypeId>

/**
 * Schema for branded event journal entry identifiers.
 *
 * @category entry
 * @since 4.0.0
 */
export const EntryId = (Schema.Uint8Array as Schema.instanceOf<Uint8Array<ArrayBuffer>>).pipe(
  Schema.brand(EntryIdTypeId)
)

/**
 * Provides an Ordering instance for entry identifiers based on their raw UUID bytes.
 *
 * @category entry
 * @since 4.0.0
 */
export const EntryIdOrder = Order.make<EntryId>((a, b) => {
  for (let i = 0; i < 16; i++) {
    if (a[i] !== b[i]) {
      return (a[i] - b[i]) < 0 ? -1 : 1
    }
  }
  return 0
})

/**
 * Generates a UUID v7 `EntryId`, optionally using the supplied millisecond
 * timestamp.
 *
 * **Gotchas**
 *
 * This is unsafe because the generated UUID bytes are cast to the brand without
 * schema validation.
 *
 * @category entry
 * @since 4.0.0
 */
export const makeEntryIdUnsafe = (options: { msecs?: number } = {}): EntryId =>
  Uuid.v7(options, new globalThis.Uint8Array(16)) as EntryId

/**
 * Extracts the millisecond timestamp encoded in a UUID v7 `EntryId`.
 *
 * @category entry
 * @since 4.0.0
 */
export const entryIdMillis = (entryId: EntryId): number => {
  const bytes = new Uint8Array(8)
  bytes.set(entryId.subarray(0, 6), 2)
  return Number(new DataView(bytes.buffer).getBigUint64(0))
}

/**
 * Schema for a committed event journal entry.
 *
 * **Details**
 *
 * An entry records its ID, event tag, primary key, and MessagePack-encoded
 * payload, with helpers for array MessagePack encoding and creation timestamps.
 *
 * @category entry
 * @since 4.0.0
 */
export class Entry extends Schema.Class<Entry>("effect/eventlog/EventJournal/Entry")({
  id: EntryId,
  event: Schema.String,
  primaryKey: Schema.String,
  payload: Schema.Uint8Array
}) {
  /**
   * MessagePack schema for arrays of committed event journal entries.
   *
   * @since 4.0.0
   */
  static arrayMsgpack = Schema.Array(Msgpack.schema(Entry))

  /**
   * Encodes arrays of committed entries with the MessagePack entry schema.
   *
   * @since 4.0.0
   */
  static encodeArray = Schema.encodeUnknownEffect(Entry.arrayMsgpack)

  /**
   * Decodes arrays of committed entries with the MessagePack entry schema.
   *
   * @since 4.0.0
   */
  static decodeArray = Schema.decodeUnknownEffect(Entry.arrayMsgpack)

  /**
   * Ordering for committed entries by their event journal entry id.
   *
   * @since 4.0.0
   */
  static Order = Order.make<Entry>((a, b) => EntryIdOrder(a.id, b.id))

  /**
   * String representation of the entry id.
   *
   * @since 4.0.0
   */
  get idString(): string {
    return Uuid.stringify(this.id)
  }

  /**
   * Creation timestamp encoded in the UUID v7 entry id, in epoch milliseconds.
   *
   * @since 4.0.0
   */
  get createdAtMillis(): number {
    return entryIdMillis(this.id)
  }

  /**
   * Creation timestamp encoded in the UUID v7 entry id, as a UTC date-time.
   *
   * @since 4.0.0
   */
  get createdAt(): DateTime.Utc {
    return DateTime.makeUnsafe(this.createdAtMillis)
  }
}

/**
 * Schema for an event journal entry received from a remote source.
 *
 * **Details**
 *
 * It pairs the remote sequence number with the journal entry payload.
 *
 * @category entry
 * @since 4.0.0
 */
export class RemoteEntry extends Schema.Class<RemoteEntry>("effect/eventlog/EventJournal/RemoteEntry")({
  remoteSequence: Schema.Number,
  entry: Entry
}) {}

/**
 * Creates an in-memory `EventJournal` service.
 *
 * **Gotchas**
 *
 * Entries, remote tracking state, and locks live only in the current process and
 * are lost when the service is discarded.
 *
 * @category memory
 * @since 4.0.0
 */
export const makeMemory: Effect.Effect<EventJournal["Service"]> = Effect.gen(function*() {
  const journal: Array<Entry> = []
  const byId = new Map<string, Entry>()
  const remotes = new Map<string, { sequence: number; missing: Array<Entry> }>()
  const pubsub = yield* PubSub.unbounded<Entry>()
  const storeSemaphores = new Map<StoreId, Semaphore.Semaphore>()
  const withLock = (storeId: StoreId) => {
    let semaphore = storeSemaphores.get(storeId)
    if (!semaphore) {
      semaphore = Semaphore.makeUnsafe(1)
      storeSemaphores.set(storeId, semaphore)
    }
    return semaphore.withPermit
  }

  const ensureRemote = (remoteId: RemoteId) => {
    const remoteIdString = Uuid.stringify(remoteId)
    const remote = remotes.get(remoteIdString)
    if (remote) return remote
    const created = { sequence: 0, missing: journal.slice() }
    remotes.set(remoteIdString, created)
    return created
  }

  return EventJournal.of({
    entries: Effect.sync(() => journal.slice()),
    write({ effect, event, payload, primaryKey }) {
      return Effect.acquireUseRelease(
        Effect.sync(() =>
          new Entry({
            id: makeEntryIdUnsafe(),
            event,
            primaryKey,
            payload
          }, { disableChecks: true })
        ),
        effect,
        (entry, exit) =>
          Effect.suspend(() => {
            if (exit._tag === "Failure" || byId.has(entry.idString)) return Effect.void
            journal.push(entry)
            byId.set(entry.idString, entry)
            remotes.forEach((remote) => {
              remote.missing.push(entry)
            })
            return PubSub.publish(pubsub, entry)
          })
      )
    },
    writeFromRemote: Effect.fnUntraced(function*(options) {
      const remote = ensureRemote(options.remoteId)
      const uncommittedRemotes: Array<RemoteEntry> = []
      const uncommitted: Array<Entry> = []
      const duplicateEntries: Array<Entry> = []
      for (const remoteEntry of options.entries) {
        if (byId.has(remoteEntry.entry.idString)) {
          duplicateEntries.push(remoteEntry.entry)
          if (remoteEntry.remoteSequence > remote.sequence) {
            remote.sequence = remoteEntry.remoteSequence
          }
          continue
        }
        uncommittedRemotes.push(remoteEntry)
        uncommitted.push(remoteEntry.entry)
      }

      const compacted = options.compact
        ? yield* options.compact(uncommittedRemotes)
        : uncommitted

      for (const originEntry of compacted) {
        const entryMillis = entryIdMillis(originEntry.id)
        const conflicts: Array<Entry> = []
        for (let i = journal.length - 1; i >= -1; i--) {
          const entry = journal[i]
          if (entry !== undefined && entry.createdAtMillis > entryMillis) {
            continue
          }
          for (let j = i + 2; j < journal.length; j++) {
            const scannedEntry = journal[j]!
            if (scannedEntry.event === originEntry.event && scannedEntry.primaryKey === originEntry.primaryKey) {
              conflicts.push(scannedEntry)
            }
          }
          yield* options.effect({ entry: originEntry, conflicts })
          break
        }
      }
      for (const remoteEntry of uncommittedRemotes) {
        journal.push(remoteEntry.entry)
        byId.set(remoteEntry.entry.idString, remoteEntry.entry)
        if (remoteEntry.remoteSequence > remote.sequence) {
          remote.sequence = remoteEntry.remoteSequence
        }
      }
      journal.sort((a, b) => a.createdAtMillis - b.createdAtMillis)
      return {
        duplicateEntries
      }
    }),
    withRemoteUncommited: (remoteId, f) =>
      Effect.acquireUseRelease(
        Effect.sync(() => ensureRemote(remoteId).missing.slice()),
        f,
        (entries, exit) =>
          Effect.sync(() => {
            if (exit._tag === "Failure") return
            const last = entries[entries.length - 1]
            if (!last) return
            const remote = ensureRemote(remoteId)
            for (let i = remote.missing.length - 1; i >= 0; i--) {
              if (remote.missing[i].id === last.id) {
                remote.missing = remote.missing.slice(i + 1)
                break
              }
            }
          })
      ),
    nextRemoteSequence: (remoteId) => Effect.sync(() => ensureRemote(remoteId).sequence),
    changes: PubSub.subscribe(pubsub),
    destroy: Effect.sync(() => {
      journal.length = 0
      byId.clear()
      remotes.clear()
    }),
    withLock
  })
})

/**
 * Layer that provides an in-memory `EventJournal`.
 *
 * **Gotchas**
 *
 * All journal data is stored in process memory and is not persisted across layer
 * lifetimes.
 *
 * @category memory
 * @since 4.0.0
 */
export const layerMemory: Layer.Layer<EventJournal> = Layer.effect(EventJournal, makeMemory)

/**
 * Creates an `EventJournal` backed by IndexedDB.
 *
 * **Details**
 *
 * The journal stores entries and remote replication metadata in the configured
 * browser database, publishes local changes, and requires `Scope` so the database
 * connection can be closed when the scope ends.
 *
 * @category indexed db
 * @since 4.0.0
 */
export const makeIndexedDb = (options?: {
  readonly database?: string
}): Effect.Effect<EventJournal["Service"], EventJournalError, Scope> =>
  Effect.gen(function*() {
    const database = options?.database ?? "effect_event_journal"
    const openRequest = indexedDB.open(database, 1)
    openRequest.onupgradeneeded = () => {
      const db = openRequest.result

      const entries = db.createObjectStore("entries", { keyPath: "id" })
      entries.createIndex("id", "id", { unique: true })
      entries.createIndex("event", "event")

      const remotes = db.createObjectStore("remotes", { keyPath: ["remoteId", "entryId"] })
      remotes.createIndex("id", ["remoteId", "entryId"], { unique: true })
      remotes.createIndex("sequence", ["remoteId", "sequence"], { unique: true })

      const remoteEntryId = db.createObjectStore("remoteEntryId", { keyPath: ["remoteId"] })
      remoteEntryId.createIndex("id", "remoteId", { unique: true })
    }

    const db = yield* Effect.acquireRelease(
      idbReq("open", () => openRequest),
      (db) => Effect.sync(() => db.close())
    )

    const pubsub = yield* PubSub.unbounded<Entry>()

    return EventJournal.of({
      entries: idbReq("entries", () =>
        db.transaction("entries", "readonly")
          .objectStore("entries")
          .index("id")
          .getAll()).pipe(
          Effect.flatMap((_) =>
            decodeEntryIdbArray(_).pipe(
              Effect.mapError((cause) => new EventJournalError({ method: "entries", cause }))
            )
          )
        ),
      write: ({ effect, event, payload, primaryKey }) =>
        Effect.uninterruptibleMask((restore) => {
          const entry = new Entry({
            id: makeEntryIdUnsafe(),
            event,
            primaryKey,
            payload
          }, { disableChecks: true })
          return restore(effect(entry)).pipe(
            Effect.tap(
              idbReq("write", () =>
                db.transaction("entries", "readwrite")
                  .objectStore("entries")
                  .put(encodeEntryIdb(entry)))
            ),
            Effect.tap(PubSub.publish(pubsub, entry))
          )
        }),
      writeFromRemote: Effect.fnUntraced(function*(options) {
        const uncommitted: Array<Entry> = []
        const uncommittedRemotes: Array<RemoteEntry> = []
        const duplicateEntries: Array<Entry> = []

        yield* Effect.callback<void, EventJournalError>((resume) => {
          const tx = db.transaction(["entries", "remotes"], "readwrite")
          const entries = tx.objectStore("entries")
          const remotes = tx.objectStore("remotes")
          const iterator = options.entries[Symbol.iterator]()
          const handleNext = (state: IteratorResult<RemoteEntry, void>) => {
            if (state.done) return
            const remoteEntry = state.value
            const entry = remoteEntry.entry
            const entryIdKey = entry.id as IDBValidKey
            entries.get(entryIdKey).onsuccess = (event) => {
              if (event.target && "result" in event.target && event.target.result) {
                duplicateEntries.push(entry)
                remotes.put({
                  remoteId: options.remoteId,
                  entryId: entry.id,
                  sequence: remoteEntry.remoteSequence
                })
                handleNext(iterator.next())
                return
              }
              uncommitted.push(entry)
              uncommittedRemotes.push(remoteEntry)
              handleNext(iterator.next())
            }
          }
          handleNext(iterator.next())
          tx.oncomplete = () => resume(Effect.void)
          tx.onerror = () => resume(Effect.fail(new EventJournalError({ method: "writeFromRemote", cause: tx.error })))
          return Effect.sync(() => tx.abort())
        })

        const compacted = options.compact
          ? yield* options.compact(uncommittedRemotes)
          : uncommitted

        for (const originEntry of compacted) {
          const conflicts: Array<Entry> = []
          yield* Effect.callback<void, EventJournalError>((resume) => {
            const tx = db.transaction("entries", "readonly")
            const entries = tx.objectStore("entries")
            const cursorRequest = entries.index("id").openCursor(
              IDBKeyRange.lowerBound(originEntry.id as IDBValidKey, true),
              "next"
            )
            cursorRequest.onsuccess = () => {
              const cursor = cursorRequest.result
              if (!cursor) return
              const decodedEntry = decodeEntryIdb(cursor.value)
              if (
                decodedEntry.event === originEntry.event &&
                decodedEntry.primaryKey === originEntry.primaryKey
              ) {
                conflicts.push(decodedEntry)
              }
              cursor.continue()
            }
            tx.oncomplete = () => resume(Effect.void)
            tx.onerror = () =>
              resume(Effect.fail(new EventJournalError({ method: "writeFromRemote", cause: tx.error })))
            return Effect.sync(() => tx.abort())
          })

          yield* options.effect({ entry: originEntry, conflicts })
        }

        yield* Effect.callback<void, EventJournalError>((resume) => {
          const tx = db.transaction(["entries", "remotes"], "readwrite")
          const entries = tx.objectStore("entries")
          const remotes = tx.objectStore("remotes")
          for (const remoteEntry of uncommittedRemotes) {
            entries.add(encodeEntryIdb(remoteEntry.entry))
            remotes.put({
              remoteId: options.remoteId,
              entryId: remoteEntry.entry.id,
              sequence: remoteEntry.remoteSequence
            })
          }
          tx.oncomplete = () => resume(Effect.void)
          tx.onerror = () => resume(Effect.fail(new EventJournalError({ method: "writeFromRemote", cause: tx.error })))
          return Effect.sync(() => tx.abort())
        })
        return {
          duplicateEntries
        }
      }),
      withRemoteUncommited: (remoteId, f) =>
        Effect.callback<ReadonlyArray<Entry>, EventJournalError>((resume) => {
          const entries: Array<Entry> = []
          const tx = db.transaction(["entries", "remotes", "remoteEntryId"], "readwrite")

          const entriesStore = tx.objectStore("entries")
          const remotesStore = tx.objectStore("remotes")
          const remoteEntryIdStore = tx.objectStore("remoteEntryId")

          const remoteIdKey = remoteId as IDBValidKey
          const request = remoteEntryIdStore.get(remoteIdKey) as IDBRequest<{ entryId: IDBValidKey } | undefined>
          request.onsuccess = () => {
            const startEntryId = request.result?.entryId
            const entryCursor = entriesStore.index("id").openCursor(
              startEntryId ? IDBKeyRange.lowerBound(startEntryId, true) : null,
              "next"
            )
            entryCursor.onsuccess = () => {
              const cursor = entryCursor.result
              if (!cursor) return
              const entry = decodeEntryIdb(cursor.value)
              remotesStore.get([remoteIdKey, entry.id as IDBValidKey]).onsuccess = (event) => {
                if (!(event.target && "result" in event.target && event.target.result)) entries.push(entry)
                cursor.continue()
              }
            }
          }

          tx.oncomplete = () => resume(Effect.succeed(entries))
          tx.onerror = () =>
            resume(Effect.fail(new EventJournalError({ method: "withRemoteUncommited", cause: tx.error })))
          return Effect.sync(() => tx.abort())
        }).pipe(
          Effect.flatMap((entries) => {
            if (entries.length === 0) return f(entries)
            const entryId = entries[entries.length - 1].id
            return Effect.uninterruptibleMask((restore) =>
              restore(f(entries)).pipe(
                Effect.tap(
                  idbReq("withRemoteUncommited", () =>
                    db.transaction("remoteEntryId", "readwrite").objectStore("remoteEntryId").put({
                      remoteId,
                      entryId
                    }))
                )
              )
            )
          })
        ),
      nextRemoteSequence: (remoteId) =>
        Effect.callback<number, EventJournalError>((resume) => {
          const tx = db.transaction("remotes", "readonly")
          let sequence = 0
          const remoteIdKey = remoteId as IDBValidKey
          const cursorRequest = tx.objectStore("remotes").index("sequence").openCursor(
            IDBKeyRange.bound([remoteIdKey, 0], [remoteIdKey, Infinity]),
            "prev"
          )
          cursorRequest.onsuccess = () => {
            const cursor = cursorRequest.result
            if (!cursor) return
            sequence = cursor.value.sequence + 1
          }
          tx.oncomplete = () => resume(Effect.succeed(sequence))
          tx.onerror = () =>
            resume(Effect.fail(new EventJournalError({ method: "nextRemoteSequence", cause: tx.error })))
          return Effect.sync(() => tx.abort())
        }),
      changes: PubSub.subscribe(pubsub),
      destroy: Effect.sync(() => {
        indexedDB.deleteDatabase(database)
      }),
      withLock: yield* makeBrowserWithLock(database)
    })
  })

const makeBrowserWithLock = Effect.fnUntraced(function*(key: string) {
  if (typeof navigator !== "undefined" && "locks" in navigator) {
    return (storeId: StoreId) => <A, E, R>(self: Effect.Effect<A, E, R>) =>
      Effect.callback<A, E, R>((resume, signal) => {
        navigator.locks.request(`${key}/${storeId}`, { signal }, () =>
          new Promise<void>((resolve) => {
            resume(Effect.onExit(self, () => {
              resolve()
              return Effect.void
            }))
          })).catch((defect) => resume(Effect.die(defect)))
      })
  }
  const semaphores = new Map<StoreId, Semaphore.Semaphore>()
  return (storeId: StoreId) => {
    let semaphore = semaphores.get(storeId)
    if (!semaphore) {
      semaphore = Semaphore.makeUnsafe(1)
      semaphores.set(storeId, semaphore)
    }
    return semaphore.withPermit
  }
})

const decodeEntryIdb = Schema.decodeSync(Entry)
const encodeEntryIdb = Schema.encodeSync(Entry)
const EntryIdbArray = Schema.Array(Entry)
const decodeEntryIdbArray = Schema.decodeUnknownEffect(EntryIdbArray)

/**
 * Provides `EventJournal` using the IndexedDB-backed implementation created by
 * `makeIndexedDb`.
 *
 * @category indexed db
 * @since 4.0.0
 */
export const layerIndexedDb = (options?: {
  readonly database?: string
}): Layer.Layer<EventJournal, EventJournalError> =>
  Layer.effect(
    EventJournal,
    makeIndexedDb(options)
  )

const idbReq = <T>(method: string, evaluate: () => IDBRequest<T>) =>
  Effect.callback<T, EventJournalError>((resume) => {
    const request = evaluate()
    if (request.readyState === "done") {
      resume(Effect.succeed(request.result))
      return
    }
    request.onsuccess = () => resume(Effect.succeed(request.result))
    request.onerror = () => resume(Effect.fail(new EventJournalError({ method, cause: request.error })))
  })
