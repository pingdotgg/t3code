import { it, layer } from "@effect/vitest"
import { Context, Layer } from "effect"
import { describe, expect, test } from "tstyche"

class Foo extends Context.Service<Foo, "foo">()("Foo") {}
class Bar extends Context.Service<Bar, "bar">()("Bar") {}

describe("layer", () => {
  test("top-level export accepts full options", () => {
    expect(layer).type.toBeCallableWith(Layer.succeed(Foo, "foo"), {
      timeout: "5 seconds",
      excludeTestServices: true,
      memoMap: undefined as any
    })
  })

  test("top-level export accepts no options", () => {
    expect(layer).type.toBeCallableWith(Layer.succeed(Foo, "foo"))
  })

  test("it.layer accepts full options", () => {
    expect(it.layer).type.toBeCallableWith(Layer.succeed(Foo, "foo"), {
      timeout: "5 seconds",
      excludeTestServices: true,
      memoMap: undefined as any
    })
  })

  test("it.layer accepts no options", () => {
    expect(it.layer).type.toBeCallableWith(Layer.succeed(Foo, "foo"))
  })

  test("nested it.layer accepts timeout", () => {
    layer(Layer.succeed(Foo, "foo"))((it) => {
      expect(it.layer).type.toBeCallableWith(Layer.succeed(Bar, "bar"), {
        timeout: "3 seconds"
      })
    })
  })

  test("nested it.layer rejects excludeTestServices", () => {
    layer(Layer.succeed(Foo, "foo"))((it) => {
      expect(it.layer).type.not.toBeCallableWith(Layer.succeed(Bar, "bar"), {
        excludeTestServices: true
      })
    })
  })

  test("nested it.layer rejects memoMap", () => {
    layer(Layer.succeed(Foo, "foo"))((it) => {
      expect(it.layer).type.not.toBeCallableWith(Layer.succeed(Bar, "bar"), {
        memoMap: undefined as any
      })
    })
  })
})
