import { assert, describe, it } from "@effect/vitest"
import * as Lexer from "effect/unstable/cli/internal/lexer"

describe("Lexer", () => {
  it("preserves every equals sign in a long option's inline value", () => {
    const result = Lexer.lex(["--query=left=right"])

    assert.deepStrictEqual(result.tokens, [{
      _tag: "LongOption",
      name: "query",
      raw: "--query=left=right",
      value: "left=right"
    }])
  })
})
