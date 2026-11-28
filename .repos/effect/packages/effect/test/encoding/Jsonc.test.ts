import { assert, describe, it } from "@effect/vitest"
import { Result } from "effect"
import { Json5, Jsonc } from "effect/encoding"

const parse = (input: string): unknown => Result.getOrThrow(Jsonc.parse(input))

const failureMessage = (input: string): string => {
  const error = Result.getOrThrow(Result.flip(Jsonc.parse(input)))
  assert.strictEqual(error.kind, "Decode")
  assert.strictEqual(error.module, "Jsonc")
  assert.strictEqual(error.input, input)
  return error.message
}

describe("Jsonc", () => {
  it("accepts comments wherever JSON accepts whitespace", () => {
    assert.deepStrictEqual(
      parse(`/* before */ {
      // property
      "a" /* key */ : /* value */ [1, /* item */ true, null],
      "nested": {"value": "ok"} /* end */
    } // after`),
      { a: [1, true, null], nested: { value: "ok" } }
    )
    assert.strictEqual(parse("// comment\rtrue"), true)
    assert.strictEqual(parse("// comment  still comment\r\ntrue"), true)
  })

  it("accepts a single leading byte order mark", () => {
    assert.deepStrictEqual(parse("﻿{}"), {})
    assert.deepStrictEqual(parse("\uFEFF// comment\n[1, /* comment */ true]"), [1, true])
    assert.strictEqual(parse("\uFEFF\"\uFEFF\""), "\uFEFF")
    assert.strictEqual(failureMessage("﻿﻿{}"), "Invalid JSONC at line 1, column 2")
  })

  it("ends strings only at quotes after an even run of backslashes", () => {
    assert.deepStrictEqual(parse(String.raw`["\" /* in */" /* out */]`), ["\" /* in */"])
    assert.deepStrictEqual(parse(String.raw`["\\" /* out */]`), ["\\"])
  })

  it.each([
    "1E-3",
    String.raw`{"url":"https://example.com/a/*b*/", "quote":"\"//still a string", "escapes":"\\\b\f\n\r\t\/A"}`,
    "\"  \"",
    "{\"__proto__\":{\"polluted\":true},\"constructor\":1,\"a\":1,\"a\":2}"
  ])("matches JSON.parse for %j", (input) => {
    assert.deepStrictEqual(parse(input), JSON.parse(input))
  })

  it.each([
    "[1,]",
    "{\"a\":1,}",
    "{a: 1}",
    "['a']",
    "0x1f",
    "+1",
    ".5",
    "5.",
    "-Infinity",
    "NaN",
    String.raw`"\x41"`,
    String.raw`"\v"`,
    "\"a\\\nb\"",
    "\v{}",
    " {}",
    " {}"
  ])("rejects JSON5-only syntax %j", (input) => {
    Result.getOrThrow(Json5.parse(input))
    assert.match(failureMessage(input), /^Invalid JSONC at line \d+, column \d+$/)
  })

  it.each(
    [
      ["empty input", "", 1, 1],
      ["only a comment", "// only a comment", 1, 18],
      ["value after a line comment", "{\n  // note\n  \"a\": hidden\n}", 3, 8],
      ["value after a multiline comment", "/* first\nsecond */\n?", 3, 1],
      ["invalid token before an unterminated comment", "? /* unterminated", 1, 1],
      ["unterminated block comment", "{\n/* secret", 2, 10],
      ["nested block comment", "/* nested /* */ */ {}", 1, 17],
      ["comment splitting a literal", "tr/* gap */ue", 1, 3],
      ["comment splitting a number", "1/* xx\n */2", 2, 4],
      ["comment marker after an escaped quote", "\"unfinished\\\" // not a comment", 1, 31],
      ["trailing array comma", "[1, /* note */]", 1, 15],
      ["trailing object comma", "{\"a\": 1,}", 1, 9],
      ["missing colon", "{\"a\" 1}", 1, 6],
      ["leading zero", "01", 1, 2],
      ["invalid escape", String.raw`{"a":"\q"}`, 1, 8],
      ["raw newline in a string", "\"raw\nnewline\"", 1, 5],
      ["unterminated string", "{\"a\":\"secret", 1, 13],
      ["trailing content", "{}\n/* comment */ hidden", 2, 15],
      ["CRLF line endings", "{\r\n  \"a\": hidden\r\n}", 2, 8],
      ["CR line endings", "{\r  \"a\": hidden\r}", 2, 8],
      ["UTF-16 columns after an astral character", "{\"emoji\":\"😀\",\"a\":?}", 1, 19]
    ] as const
  )("reports the original position for %s", (_, input, line, column) => {
    assert.strictEqual(failureMessage(input), `Invalid JSONC at line ${line}, column ${column}`)
  })

  it("locates errors despite members and escapes inherited from Object.prototype", () => {
    let calls = 0
    // oxlint-disable-next-line no-extend-native -- Parsing must not reach inherited properties; removed below.
    Object.defineProperties(Object.prototype, {
      accessor: {
        set: () => {
          calls++
        },
        configurable: true
      },
      readonly: { value: 0, configurable: true },
      // The escape letter `q`, which a sparse lookup table would inherit.
      113: { get: () => (calls++, "changed"), configurable: true }
    })
    try {
      assert.strictEqual(failureMessage("{\"accessor\":1,\"readonly\":2,}"), "Invalid JSONC at line 1, column 28")
      assert.strictEqual(failureMessage(String.raw`"\q"`), "Invalid JSONC at line 1, column 3")
      assert.strictEqual(calls, 0)
    } finally {
      for (const key of ["accessor", "readonly", "113"]) delete (Object.prototype as Record<string, unknown>)[key]
    }
  })

  it("locates errors beyond the JavaScript call-stack limit", () => {
    assert.strictEqual(failureMessage("[".repeat(10_000) + "?"), "Invalid JSONC at line 1, column 10001")
  })
})
