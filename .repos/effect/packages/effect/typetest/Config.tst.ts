import { Config, ConfigProvider, Schema } from "effect"
import { describe, expect, it } from "tstyche"

describe("Config", () => {
  it("all checks symbol fields and accepts object type aliases", () => {
    const key = Symbol()
    type Fields = {
      text: Config.Config<string>
      [key]: Config.Config<number>
    }
    const fields: Fields = { text: Config.String("text"), [key]: Config.Number("number") }
    expect(Config.all(fields)).type.toBe<Config.Config<{ text: string; [key]: number }>>()
    type IndexedFields = {
      [key: string]: Config.Config<number>
    }
    const indexed: IndexedFields = { value: fields[key] }
    expect(Config.all(indexed)).type.toBe<Config.Config<{ [key: string]: number }>>()
    expect(Config.all([fields.text, fields[key]])).type.toBe<Config.Config<[string, number]>>()
    expect(Config.all(new Set([fields[key]]))).type.toBe<Config.Config<Array<number>>>()
    expect(Config.all).type.not.toBeCallableWith({ [key]: 42 })
    expect(Config.all).type.not.toBeCallableWith(42)
    expect(Config.all).type.not.toBeCallableWith("value")
    expect(Config.all).type.not.toBeCallableWith({ text: fields.text, [key]: 42 })
  })

  it("literals", () => {
    const c = Config.Literals(["a", "b"])

    expect(c).type.toBe<Config.Config<"a" | "b">>()
    expect<Config.Success<typeof c>>().type.toBe<"a" | "b">()
  })

  it("withDefault", () => {
    const c = Config.schema(Schema.Literals(["a", "b"]))

    const c1 = c.pipe(Config.withDefault("a"))
    expect(c1).type.toBe<Config.Config<"a" | "b">>()

    const c2 = Config.withDefault(c, "a")
    expect(c2).type.toBe<Config.Config<"a" | "b">>()

    const c3 = c.pipe(Config.withDefault("c"))
    expect(c3).type.toBe<Config.Config<"a" | "b" | "c">>()
  })

  it("type level helpers", () => {
    const c = Config.schema(Schema.Literals(["a", "b"]))

    type S = Config.Success<typeof c>
    expect<S>().type.toBe<"a" | "b">()
  })

  it("Record", () => {
    const c = Config.Record(Schema.String, Schema.FiniteFromString)

    expect(c).type.toBe<Config.Config<{ readonly [x: string]: number }>>()

    const withPath = Config.Record(Schema.String, Schema.FiniteFromString, "values", { separator: ";" })
    expect(withPath).type.toBe<Config.Config<{ readonly [x: string]: number }>>()
  })

  it("Array", () => {
    const c = Config.Array(Schema.FiniteFromString)

    expect(c).type.toBe<Config.Config<ReadonlyArray<number>>>()

    const withPath = Config.Array(Schema.FiniteFromString, "values", { separator: ";" })
    expect(withPath).type.toBe<Config.Config<ReadonlyArray<number>>>()
  })

  it("parse", () => {
    const config = Config.String("a")
    const provider = ConfigProvider.fromUnknown({ a: "value" })

    config.parse(provider)
    // @ts-expect-error Expected 1 arguments, but got 2.
    config.parse(provider, ["prefix"])
  })
})
