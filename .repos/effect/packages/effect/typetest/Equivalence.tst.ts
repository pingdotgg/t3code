import { Equivalence } from "effect"
import { describe, expect, it } from "tstyche"

describe("Equivalence", () => {
  it("Tuple", () => {
    const E = Equivalence.Tuple([Equivalence.strictEqual<number>(), Equivalence.strictEqual<string>()])
    expect(E).type.toBe<Equivalence.Equivalence<readonly [number, string]>>()
  })

  it("Array", () => {
    const E = Equivalence.Array(Equivalence.strictEqual<number>())
    expect(E).type.toBe<Equivalence.Equivalence<ReadonlyArray<number>>>()
  })

  it("Struct", () => {
    const key = Symbol()
    const E = Equivalence.Struct({
      a: Equivalence.strictEqual<number>(),
      b: Equivalence.strictEqual<string>(),
      [key]: Equivalence.strictEqual<boolean>()
    })
    expect(E).type.toBe<Equivalence.Equivalence<{ readonly a: number; readonly b: string; readonly [key]: boolean }>>()

    expect(Equivalence.Struct).type.not.toBeCallableWith({ [key]: 42 })
    expect(Equivalence.Struct).type.not.toBeCallableWith(42)
    expect(Equivalence.Struct).type.not.toBeCallableWith("value")
    expect(Equivalence.Struct).type.not.toBeCallableWith([Equivalence.strictEqual<number>()])
  })

  it("Struct accepts string record aliases", () => {
    type Fields = {
      [key: string]: Equivalence.Equivalence<number>
    }
    const fields: Fields = { age: Equivalence.strictEqual<number>() }

    expect(Equivalence.Struct).type.toBeCallableWith(fields)
  })
})
