import { assert, describe, it } from "@effect/vitest"
import { Effect, Layer, LayerMap } from "effect"
import { TestClock } from "effect/testing"

const makeLayer = (key: string, acquired: Array<string>, released: Array<string>): Layer.Layer<any> =>
  Layer.effectDiscard(
    Effect.acquireRelease(
      Effect.sync(() => {
        acquired.push(key)
      }),
      () =>
        Effect.sync(() => {
          released.push(key)
        })
    )
  ) as Layer.Layer<any>

describe("LayerMap", () => {
  it.effect("make supports dynamic idleTimeToLive", () =>
    Effect.gen(function*() {
      const acquired: Array<string> = []
      const released: Array<string> = []
      const layerMap = yield* LayerMap.make(
        (key: string) => makeLayer(key, acquired, released),
        { idleTimeToLive: (key: string) => key.startsWith("short:") ? 500 : 2000 }
      )

      yield* Effect.scoped(layerMap.contextEffect("short:a"))
      yield* Effect.scoped(layerMap.contextEffect("long:b"))
      assert.deepStrictEqual(acquired, ["short:a", "long:b"])
      assert.deepStrictEqual(released, [])

      yield* TestClock.adjust(500)
      assert.deepStrictEqual(released, ["short:a"])

      yield* TestClock.adjust(1500)
      assert.deepStrictEqual(released, ["short:a", "long:b"])
    }))

  it.effect("fromRecord supports dynamic idleTimeToLive", () =>
    Effect.gen(function*() {
      const acquired: Array<string> = []
      const released: Array<string> = []
      const layers = {
        short: makeLayer("short", acquired, released),
        long: makeLayer("long", acquired, released)
      } as const
      const layerMap = yield* LayerMap.fromRecord(
        layers,
        {
          idleTimeToLive: (key) => {
            const key_: "short" | "long" = key
            return key_ === "short" ? 500 : 2000
          }
        }
      )

      yield* Effect.scoped(layerMap.contextEffect("short"))
      yield* Effect.scoped(layerMap.contextEffect("long"))
      assert.deepStrictEqual(acquired, ["short", "long"])
      assert.deepStrictEqual(released, [])

      yield* TestClock.adjust(500)
      assert.deepStrictEqual(released, ["short"])

      yield* TestClock.adjust(1500)
      assert.deepStrictEqual(released, ["short", "long"])
    }))

  it.effect("Service supports dynamic idleTimeToLive", () =>
    Effect.gen(function*() {
      const acquired: Array<string> = []
      const released: Array<string> = []

      class LookupMap extends LayerMap.Service<LookupMap>()("LayerMapTest/LookupMap", {
        lookup: (key: string) => makeLayer(key, acquired, released),
        idleTimeToLive: (key: string) => key.startsWith("short:") ? 500 : 2000
      }) {}

      class RecordMap extends LayerMap.Service<RecordMap>()("LayerMapTest/RecordMap", {
        layers: {
          short: makeLayer("short", acquired, released),
          long: makeLayer("long", acquired, released)
        },
        idleTimeToLive: (key) => {
          const key_: "short" | "long" = key
          return key_ === "short" ? 500 : 2000
        }
      }) {}

      yield* Effect.scoped(LookupMap.contextEffect("short:a").pipe(Effect.provide(LookupMap.layer)))
      yield* Effect.scoped(RecordMap.contextEffect("short").pipe(Effect.provide(RecordMap.layer)))
      assert.deepStrictEqual(acquired, ["short:a", "short"])

      yield* TestClock.adjust(500)
      assert.deepStrictEqual(released, ["short:a", "short"])
    }))
})
