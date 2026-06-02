import { Config, Schema } from "effect"
import { describe, expect, it } from "tstyche"

describe("Config", () => {
  it("literals", () => {
    const c = Config.literals(["a", "b"])

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
})
