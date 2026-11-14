import { assert, describe, it } from "@effect/vitest"
import { Result } from "effect"
import * as Json5 from "effect/encoding/Json5"

const parse = (input: string): unknown => Result.getOrThrow(Json5.parse(input))

const failureMessage = (input: string): string => {
  const error = Result.getOrThrow(Result.flip(Json5.parse(input)))
  assert.strictEqual(error.kind, "Decode")
  assert.strictEqual(error.module, "Json5")
  assert.strictEqual(error.input, input)
  return error.message
}

describe("Json5", () => {
  it("parses JSON5 syntax", () => {
    const input = `// comment
{ unquoted: 1, 'single': 'it\\'s', "double": "a\\/b", trailing: [1, 2,], hex: -0x1F,
  frac: .5, point: 5., plus: +1, exp: 1e3, esc: '\\x41\\u00e9\\0\\v', continued: 'a\\
b', \\u0061b: 1, a\\u0062c: 2, café: true, 𐐀: 2, $_: null, /* block */ }`
    assert.deepStrictEqual(parse(input), {
      unquoted: 1,
      single: "it's",
      double: "a/b",
      trailing: [1, 2],
      hex: -31,
      frac: 0.5,
      point: 5,
      plus: 1,
      exp: 1000,
      esc: "Aé\0\v",
      continued: "ab",
      ab: 1,
      abc: 2,
      café: true,
      𐐀: 2,
      $_: null
    })
    assert.deepStrictEqual(parse("﻿\v\f  [NaN, -Infinity] // end"), [NaN, -Infinity])
  })

  it("keeps __proto__ as data and lets the last duplicate key win", () => {
    const value = parse("{\"__proto__\": 1, a: 1, b: 0, a: 2}") as object
    assert.deepStrictEqual(Object.keys(value), ["__proto__", "a", "b"])
    assert.strictEqual(Object.getPrototypeOf(value), Object.prototype)
    assert.strictEqual((value as Record<string, unknown>).a, 2)
  })

  it("ignores members and escapes inherited from Object.prototype", () => {
    let calls = 0
    const changed = { get: () => (calls++, "changed"), configurable: true }
    // oxlint-disable-next-line no-extend-native -- Parsing must not reach inherited properties; removed below.
    Object.defineProperties(Object.prototype, {
      accessor: {
        set: () => {
          calls++
        },
        configurable: true
      },
      readonly: { value: 0, configurable: true },
      // The escape letters `q` and `u`, which a sparse lookup table would inherit.
      113: changed,
      117: changed
    })
    try {
      assert.deepStrictEqual(parse("{accessor: 1, readonly: [2]}"), { accessor: 1, readonly: [2] })
      assert.strictEqual(parse(String.raw`"\q\u0061"`), "qa")
      assert.strictEqual(calls, 0)
    } finally {
      for (const key of ["accessor", "readonly", "113", "117"]) {
        delete (Object.prototype as Record<string, unknown>)[key]
      }
    }
  })

  it.each([
    ["LF", "\n"],
    ["CR", "\r"],
    ["CRLF", "\r\n"],
    ["line separator", " "],
    ["paragraph separator", " "]
  ])("handles %s line endings", (_, ending) => {
    assert.strictEqual(parse("'a\\" + ending + "b'"), "ab")
    assert.deepStrictEqual(parse("// comment" + ending + "{}"), {})
    assert.strictEqual(failureMessage("{" + ending + "  a: hidden}"), "Invalid JSON5 at line 2, column 6")
  })

  it.each([
    "",
    "/* comment */",
    "[,1]",
    "[1,,]",
    "{a:1 b:2}",
    "[1",
    "null true",
    "-01",
    "0x",
    "1e+",
    "1/* gap */2",
    "'line\nbreak'",
    String.raw`'\1'`,
    String.raw`'\uZZZZ'`,
    String.raw`{0a: 1}`,
    "{} /* unterminated"
  ])("rejects malformed JSON5 %j without quoting it", (input) => {
    assert.match(failureMessage(input), /^Invalid JSON5 at line \d+, column \d+$/)
  })

  it("parses and locates errors beyond the JavaScript call-stack limit", () => {
    const prefix = "[".repeat(10_000)
    let value = parse(prefix + "0" + "]".repeat(10_000))
    for (let i = 0; i < 10_000; i++) value = (value as Array<unknown>)[0]
    assert.strictEqual(value, 0)
    assert.strictEqual(failureMessage(prefix + "?"), "Invalid JSON5 at line 1, column 10001")
  })
})
