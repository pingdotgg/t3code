import { assert, describe, it } from "@effect/vitest"
import { Context, Effect, Layer } from "effect"
import * as Exit from "effect/Exit"
import * as LayerRef from "effect/LayerRef"
import * as Scope from "effect/Scope"

class Resource extends Context.Service<Resource, { readonly id: number }>()("LayerRefTest/Resource") {}

const makeLayer = (acquired: Array<number>, released: Array<number>) =>
  Layer.effect(Resource)(
    Effect.acquireRelease(
      Effect.sync(() => {
        const id = acquired.length + 1
        acquired.push(id)
        return { id }
      }),
      (resource) =>
        Effect.sync(() => {
          released.push(resource.id)
        })
    )
  )

describe("LayerRef", () => {
  it.effect("make lazily acquires and releases resources", () =>
    Effect.gen(function*() {
      const acquired: Array<number> = []
      const released: Array<number> = []
      const refScope = yield* Scope.make()
      const ref = yield* LayerRef.make(makeLayer(acquired, released)).pipe(Scope.provide(refScope))

      assert.deepStrictEqual(acquired, [])
      assert.deepStrictEqual(released, [])

      const context = yield* Effect.scoped(ref.contextEffect)
      assert.strictEqual(Context.get(context, Resource).id, 1)
      assert.deepStrictEqual(acquired, [1])
      assert.deepStrictEqual(released, [1])

      const contextFromLayer = yield* Effect.scoped(Layer.build(ref.get))
      assert.strictEqual(Context.get(contextFromLayer, Resource).id, 2)
      assert.deepStrictEqual(acquired, [1, 2])
      assert.deepStrictEqual(released, [1, 2])

      yield* Scope.close(refScope, Exit.void)
      assert.deepStrictEqual(released, [1, 2])
    }))

  it.effect("invalidate releases an idle resource and acquires a fresh one", () =>
    Effect.gen(function*() {
      const acquired: Array<number> = []
      const released: Array<number> = []
      const refScope = yield* Scope.make()
      const ref = yield* LayerRef.make(makeLayer(acquired, released), {
        idleTimeToLive: "1 minute"
      }).pipe(Scope.provide(refScope))

      const context = yield* Effect.scoped(ref.contextEffect)
      assert.strictEqual(Context.get(context, Resource).id, 1)
      assert.deepStrictEqual(acquired, [1])
      assert.deepStrictEqual(released, [])

      const cachedContext = yield* Effect.scoped(ref.contextEffect)
      assert.strictEqual(Context.get(cachedContext, Resource).id, 1)
      assert.deepStrictEqual(acquired, [1])
      assert.deepStrictEqual(released, [])

      yield* ref.invalidate
      assert.deepStrictEqual(released, [1])

      const freshContext = yield* Effect.scoped(ref.contextEffect)
      assert.strictEqual(Context.get(freshContext, Resource).id, 2)
      assert.deepStrictEqual(acquired, [1, 2])
      assert.deepStrictEqual(released, [1])

      yield* Scope.close(refScope, Exit.void)
      assert.deepStrictEqual(released, [1, 2])
    }))

  it.live("invalidate rebuilds while an earlier borrower holds its context", () =>
    Effect.gen(function*() {
      const acquired: Array<number> = []
      const released: Array<number> = []
      const layer = makeLayer(acquired, released)
      const ref = yield* LayerRef.make(layer)

      const ids = yield* Effect.gen(function*() {
        const provided = yield* Resource
        const borrowerScope = yield* Scope.make()
        const borrowed = yield* ref.contextEffect.pipe(Scope.provide(borrowerScope))

        yield* ref.invalidate
        const fresh = yield* Effect.scoped(ref.contextEffect)
        assert.deepStrictEqual(released, [3])

        yield* Scope.close(borrowerScope, Exit.void)
        assert.deepStrictEqual(released, [3, 2])
        return [provided.id, Context.get(borrowed, Resource).id, Context.get(fresh, Resource).id]
      }).pipe(Effect.provide(layer))

      assert.deepStrictEqual(ids, [1, 2, 3])
      assert.deepStrictEqual(released, [3, 2, 1])
    }))

  it.effect("invalidate shares parent-memoized dependencies across rebuilds", () =>
    Effect.gen(function*() {
      let sharedBuilds = 0
      const acquired: Array<number> = []
      const released: Array<number> = []
      class Shared extends Context.Service<Shared, number>()("LayerRefTest/Shared") {}
      const sharedLayer = Layer.effect(Shared)(Effect.sync(() => ++sharedBuilds))

      class ResourceRef extends LayerRef.Service<ResourceRef>()("LayerRefTest/SharedDepRef", {
        layer: makeLayer(acquired, released).pipe(Layer.provide(sharedLayer)),
        dependencies: [sharedLayer]
      }) {}

      yield* Effect.gen(function*() {
        const borrowerScope = yield* Scope.make()
        const first = yield* ResourceRef.contextEffect.pipe(Scope.provide(borrowerScope))
        yield* ResourceRef.invalidate
        const second = yield* Effect.scoped(ResourceRef.contextEffect)
        assert.strictEqual(Context.get(first, Resource).id, 1)
        assert.strictEqual(Context.get(second, Resource).id, 2)
        assert.strictEqual(sharedBuilds, 1)
        yield* Scope.close(borrowerScope, Exit.void)
      }).pipe(Effect.provide(ResourceRef.layer))
    }))

  it.effect("preload acquires the resource when the LayerRef is created", () =>
    Effect.gen(function*() {
      const acquired: Array<number> = []
      const released: Array<number> = []
      const refScope = yield* Scope.make()
      const ref = yield* LayerRef.make(makeLayer(acquired, released), {
        idleTimeToLive: "1 minute",
        preload: true
      }).pipe(Scope.provide(refScope))

      assert.deepStrictEqual(acquired, [1])
      assert.deepStrictEqual(released, [])

      const context = yield* Effect.scoped(ref.contextEffect)
      assert.strictEqual(Context.get(context, Resource).id, 1)
      assert.deepStrictEqual(acquired, [1])
      assert.deepStrictEqual(released, [])

      yield* Scope.close(refScope, Exit.void)
      assert.deepStrictEqual(released, [1])
    }))

  it.effect("Service exposes layer, get, contextEffect, and invalidate", () =>
    Effect.gen(function*() {
      const acquired: Array<number> = []
      const released: Array<number> = []

      class ResourceRef extends LayerRef.Service<ResourceRef>()("LayerRefTest/ResourceRef", {
        layer: makeLayer(acquired, released),
        idleTimeToLive: "1 minute"
      }) {}

      yield* Effect.gen(function*() {
        const context = yield* Effect.scoped(ResourceRef.contextEffect)
        assert.strictEqual(Context.get(context, Resource).id, 1)

        const contextFromLayer = yield* Effect.scoped(Layer.build(ResourceRef.get))
        assert.strictEqual(Context.get(contextFromLayer, Resource).id, 1)
        assert.deepStrictEqual(acquired, [1])
        assert.deepStrictEqual(released, [])

        yield* ResourceRef.invalidate
        assert.deepStrictEqual(released, [1])

        const freshContext = yield* Effect.scoped(ResourceRef.contextEffect)
        assert.strictEqual(Context.get(freshContext, Resource).id, 2)
        assert.deepStrictEqual(acquired, [1, 2])
      }).pipe(Effect.provide(ResourceRef.layer))

      assert.deepStrictEqual(released, [1, 2])
    }))
})
