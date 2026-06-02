import { SqliteClient } from "@effect/sql-sqlite-node"
import { assert, describe, it } from "@effect/vitest"
import { Effect, Layer, Queue, Redacted, Stream } from "effect"
import * as EventJournal from "effect/unstable/eventlog/EventJournal"
import * as EventLog from "effect/unstable/eventlog/EventLog"
import * as EventLogEncryption from "effect/unstable/eventlog/EventLogEncryption"
import * as EventLogMessage from "effect/unstable/eventlog/EventLogMessage"
import type { StoreId } from "effect/unstable/eventlog/EventLogMessage"
import * as EventLogServer from "effect/unstable/eventlog/EventLogServerEncrypted"
import * as EventLogSessionAuth from "effect/unstable/eventlog/EventLogSessionAuth"
import { makeGetIdentityRootSecretMaterial } from "effect/unstable/eventlog/internal/identityRootSecretDerivation"
import * as SqlEventLogServer from "effect/unstable/eventlog/SqlEventLogServerEncrypted"
import { Reactivity } from "effect/unstable/reactivity"
import * as RpcTest from "effect/unstable/rpc/RpcTest"
import * as SqlClient from "effect/unstable/sql/SqlClient"

const storeIdA = "store-a" as StoreId
const storeIdB = "store-b" as StoreId

const makeEntry = (value: number) =>
  new EventJournal.Entry({
    id: EventJournal.makeEntryIdUnsafe(),
    event: "UserCreated",
    primaryKey: `user-${value}`,
    payload: new Uint8Array([value])
  }, { disableChecks: true })

const persistEntries = (
  encryption: EventLogEncryption.EventLogEncryption["Service"],
  identity: EventLog.Identity["Service"],
  entries: ReadonlyArray<EventJournal.Entry>
) =>
  Effect.gen(function*() {
    const encrypted = yield* encryption.encrypt(identity, entries)
    return encrypted.encryptedEntries.map((encryptedEntry, index) =>
      new EventLogServer.PersistedEntry({
        entryId: entries[index].id,
        iv: encrypted.iv,
        encryptedEntry
      })
    )
  })

const makePersistedEntry = (index: number, entryId = EventJournal.makeEntryIdUnsafe()) =>
  new EventLogServer.PersistedEntry({
    entryId,
    iv: new Uint8Array(12),
    encryptedEntry: Uint8Array.of(index)
  })

const getIdentityRootSecretMaterial = makeGetIdentityRootSecretMaterial(globalThis.crypto)

const makeAuthenticateRequest = Effect.fnUntraced(function*(options: {
  readonly identity: EventLog.Identity["Service"]
  readonly challenge: Uint8Array
  readonly remoteId: EventJournal.RemoteId
}) {
  const rootSecretMaterial = yield* getIdentityRootSecretMaterial(options.identity)
  const signature = yield* EventLogSessionAuth.signSessionAuthPayload({
    remoteId: options.remoteId,
    challenge: options.challenge,
    publicKey: options.identity.publicKey,
    signingPublicKey: rootSecretMaterial.signingPublicKey,
    signingPrivateKey: Redacted.value(rootSecretMaterial.signingPrivateKey)
  })
  return new EventLogMessage.Authenticate({
    publicKey: options.identity.publicKey,
    signingPublicKey: rootSecretMaterial.signingPublicKey,
    signature,
    algorithm: "Ed25519"
  })
})

describe("SqlEventLogServer", () => {
  it.effect("persists remote id across storage instances", () =>
    Effect.gen(function*() {
      const sql = yield* SqliteClient.make({ filename: ":memory:" })
      const storageA = yield* SqlEventLogServer.makeStorage().pipe(
        Effect.provideService(SqlClient.SqlClient, sql)
      )
      const storageB = yield* SqlEventLogServer.makeStorage().pipe(
        Effect.provideService(SqlClient.SqlClient, sql)
      )
      const idA = yield* storageA.getId
      const idB = yield* storageB.getId
      assert.deepStrictEqual(idA, idB)
    }).pipe(Effect.provide([Reactivity.layer, EventLogEncryption.layerSubtle])))

  it.effect("rejects session-auth rebinding for an existing publicKey", () =>
    Effect.gen(function*() {
      const sql = yield* SqliteClient.make({ filename: ":memory:" })
      const storage = yield* SqlEventLogServer.makeStorage().pipe(
        Effect.provideService(SqlClient.SqlClient, sql)
      )
      const rpcClient = yield* RpcTest.makeClient(EventLogMessage.EventLogRemoteRpcs).pipe(
        Effect.provide(
          EventLogServer.layerRpcHandlers.pipe(
            Layer.provide(Layer.succeed(EventLogServer.Storage, storage))
          )
        )
      )

      const firstIdentity = yield* EventLog.makeIdentity
      const secondIdentitySeed = yield* EventLog.makeIdentity
      const secondIdentity: EventLog.Identity["Service"] = {
        publicKey: firstIdentity.publicKey,
        privateKey: secondIdentitySeed.privateKey
      }

      const firstMaterial = yield* getIdentityRootSecretMaterial(firstIdentity)
      const secondMaterial = yield* getIdentityRootSecretMaterial(secondIdentity)
      const sameSigningPublicKey =
        firstMaterial.signingPublicKey.byteLength === secondMaterial.signingPublicKey.byteLength &&
        firstMaterial.signingPublicKey.every((byte, index) => byte === secondMaterial.signingPublicKey[index])
      assert.strictEqual(sameSigningPublicKey, false)

      const firstHello = yield* rpcClient["EventLog.Hello"]()
      yield* rpcClient["EventLog.Authenticate"](
        yield* makeAuthenticateRequest({
          identity: firstIdentity,
          challenge: firstHello.challenge,
          remoteId: firstHello.remoteId
        })
      )

      const secondHello = yield* rpcClient["EventLog.Hello"]()
      const error = yield* rpcClient["EventLog.Authenticate"](
        yield* makeAuthenticateRequest({
          identity: secondIdentity,
          challenge: secondHello.challenge,
          remoteId: secondHello.remoteId
        })
      ).pipe(Effect.flip)

      assert.instanceOf(error, EventLogMessage.EventLogProtocolError)
      assert.strictEqual(error.code, "Forbidden")
      assert.strictEqual(error.message, "Session auth signature verification failed")
    }).pipe(Effect.provide([Reactivity.layer, EventLogEncryption.layerSubtle])))

  it.effect("writes entries and streams changes", () =>
    Effect.gen(function*() {
      const sql = yield* SqliteClient.make({ filename: ":memory:" })
      const storage = yield* SqlEventLogServer.makeStorage().pipe(
        Effect.provideService(SqlClient.SqlClient, sql)
      )
      const encryption = yield* EventLogEncryption.EventLogEncryption
      const identity = yield* encryption.generateIdentity
      const entries = [makeEntry(1), makeEntry(2)]
      const persisted = yield* persistEntries(encryption, identity, entries)
      const written = yield* storage.write(identity.publicKey, storeIdA, persisted)
      assert.deepStrictEqual(written.map((entry) => entry.sequence), [1, 2])

      const changes = yield* storage.changes(identity.publicKey, storeIdA, 0).pipe(
        Stream.toQueue({ capacity: "unbounded" })
      )
      const taken = yield* Queue.takeAll(changes)
      assert.deepStrictEqual(taken.map((entry) => entry.sequence), [1, 2])

      const nextEntry = makeEntry(3)
      const nextPersisted = yield* persistEntries(encryption, identity, [nextEntry])
      const updated = yield* storage.write(identity.publicKey, storeIdA, nextPersisted)
      assert.deepStrictEqual(updated.map((entry) => entry.sequence), [3])

      const next = yield* Queue.take(changes)
      assert.strictEqual(next.sequence, 3)
    }).pipe(Effect.provide([Reactivity.layer, EventLogEncryption.layerSubtle])))

  it.effect("isolates same publicKey across storeIds", () =>
    Effect.gen(function*() {
      const sql = yield* SqliteClient.make({ filename: ":memory:" })
      const storage = yield* SqlEventLogServer.makeStorage().pipe(
        Effect.provideService(SqlClient.SqlClient, sql)
      )

      yield* storage.write("client-1", storeIdA, [makePersistedEntry(1)])
      yield* storage.write("client-1", storeIdB, [makePersistedEntry(2)])

      const storeAEntries = yield* storage.changes("client-1", storeIdA, 0).pipe(
        Stream.take(1),
        Stream.runCollect
      )
      const storeBEntries = yield* storage.changes("client-1", storeIdB, 0).pipe(
        Stream.take(1),
        Stream.runCollect
      )

      assert.deepStrictEqual(storeAEntries.map((entry) => entry.sequence), [1])
      assert.deepStrictEqual(storeBEntries.map((entry) => entry.sequence), [1])
    }).pipe(Effect.provide([Reactivity.layer, EventLogEncryption.layerSubtle])))

  it.effect("isolates same storeId across publicKeys", () =>
    Effect.gen(function*() {
      const sql = yield* SqliteClient.make({ filename: ":memory:" })
      const storage = yield* SqlEventLogServer.makeStorage().pipe(
        Effect.provideService(SqlClient.SqlClient, sql)
      )

      yield* storage.write("client-1", storeIdA, [makePersistedEntry(1)])
      yield* storage.write("client-2", storeIdA, [makePersistedEntry(2)])

      const clientOneEntries = yield* storage.changes("client-1", storeIdA, 0).pipe(
        Stream.take(1),
        Stream.runCollect
      )
      const clientTwoEntries = yield* storage.changes("client-2", storeIdA, 0).pipe(
        Stream.take(1),
        Stream.runCollect
      )

      assert.deepStrictEqual(clientOneEntries.map((entry) => entry.sequence), [1])
      assert.deepStrictEqual(clientTwoEntries.map((entry) => entry.sequence), [1])
    }).pipe(Effect.provide([Reactivity.layer, EventLogEncryption.layerSubtle])))

  it.effect("keeps deduplication isolated per encrypted scope", () =>
    Effect.gen(function*() {
      const sql = yield* SqliteClient.make({ filename: ":memory:" })
      const storage = yield* SqlEventLogServer.makeStorage().pipe(
        Effect.provideService(SqlClient.SqlClient, sql)
      )
      const sharedEntryId = EventJournal.makeEntryIdUnsafe()

      yield* storage.write("client-1", storeIdA, [makePersistedEntry(1, sharedEntryId)])
      yield* storage.write("client-1", storeIdA, [makePersistedEntry(2, sharedEntryId)])
      yield* storage.write("client-1", storeIdB, [makePersistedEntry(3, sharedEntryId)])
      yield* storage.write("client-2", storeIdA, [makePersistedEntry(4, sharedEntryId)])

      assert.deepStrictEqual(
        (yield* storage.changes("client-1", storeIdA, 0).pipe(
          Stream.take(1),
          Stream.runCollect
        )).map((entry) => entry.sequence),
        [1]
      )
      assert.deepStrictEqual(
        (yield* storage.changes("client-1", storeIdB, 0).pipe(
          Stream.take(1),
          Stream.runCollect
        )).map((entry) => entry.sequence),
        [1]
      )
      assert.deepStrictEqual(
        (yield* storage.changes("client-2", storeIdA, 0).pipe(
          Stream.take(1),
          Stream.runCollect
        )).map((entry) => entry.sequence),
        [1]
      )
    }).pipe(Effect.provide([Reactivity.layer, EventLogEncryption.layerSubtle])))
})
