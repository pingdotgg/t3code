import { type Effect, hole, type Layer, LayerMap, type Scope } from "effect"
import { describe, expect, it } from "tstyche"

describe("LayerMap", () => {
  it("fromRecord checks symbol fields and accepts object type aliases", () => {
    const key = Symbol()
    const layer = hole<Layer.Layer<"service", "error", "dependency">>()
    type Fields = {
      text: typeof layer
      [key]: typeof layer
    }
    const fields: Fields = { text: layer, [key]: layer }
    expect(LayerMap.fromRecord(fields)).type.toBe<
      Effect.Effect<LayerMap.LayerMap<"text" | typeof key, "service", "error">, never, Scope.Scope | "dependency">
    >()
    expect(LayerMap.fromRecord(fields, { preload: true })).type.toBe<
      Effect.Effect<LayerMap.LayerMap<"text" | typeof key, "service", "error">, "error", Scope.Scope | "dependency">
    >()
    type IndexedFields = {
      [key: string]: typeof layer
    }
    const indexed: IndexedFields = { value: layer }
    expect(LayerMap.fromRecord).type.toBeCallableWith(indexed)
    expect(LayerMap.fromRecord).type.not.toBeCallableWith({ [key]: 42 })
    expect(LayerMap.fromRecord).type.not.toBeCallableWith(42)
    expect(LayerMap.fromRecord).type.not.toBeCallableWith("value")
    expect(LayerMap.fromRecord).type.not.toBeCallableWith([layer])
    expect(LayerMap.fromRecord).type.not.toBeCallableWith({ text: layer, [key]: 42 })

    const service = LayerMap.Service<{}>()
    expect(service).type.toBeCallableWith("Fields", { layers: fields })
    expect(service).type.toBeCallableWith("Indexed", { layers: indexed })
    expect(service).type.toBeCallableWith("Lookup", { lookup: (_key: string) => layer })
    class WithIdleTime extends LayerMap.Service<WithIdleTime>()("WithIdleTime", {
      layers: fields,
      idleTimeToLive: (key) => key === "text" ? 500 : 1000
    }) {}
    expect(WithIdleTime.get).type.toBeCallableWith(key)
    expect(WithIdleTime.get).type.not.toBeCallableWith("missing")
    expect(service).type.not.toBeCallableWith("Invalid", { layers: { [key]: 42 } })
    expect(service).type.not.toBeCallableWith("Invalid", { layers: 42 })
    expect(service).type.not.toBeCallableWith("Invalid", { layers: [layer] })
    expect(service).type.not.toBeCallableWith("Invalid", { layers: { text: layer, [key]: 42 } })
    expect(service).type.not.toBeCallableWith("Invalid", { layers: { text: 42 } })
    expect(service).type.not.toBeCallableWith("Invalid", { layers: fields, lookup: (_key: string) => layer })
    expect(service).type.not.toBeCallableWith("Invalid", { layers: fields, unexpected: true })
  })
})
