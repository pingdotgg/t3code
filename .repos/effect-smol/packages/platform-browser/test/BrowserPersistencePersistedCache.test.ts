import * as BrowserPersistence from "@effect/platform-browser/BrowserPersistence"
import { afterEach, beforeEach, describe } from "@effect/vitest"
import * as PersistedCacheTest from "effect-test/unstable/persistence/PersistedCacheTest"
import { indexedDB as fakeIndexedDb } from "fake-indexeddb"

const database = "effect_persistence_integration"

let previousIndexedDb: unknown

beforeEach(() => {
  previousIndexedDb = Reflect.get(globalThis, "indexedDB")
  Reflect.set(globalThis, "indexedDB", fakeIndexedDb)
})

afterEach(() => {
  fakeIndexedDb.deleteDatabase(database)
  if (previousIndexedDb === undefined) {
    Reflect.deleteProperty(globalThis, "indexedDB")
    return
  }
  Reflect.set(globalThis, "indexedDB", previousIndexedDb)
})

describe.sequential("BrowserPersistence / PersistedCache", () => {
  PersistedCacheTest.suite(
    "browser-indexeddb",
    BrowserPersistence.layerIndexedDb({ database })
  )
})
