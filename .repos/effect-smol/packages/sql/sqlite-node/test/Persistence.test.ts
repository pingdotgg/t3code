import { NodeFileSystem } from "@effect/platform-node"
import { SqliteClient } from "@effect/sql-sqlite-node"
import { assert, expect, it } from "@effect/vitest"
import { Duration, Effect, FileSystem, Layer } from "effect"
import * as PersistedQueueTest from "effect-test/unstable/persistence/PersistedQueueTest"
import * as SqlCleanupTest from "effect-test/unstable/persistence/SqlCleanupTest"
import { TestClock } from "effect/testing"
import { PersistedQueue, Persistence } from "effect/unstable/persistence"
import { Reactivity } from "effect/unstable/reactivity"
import * as SqlClient from "effect/unstable/sql/SqlClient"

const ClientLayer = Effect.gen(function*() {
  const fs = yield* FileSystem.FileSystem
  const dir = yield* fs.makeTempDirectoryScoped()
  return SqliteClient.layer({
    filename: dir + "/test.db"
  })
}).pipe(
  Layer.unwrap,
  Layer.provide([NodeFileSystem.layer, Reactivity.layer])
)

const testLayer = (layer: Layer.Layer<Persistence.BackingPersistence, never, SqlClient.SqlClient>) =>
  layer.pipe(Layer.provideMerge(ClientLayer))

const suite = (name: string, layer: Layer.Layer<Persistence.BackingPersistence, never, SqlClient.SqlClient>) =>
  it.layer(testLayer(layer))(`Persistence (${name})`, (it) => {
    it.effect("set + get", () =>
      Effect.gen(function*() {
        const persistence = yield* Persistence.BackingPersistence
        const store = yield* persistence.make("test_store")
        yield* store.set("key1", { name: "Alice" }, undefined)
        const value = yield* store.get("key1")
        expect(value).toEqual({ name: "Alice" })

        // test upsert
        yield* store.set("key1", { name: "Alice" }, undefined)
      }))

    it.effect("setMany + getMany", () =>
      Effect.gen(function*() {
        const persistence = yield* Persistence.BackingPersistence
        const store = yield* persistence.make("test_store_2")
        yield* store.setMany([
          ["key1", { name: "Alice" }, undefined],
          ["key2", { name: "Bob" }, undefined],
          ["key3", { name: "Charlie" }, undefined]
        ])
        const values = yield* store.getMany(["key1", "key2", "key3", "key4"])
        expect(values).toEqual([
          { name: "Alice" },
          { name: "Bob" },
          { name: "Charlie" },
          undefined
        ])
      }))

    it.effect("getMany with duplicate keys", () =>
      Effect.gen(function*() {
        const persistence = yield* Persistence.BackingPersistence
        const store = yield* persistence.make("test_store_duplicate_keys")
        yield* store.set("key", { value: 1 }, undefined)

        expect(yield* store.getMany(["key", "key"])).toEqual([{ value: 1 }, { value: 1 }])
      }))

    it.effect("remove", () =>
      Effect.gen(function*() {
        const persistence = yield* Persistence.BackingPersistence
        const store = yield* persistence.make("test_store_2")
        yield* store.setMany([
          ["key1", { name: "Alice" }, undefined],
          ["key2", { name: "Bob" }, undefined],
          ["key3", { name: "Charlie" }, undefined]
        ])
        yield* store.remove("key2")
        const valuesAfter = yield* store.getMany(["key1", "key2", "key3"])
        expect(valuesAfter).toEqual([{ name: "Alice" }, undefined, { name: "Charlie" }])
      }))

    it.effect("expires", () =>
      Effect.gen(function*() {
        const persistence = yield* Persistence.BackingPersistence
        const store = yield* persistence.make("test_store_3")
        yield* store.setMany([
          ["key1", { name: "Alice" }, undefined],
          ["key2", { name: "Bob" }, undefined],
          ["key3", { name: "Charlie" }, Duration.seconds(10)]
        ])
        let values = yield* store.getMany(["key1", "key2", "key3"])
        expect(values).toEqual([{ name: "Alice" }, { name: "Bob" }, { name: "Charlie" }])
        yield* TestClock.adjust(Duration.seconds(5))
        values = yield* store.getMany(["key1", "key2", "key3"])
        expect(values).toEqual([{ name: "Alice" }, { name: "Bob" }, { name: "Charlie" }])
        yield* TestClock.adjust(Duration.seconds(5))
        values = yield* store.getMany(["key1", "key2", "key3"])
        expect(values).toEqual([{ name: "Alice" }, { name: "Bob" }, undefined])
      }))

    it.effect("isolation between stores", () =>
      Effect.gen(function*() {
        const persistence = yield* Persistence.BackingPersistence
        const storeA = yield* persistence.make("test_store_a")
        const storeB = yield* persistence.make("test_store_b")

        yield* storeA.set("shared-key", { name: "Alice" }, undefined)
        yield* storeB.set("shared-key", { name: "Bob" }, undefined)

        expect(yield* storeA.get("shared-key")).toEqual({ name: "Alice" })
        expect(yield* storeB.get("shared-key")).toEqual({ name: "Bob" })

        yield* storeA.clear

        expect(yield* storeA.get("shared-key")).toEqual(undefined)
        expect(yield* storeB.get("shared-key")).toEqual({ name: "Bob" })
      }))
  })

suite("table-per-store", Persistence.layerBackingSqlMultiTable)
suite("single-table", Persistence.layerBackingSql)

PersistedQueueTest.suite(
  "sql-sqlite-node",
  PersistedQueue.layerStoreSql().pipe(Layer.provide(ClientLayer))
)

it.layer(ClientLayer)("Persistence SQL cleanup", (it) => {
  it.effect("deletes expired entries in batches", () =>
    Effect.gen(function*() {
      const sql = (yield* SqlClient.SqlClient).withoutTransforms()
      const table = sql("effect_persistence")
      const expiredCount = sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count FROM ${table} WHERE store_id = 'expired'
      `.pipe(Effect.map((rows) => rows[0].count))
      yield* sql`
        CREATE TABLE ${table} (
          store_id TEXT NOT NULL,
          id TEXT NOT NULL,
          value TEXT NOT NULL,
          expires INTEGER,
          PRIMARY KEY (store_id, id)
        )
      `

      const entries = Array.from({ length: SqlCleanupTest.expiredEntryCount }, (_, i) => ({
        store_id: "expired",
        id: String(i),
        value: "{}",
        expires: SqlCleanupTest.expiredAtEpoch
      }))
      yield* sql`INSERT INTO ${table} ${sql.insert(entries)}`.unprepared
      yield* sql`
        INSERT INTO ${table} (store_id, id, value, expires)
        VALUES ('live', 'live', '{}', NULL), ('live', 'future', '{}', ${SqlCleanupTest.futureExpiresAt})
      `

      yield* Layer.build(Persistence.layerBackingSql).pipe(TestClock.withLive)

      const expired = yield* SqlCleanupTest.waitForCount(expiredCount, (count) => count === 0)
      assert.strictEqual(expired, 0)
      const live = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count FROM ${table} WHERE store_id = 'live'
      `
      assert.strictEqual(live[0].count, 2)

      const indexes = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count FROM sqlite_master
        WHERE type = 'index'
          AND name = 'effect_persistence_expires_idx'
      `
      assert.strictEqual(indexes[0].count, 1)
    }), { timeout: SqlCleanupTest.testTimeout })
})
