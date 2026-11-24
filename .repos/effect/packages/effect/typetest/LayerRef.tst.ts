import { type Effect, type Layer, LayerRef, type Scope } from "effect"
import { expect, it } from "tstyche"

declare const failing: Layer.Layer<never, "BuildError">

it("make only exposes build errors when preloading", () => {
  expect(LayerRef.make(failing)).type.toBe<Effect.Effect<LayerRef.LayerRef<never, "BuildError">, never, Scope.Scope>>()
  expect(LayerRef.make(failing, { idleTimeToLive: "Infinity" })).type.toBe<
    Effect.Effect<LayerRef.LayerRef<never, "BuildError">, never, Scope.Scope>
  >()
  expect(LayerRef.make(failing, { preload: false })).type.toBe<
    Effect.Effect<LayerRef.LayerRef<never, "BuildError">, never, Scope.Scope>
  >()
  expect(LayerRef.make(failing, { preload: true })).type.toBe<
    Effect.Effect<LayerRef.LayerRef<never, "BuildError">, "BuildError", Scope.Scope>
  >()
})

it("Service only exposes build errors in its layer when preloading", () => {
  class Lazy extends LayerRef.Service<Lazy>()("Lazy", { layer: failing }) {}
  class ExplicitLazy extends LayerRef.Service<ExplicitLazy>()("ExplicitLazy", { layer: failing, preload: false }) {}
  class Preloaded extends LayerRef.Service<Preloaded>()("Preloaded", { layer: failing, preload: true }) {}

  expect(Lazy.layer).type.toBe<Layer.Layer<Lazy>>()
  expect(Lazy.layerNoDeps).type.toBe<Layer.Layer<Lazy>>()
  expect(Lazy.get).type.toBe<Layer.Layer<never, "BuildError", Lazy>>()
  expect(ExplicitLazy.layer).type.toBe<Layer.Layer<ExplicitLazy>>()
  expect(Preloaded.layer).type.toBe<Layer.Layer<Preloaded, "BuildError">>()
})
