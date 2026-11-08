import { describe, expect, it } from "@alchemy.run/test";
import * as Redacted from "effect/Redacted";
import { packEnvValue, unpackEnvValue } from "@/RuntimeContext.ts";

describe("unpackEnvValue compatibility", { tags: ["unit", "local"] }, () => {
  it("returns obvious non-JSON strings unchanged without attempting JSON.parse", () => {
    const values = [
      "",
      " \t\r\n",
      "alchemy-worker",
      "https://example.com/api",
      "queue-name",
      "  bucket-name\t",
      "Infinity",
      "NaN",
      "+1",
      ".5",
      "\ufefftrue",
      "\u00a0null",
    ];
    const parse = JSON.parse;
    let calls = 0;
    const results: unknown[] = [];
    // This synchronous probe cannot overlap another test's JavaScript. Restore
    // before assertions, and even if the function under test throws.
    try {
      JSON.parse = (...args: Parameters<typeof JSON.parse>) => {
        calls++;
        return parse(...args);
      };
      for (const value of values) results.push(unpackEnvValue(value));
    } finally {
      JSON.parse = parse;
    }
    expect(results).toEqual(values);
    expect(calls).toBe(0);
  });

  it("skips JSON.parse only for strings JSON.parse rejects (every first character)", () => {
    // A JSON text is `ws value ws`; only these characters start a value. Sweep
    // every UTF-16 code unit behind each JSON-whitespace prefix, followed by
    // suffixes that complete any value form, and require that every string
    // the guard returns raw also fails JSON.parse — and decodes as before.
    const parses = (raw: string) => {
      try {
        JSON.parse(raw);
        return true;
      } catch {
        return false;
      }
    };
    const starts = new Set<string>();
    const falsePositives: string[] = [];
    for (let code = 0; code <= 0xffff; code++) {
      const c = String.fromCharCode(code);
      for (const prefix of ["", " \t\r\n"]) {
        for (const suffix of ["", "1", '"', "]", "}", "rue", "alse", "ull"]) {
          const raw = prefix + c + suffix;
          if (!parses(raw)) continue;
          starts.add(c);
          // A parseable string never decodes to its own raw text.
          if (unpackEnvValue(raw) === raw) {
            falsePositives.push(raw);
          }
        }
      }
    }
    expect(falsePositives).toEqual([]);
    expect([...starts].sort().join("")).toBe(
      ["\t", "\n", "\r", " ", ...'"-0123456789[fnt{'].sort().join(""),
    );
  });

  it("decodes every JSON primitive form, including negative zero and escaped strings", () => {
    const cases: ReadonlyArray<readonly [string, unknown]> = [
      ["null", null],
      ["true", true],
      ["false", false],
      ["0", 0],
      ["-0", -0],
      ["123", 123],
      ["-4.5", -4.5],
      ["1e3", 1000],
      ["1E-3", 0.001],
      ["1e400", Infinity],
      ['""', ""],
      ['"line\\nbreak\\t\\u263a"', "line\nbreak\t☺"],
    ];
    for (const [raw, expected] of cases) {
      expect(Object.is(unpackEnvValue(raw), expected)).toBe(true);
    }
  });

  it("decodes arrays and objects", () => {
    expect(unpackEnvValue("[]")).toEqual([]);
    expect(unpackEnvValue("{}")).toEqual({});
    expect(unpackEnvValue('{"nested":[1,true,null,{"name":"alice"}]}')).toEqual({
      nested: [1, true, null, { name: "alice" }],
    });
  });

  it("accepts only JSON whitespace around JSON values", () => {
    for (const whitespace of [" ", "\t", "\r", "\n", " \t\r\n"]) {
      expect(unpackEnvValue(`${whitespace}true${whitespace}`)).toBe(true);
      expect(unpackEnvValue(`${whitespace}[1]${whitespace}`)).toEqual([1]);
      expect(unpackEnvValue(`${whitespace}{"a":2}${whitespace}`)).toEqual({ a: 2 });
    }
  });

  it("preserves non-JSON whitespace and BOM verbatim", () => {
    for (const whitespace of [
      "\v",
      "\f",
      "\u00a0",
      "\u1680",
      "\u2000",
      "\u2028",
      "\u2029",
      "\u202f",
      "\u205f",
      "\u3000",
      "\ufeff",
    ]) {
      for (const raw of [`${whitespace}null`, `null${whitespace}`, ` \t${whitespace}[1]`]) {
        expect(unpackEnvValue(raw)).toBe(raw);
      }
    }
  });

  it("falls back to the exact raw string for malformed JSON candidates", () => {
    for (const raw of [
      "{",
      "{not json",
      "[1,]",
      "[undefined]",
      '"unterminated',
      '"\\x20"',
      "01",
      "-",
      "1e",
      "trueish",
      "false null",
      "nullish",
      " \t{bad}\r\n",
    ]) {
      expect(unpackEnvValue(raw)).toBe(raw);
    }
  });

  it("returns a fresh decoded object on every evaluation", () => {
    const raw = '{"items":[{"value":1}]}';
    const first = unpackEnvValue<{ items: Array<{ value: number }> }>(raw)!;
    first.items[0]!.value = 99;
    const second = unpackEnvValue<{ items: Array<{ value: number }> }>(raw)!;
    expect(second).toEqual({ items: [{ value: 1 }] });
    expect(first === second).toBe(false);
    expect(first.items === second.items).toBe(false);
  });

  it("reconstructs fresh Redacted values, including whitespace-prefixed markers", () => {
    const raw = ` \t\r\n${packEnvValue(Redacted.make({ token: "secret" }))}\n`;
    const first = unpackEnvValue<Redacted.Redacted<{ token: string }>>(raw)!;
    const second = unpackEnvValue<Redacted.Redacted<{ token: string }>>(raw)!;
    expect(Redacted.isRedacted(first)).toBe(true);
    expect(Redacted.value(first)).toEqual({ token: "secret" });
    expect(first === second).toBe(false);
    expect(Redacted.value(first) === Redacted.value(second)).toBe(false);
    expect(unpackEnvValue('{"_tag":"Redacted"}')).toEqual({ _tag: "Redacted" });
    expect(unpackEnvValue('{"_tag":"Other","value":1}')).toEqual({
      _tag: "Other",
      value: 1,
    });
  });

  it("preserves undefined", () => {
    expect(unpackEnvValue(undefined)).toBeUndefined();
  });

  it("preserves existing non-string coercion and fallback behavior", () => {
    // The public type accepts strings, but runtime env objects can reach this
    // boundary untyped. The guard must leave JSON.parse's coercion unchanged.
    const unpack = (raw: unknown) => unpackEnvValue(raw as string);
    expect(unpack(null)).toBeNull();
    expect(unpack(true)).toBe(true);
    expect(unpack(123)).toBe(123);
    expect(unpack(7n)).toBe(7);
    expect(unpack([1])).toBe(1);
    expect(unpack(new String('{"a":1}'))).toEqual({ a: 1 });
    expect(unpack({ toString: () => '["coerced"]' })).toEqual(["coerced"]);
    for (const raw of [
      [],
      [1, 2],
      {},
      Object.create(null),
      Symbol("env"),
      {
        [Symbol.toPrimitive]: () => {
          throw new Error("coercion failed");
        },
      },
    ]) {
      expect(unpack(raw)).toBe(raw);
    }
  });
});
