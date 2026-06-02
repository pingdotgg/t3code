import * as BrowserKeyValueStore from "@effect/platform-browser/BrowserKeyValueStore"
import * as IndexedDb from "@effect/platform-browser/IndexedDb"
import { describe } from "@effect/vitest"
import { Layer } from "effect"
import { testLayer } from "effect-test/unstable/persistence/KeyValueStore.test"
import { IDBKeyRange, indexedDB } from "fake-indexeddb"

describe("KeyValueStore / layerLocalStorage", () => testLayer(BrowserKeyValueStore.layerLocalStorage))

describe("KeyValueStore / layerSessionStorage", () => testLayer(BrowserKeyValueStore.layerSessionStorage))

describe("KeyValueStore / layerIndexedDb", () => {
  const layerFakeIndexedDb = Layer.succeed(
    IndexedDb.IndexedDb,
    IndexedDb.make({ indexedDB, IDBKeyRange })
  )

  testLayer(
    BrowserKeyValueStore.layerIndexedDb({ database: "kvs_test_db" }).pipe(
      Layer.provide(layerFakeIndexedDb)
    )
  )
})
