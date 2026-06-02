/**
 * Event-log encryption primitives for encrypted remote replication.
 *
 * This module defines the `EventLogEncryption` service used by encrypted
 * `EventLogRemote` clients to turn local journal entries into encrypted remote
 * payloads, decrypt encrypted changes received from a server, hash byte data,
 * and create event-log identities. It is useful when events need to be
 * replicated through infrastructure that stores or transports only ciphertext,
 * such as an encrypted event-log server, offline-first synchronization backend,
 * or multi-device replicated store.
 *
 * Encryption keys are deterministically derived from the identity private key
 * material, so the same stable identity is required to decrypt entries across
 * sessions and devices. The public key identifies the replicated log, while the
 * private key material must remain secret and must not be rotated without a
 * migration plan for existing encrypted entries. The default implementation
 * uses Web Crypto AES-GCM with generated initialization vectors that are stored
 * alongside encrypted entries; persisted ciphertext, IVs, entry schemas, and
 * identity key derivation labels are part of the compatibility surface for
 * future event-log encryption versions.
 *
 * @since 4.0.0
 */
import * as Context from "../../Context.ts"
import * as Effect from "../../Effect.ts"
import * as Layer from "../../Layer.ts"
import * as Redacted from "../../Redacted.ts"
import * as Schema from "../../Schema.ts"
import * as Transferable from "../workers/Transferable.ts"
import { Entry, EntryId, RemoteEntry } from "./EventJournal.ts"
import type { Identity } from "./EventLog.ts"
import { makeGetIdentityRootSecretMaterial } from "./internal/identityRootSecretDerivation.ts"

/**
 * Schema for an encrypted journal entry paired with the id of the original
 * entry.
 *
 * @category models
 * @since 4.0.0
 */
export const EncryptedEntry = Schema.Struct({
  entryId: EntryId,
  encryptedEntry: Transferable.Uint8Array
})

/**
 * Type of an encrypted remote entry, including its remote sequence number,
 * initialization vector, entry id, and encrypted entry bytes.
 *
 * @category models
 * @since 4.0.0
 */
export interface EncryptedRemoteEntry extends Schema.Schema.Type<typeof EncryptedRemoteEntry> {}

/**
 * Schema for encrypted entries exchanged with a remote event-log server.
 *
 * @category models
 * @since 4.0.0
 */
export const EncryptedRemoteEntry = Schema.Struct({
  sequence: Schema.Number,
  iv: Transferable.Uint8Array,
  entryId: EntryId,
  encryptedEntry: Transferable.Uint8Array
})

const toArrayBuffer = (data: Uint8Array): ArrayBuffer => {
  const buffer = new ArrayBuffer(data.byteLength)
  new Uint8Array(buffer).set(data)
  return buffer
}

const toBufferSource = (data: Uint8Array): ArrayBufferView<ArrayBuffer> => new Uint8Array(toArrayBuffer(data))

/**
 * Service that provides identity generation, entry
 * encryption and decryption, and SHA-256 hashing for event-log replication.
 *
 * **When to use**
 *
 * Use to provide cryptographic operations required by encrypted event-log
 * replication.
 *
 * @category tags
 * @since 4.0.0
 */
export class EventLogEncryption extends Context.Service<EventLogEncryption, {
  readonly encrypt: (
    identity: Identity["Service"],
    entries: ReadonlyArray<Entry>
  ) => Effect.Effect<{
    readonly iv: Uint8Array<ArrayBuffer>
    readonly encryptedEntries: ReadonlyArray<Uint8Array<ArrayBuffer>>
  }>
  readonly decrypt: (
    identity: Identity["Service"],
    entries: ReadonlyArray<EncryptedRemoteEntry>
  ) => Effect.Effect<Array<RemoteEntry>>
  readonly sha256String: (data: Uint8Array) => Effect.Effect<string>
  readonly sha256: (data: Uint8Array) => Effect.Effect<Uint8Array>
  readonly generateIdentity: Effect.Effect<Identity["Service"]>
}>()("effect/eventlog/EventLogEncryption") {}

/**
 * Creates an `EventLogEncryption` service backed by the Web Crypto `SubtleCrypto`
 * APIs from the supplied `Crypto` implementation.
 *
 * @category encryption
 * @since 4.0.0
 */
export const makeEncryptionSubtle = (crypto: Crypto): Effect.Effect<EventLogEncryption["Service"]> =>
  Effect.sync(() => {
    const getIdentityRootSecretMaterial = makeGetIdentityRootSecretMaterial(crypto)

    return EventLogEncryption.of({
      encrypt: Effect.fnUntraced(function*(identity, entries) {
        const data = yield* Effect.orDie(Entry.encodeArray(entries))
        const key = (yield* getIdentityRootSecretMaterial(identity)).encryptionKey
        const iv = crypto.getRandomValues(new Uint8Array(12))
        const encryptedEntries = yield* Effect.promise(() =>
          Promise.all(
            data.map((entry) =>
              crypto.subtle.encrypt(
                { name: "AES-GCM", iv: toBufferSource(iv), tagLength: 128 },
                key,
                toBufferSource(entry)
              )
            )
          )
        )
        return {
          iv,
          encryptedEntries: encryptedEntries.map((entry) => new Uint8Array(entry))
        }
      }),
      decrypt: Effect.fnUntraced(function*(identity, entries) {
        const key = (yield* getIdentityRootSecretMaterial(identity)).encryptionKey
        const decryptedData = (yield* Effect.promise(() =>
          Promise.all(entries.map((data) =>
            crypto.subtle.decrypt(
              { name: "AES-GCM", iv: toBufferSource(data.iv), tagLength: 128 },
              key,
              toBufferSource(data.encryptedEntry)
            )
          ))
        )).map((buffer) => new Uint8Array(buffer))
        const decoded = yield* Effect.orDie(Entry.decodeArray(decryptedData))
        return decoded.map((entry, index) => new RemoteEntry({ remoteSequence: entries[index].sequence, entry }))
      }),
      sha256: (data) =>
        Effect.promise(() => crypto.subtle.digest("SHA-256", toArrayBuffer(data))).pipe(
          Effect.map((hash) => new Uint8Array(hash))
        ),
      sha256String: (data) =>
        Effect.map(
          Effect.promise(() => crypto.subtle.digest("SHA-256", toArrayBuffer(data))),
          (hash) => {
            const hashArray = Array.from(new Uint8Array(hash))
            const hashHex = hashArray
              .map((bytes) => bytes.toString(16).padStart(2, "0"))
              .join("")
            return hashHex
          }
        ),
      generateIdentity: Effect.sync(() => ({
        publicKey: crypto.randomUUID(),
        privateKey: Redacted.make(crypto.getRandomValues(new Uint8Array(32)))
      }))
    })
  })

/**
 * Provides `EventLogEncryption` using `globalThis.crypto`.
 *
 * @category encryption
 * @since 4.0.0
 */
export const layerSubtle: Layer.Layer<EventLogEncryption> = Layer.effect(
  EventLogEncryption,
  makeEncryptionSubtle(globalThis.crypto)
)
