/**
 * Browser IndexedDB primitives and key schemas for Effect applications.
 *
 * This module is the low-level bridge used by the platform-browser IndexedDB
 * integration. It provides an `IndexedDb` service around the browser
 * `indexedDB` factory and `IDBKeyRange` constructor, a `layerWindow` layer for
 * wiring those primitives from `window`, and schemas for the key shapes accepted
 * by IndexedDB object stores and indexes.
 *
 * Use it when building typed local persistence for browser caches,
 * offline-first state, background queues, drafts, or other client-side data
 * that should be validated before it reaches IndexedDB. Higher-level database,
 * version, table, and query modules build on these primitives for migrations
 * and typed transactions.
 *
 * IndexedDB still follows the browser rules: schema changes happen only during
 * version upgrades, upgrades may be blocked by other open tabs or connections,
 * and reads or writes must run in transactions scoped to the object stores they
 * touch. The `layerWindow` constructor should be used only where browser
 * globals are available, and code that also runs during SSR or in restricted
 * browser contexts should account for `indexedDB` or `IDBKeyRange` being
 * missing.
 *
 * @since 4.0.0
 */
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"

const TypeId = "~@effect/platform-browser/IndexedDb"

/**
 * Service interface that provides the browser `indexedDB` factory and `IDBKeyRange` constructor.
 *
 * @category models
 * @since 4.0.0
 */
export interface IndexedDb {
  readonly [TypeId]: typeof TypeId
  readonly indexedDB: globalThis.IDBFactory
  readonly IDBKeyRange: typeof globalThis.IDBKeyRange
}

/**
 * Service tag for browser IndexedDB primitives.
 *
 * @category tag
 * @since 4.0.0
 */
export const IndexedDb: Context.Service<IndexedDb, IndexedDb> = Context.Service<IndexedDb, IndexedDb>(TypeId)

/** @internal */
const IDBFlatKey = Schema.Union([
  Schema.String,
  Schema.Number.check(Schema.makeFilter((input) => !Number.isNaN(input))),
  Schema.DateValid,
  Schema.declare(
    (input): input is BufferSource =>
      input instanceof ArrayBuffer ||
      (ArrayBuffer.isView(input) && input.buffer instanceof ArrayBuffer)
  )
])

/**
 * Schema for IndexedDB keys: strings, non-NaN numbers, valid dates, buffer sources, or arrays of those flat key values.
 *
 * @category schemas
 * @since 4.0.0
 */
export const IDBValidKey = Schema.Union([IDBFlatKey, Schema.Array(IDBFlatKey)])

/**
 * Schema for auto-incremented IndexedDB keys, accepting integers from 1 through `2 ** 53`.
 *
 * **When to use**
 *
 * Use when defining numeric key-path fields for `IndexedDbTable` definitions
 * that use IndexedDB auto-increment keys.
 *
 * **Details**
 *
 * The schema accepts integer values from `1` through `2 ** 53`, matching the
 * range used for generated IndexedDB auto-increment keys.
 *
 * @see {@link IDBValidKey} for the broader IndexedDB key schema
 *
 * @category schemas
 * @since 4.0.0
 */
export const AutoIncrement = Schema.Int.check(
  Schema.isBetween({ minimum: 1, maximum: 2 ** 53 })
).annotate({
  identifier: "AutoIncrement",
  title: "autoIncrement",
  description: "Defines a valid autoIncrement key path for the IndexedDb table"
})

/**
 * Creates an `IndexedDb` service from an `IDBFactory` and `IDBKeyRange` constructor.
 *
 * @category constructors
 * @since 4.0.0
 */
export const make = (impl: Omit<IndexedDb, typeof TypeId>): IndexedDb => IndexedDb.of({ [TypeId]: TypeId, ...impl })

/**
 * Layer that provides `IndexedDb` from `window.indexedDB` and `window.IDBKeyRange`, failing with a config error when they are unavailable.
 *
 * @category constructors
 * @since 4.0.0
 */
export const layerWindow: Layer.Layer<IndexedDb> = Layer.effect(
  IndexedDb,
  Effect.suspend(() => {
    if (window.indexedDB && window.IDBKeyRange) {
      return Effect.succeed(
        make({
          indexedDB: window.indexedDB,
          IDBKeyRange: window.IDBKeyRange
        })
      )
    } else {
      return Effect.die(new Error("window.indexedDB is not available"))
    }
  })
)
