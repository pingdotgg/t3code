/**
 * Server-side RPC layers and storage contracts for encrypted event-log
 * replication.
 *
 * This module is used by encrypted `EventLogRemote` clients that need a remote
 * synchronization endpoint without exposing plaintext events to the server. The
 * server stores ciphertext, initialization vectors, entry ids, and remote
 * sequence numbers keyed by the client's public key and store id, then streams
 * encrypted changes back to clients so they can decrypt locally with their
 * identity private key material. This makes it suitable for offline-first
 * synchronization, multi-device replication, and hosted backends where the
 * transport or storage layer should not inspect event payloads.
 *
 * The server does not derive or hold encryption keys. It treats public keys as
 * log identities, persists one session authentication binding per public key,
 * and reuses the initialization vector supplied with each encrypted write
 * request for the entries in that batch. Persisted remote ids, session signing
 * key bindings, ciphertext, IVs, and sequence numbers are therefore part of the
 * encrypted replication protocol and should be kept stable by durable storage
 * implementations.
 *
 * @since 4.0.0
 */
import * as Uuid from "uuid"
import * as Arr from "../../Array.ts"
import * as Context from "../../Context.ts"
import * as Effect from "../../Effect.ts"
import * as Layer from "../../Layer.ts"
import * as PubSub from "../../PubSub.ts"
import * as RcMap from "../../RcMap.ts"
import * as Schema from "../../Schema.ts"
import type * as Scope from "../../Scope.ts"
import * as Stream from "../../Stream.ts"
import * as RpcServer from "../rpc/RpcServer.ts"
import * as Transferable from "../workers/Transferable.ts"
import { EntryId, makeRemoteIdUnsafe, type RemoteId } from "./EventJournal.ts"
import type { EncryptedRemoteEntry } from "./EventLogEncryption.ts"
import { ChangesRpc, EventLogProtocolError, EventLogRemoteRpcs, type StoreId, WriteEntries } from "./EventLogMessage.ts"
import * as EventLogServer from "./EventLogServer.ts"

/**
 * Provides RPC handlers for the encrypted event-log server.
 *
 * **Details**
 *
 * Incoming encrypted write payloads are decoded and persisted through `Storage`;
 * change streams read encrypted entries from storage and encode them for the
 * remote protocol.
 *
 * @category layers
 * @since 4.0.0
 */
export const layerRpcHandlers = Layer.unwrap(Effect.gen(function*() {
  const storage = yield* Storage
  const remoteId = yield* storage.getId

  return EventLogServer.layerRpcHandlers({
    remoteId,
    getOrCreateSessionAuthBinding: (publicKey, signingPublicKey) =>
      storage.getOrCreateSessionAuthBinding(publicKey, signingPublicKey),
    onWrite: Effect.fnUntraced(function*(data) {
      const request = yield* WriteEntries.decode(data).pipe(
        Effect.mapError((_) =>
          new EventLogProtocolError({
            requestTag: "WriteEntries",
            publicKey: undefined,
            code: "InternalServerError",
            message: "Decoding failure"
          })
        )
      )
      if (request.encryptedEntries.length === 0) return
      const entries = request.encryptedEntries.map(({ encryptedEntry, entryId }) =>
        new PersistedEntry({
          entryId,
          iv: request.iv,
          encryptedEntry
        })
      )
      return yield* storage.write(request.publicKey, request.storeId, entries).pipe(
        Effect.catchCause((_) =>
          Effect.fail(
            new EventLogProtocolError({
              requestTag: "WriteEntries",
              publicKey: request.publicKey,
              code: "InternalServerError",
              message: "Persistence failure"
            })
          )
        )
      )
    }),
    changes: ({ publicKey, storeId, startSequence }) =>
      storage.changes(publicKey, storeId, startSequence).pipe(
        Stream.mapArrayEffect((entries) => Effect.map(ChangesRpc.encodeEncrypted(entries), Arr.of))
      )
  })
}))

/**
 * Provides an encrypted event-log RPC server using `EventLogRemoteRpcs` and the
 * encrypted server RPC handlers.
 *
 * **When to use**
 *
 * Use to expose the encrypted event-log RPC server when you already have an
 * `RpcServer.Protocol` and want clients using encrypted `EventLogRemote`
 * replication to synchronize through server-side `Storage`.
 *
 * **Details**
 *
 * This layer installs `EventLogRemoteRpcs` on the provided RPC server protocol
 * and wires those RPCs to `layerRpcHandlers`. Encrypted entries, session
 * authentication bindings, remote ids, and change streams are delegated to
 * `Storage`.
 *
 * @see {@link layerRpcHandlers} for the encrypted handler layer without installing an RPC server protocol
 * @see {@link Storage} for the storage service required by this layer
 * @see {@link layerStorageMemory} for the process-local in-memory storage layer
 *
 * @category layers
 * @since 4.0.0
 */
export const layer: Layer.Layer<never, never, RpcServer.Protocol | Storage> = RpcServer.layer(EventLogRemoteRpcs).pipe(
  Layer.provide(layerRpcHandlers)
)

/**
 * Schema for encrypted entries persisted by the encrypted event-log server.
 *
 * @category storage
 * @since 4.0.0
 */
export class PersistedEntry extends Schema.Class<PersistedEntry>(
  "effect/eventlog/EventLogServerEncrypted/PersistedEntry"
)({
  entryId: EntryId,
  iv: Transferable.Uint8Array,
  encryptedEntry: Transferable.Uint8Array
}) {
  /**
   * String representation of the encrypted entry id.
   *
   * @since 4.0.0
   */
  get entryIdString(): string {
    return Uuid.stringify(this.entryId)
  }
}

/**
 * Defines the backing store service used by the encrypted event-log server.
 *
 * **When to use**
 *
 * Use to provide durable encrypted event-log persistence for an encrypted
 * event-log server layer.
 *
 * **Details**
 *
 * It provides the server remote id, stores session authentication bindings,
 * persists encrypted entries, and streams encrypted changes for a public key and
 * store id.
 *
 * @category storage
 * @since 4.0.0
 */
export class Storage extends Context.Service<Storage, {
  readonly getId: Effect.Effect<RemoteId>
  readonly getOrCreateSessionAuthBinding: (
    publicKey: string,
    signingPublicKey: Uint8Array<ArrayBuffer>
  ) => Effect.Effect<Uint8Array<ArrayBuffer>>
  readonly write: (
    publicKey: string,
    storeId: StoreId,
    entries: ReadonlyArray<PersistedEntry>
  ) => Effect.Effect<ReadonlyArray<EncryptedRemoteEntry>>
  readonly changes: (
    publicKey: string,
    storeId: StoreId,
    startSequence: number
  ) => Stream.Stream<EncryptedRemoteEntry>
}>()("effect/eventlog/EventLogServer/Storage") {}

/**
 * Creates an in-memory encrypted server `Storage`.
 *
 * **Details**
 *
 * Data, session authentication bindings, and streams are process-local and are
 * released with the surrounding scope.
 *
 * @category storage
 * @since 4.0.0
 */
export const makeStorageMemory: Effect.Effect<Storage["Service"], never, Scope.Scope> = Effect.gen(function*() {
  const knownIds = new Map<string, Map<string, number>>()
  const journals = new Map<string, Array<EncryptedRemoteEntry>>()
  const sessionAuthBindings = new Map<string, Uint8Array<ArrayBuffer>>()
  const remoteId = makeRemoteIdUnsafe()
  const ensureKnownIds = (scopeKey: string): Map<string, number> => {
    let storeKnownIds = knownIds.get(scopeKey)
    if (storeKnownIds) return storeKnownIds
    storeKnownIds = new Map<string, number>()
    knownIds.set(scopeKey, storeKnownIds)
    return storeKnownIds
  }
  const ensureJournal = (scopeKey: string) => {
    let journal = journals.get(scopeKey)
    if (journal) return journal
    journal = []
    journals.set(scopeKey, journal)
    return journal
  }
  const pubsubs = yield* RcMap.make({
    lookup: (_scopeKey: string) =>
      Effect.acquireRelease(
        PubSub.unbounded<EncryptedRemoteEntry>(),
        PubSub.shutdown
      ),
    idleTimeToLive: 60000
  })

  return Storage.of({
    getId: Effect.succeed(remoteId),
    getOrCreateSessionAuthBinding: (publicKey, signingPublicKey) =>
      Effect.sync(() => {
        let existing = sessionAuthBindings.get(publicKey)
        if (existing) return existing
        sessionAuthBindings.set(publicKey, signingPublicKey)
        return signingPublicKey
      }),
    write: Effect.fnUntraced(function*(publicKey, storeId, entries) {
      const scopeKey = makeEncryptedScopeKey({ publicKey, storeId })
      const pubsub = yield* RcMap.get(pubsubs, scopeKey)
      const storeKnownIds = ensureKnownIds(scopeKey)
      const journal = ensureJournal(scopeKey)
      const encryptedEntries: Array<EncryptedRemoteEntry> = []
      for (const entry of entries) {
        const idString = entry.entryIdString
        if (storeKnownIds.has(idString)) continue
        const encrypted: EncryptedRemoteEntry = {
          sequence: journal.length,
          entryId: entry.entryId,
          iv: entry.iv,
          encryptedEntry: entry.encryptedEntry
        }
        encryptedEntries.push(encrypted)
        storeKnownIds.set(idString, encrypted.sequence)
        journal.push(encrypted)
        PubSub.publishUnsafe(pubsub, encrypted)
      }
      return encryptedEntries
    }, Effect.scoped),
    changes: Effect.fnUntraced(function*(publicKey, storeId, startSequence) {
      const scopeKey = makeEncryptedScopeKey({ publicKey, storeId })
      const pubsub = yield* RcMap.get(pubsubs, scopeKey)
      const subscription = yield* PubSub.subscribe(pubsub)
      return Stream.fromArray(ensureJournal(scopeKey).slice(startSequence)).pipe(
        Stream.concat(Stream.fromSubscription(subscription))
      )
    }, Stream.unwrap)
  })
})

/**
 * Provides encrypted server `Storage` using the in-memory implementation.
 *
 * @category storage
 * @since 4.0.0
 */
export const layerStorageMemory: Layer.Layer<Storage> = Layer.effect(Storage)(makeStorageMemory)

const makeEncryptedScopeKey = ({ publicKey, storeId }: {
  readonly publicKey: string
  readonly storeId: StoreId
}): string => {
  return `${publicKey}/${storeId}`
}
