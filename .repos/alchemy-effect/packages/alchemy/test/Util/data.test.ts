import {
  isPlainObject,
  stripNullFields,
  stripUndefinedFields,
  unwrapRedacted,
} from "@/Util/data";
import * as Redacted from "effect/Redacted";
import { describe, expect, test } from "alchemy-test";

describe("data utilities", () => {
  test("isPlainObject accepts object literals", () => {
    expect(isPlainObject({})).toBe(true);
  });

  test("isPlainObject rejects arrays and object instances", () => {
    expect(isPlainObject([])).toBe(false);
    expect(isPlainObject(Object.create(null))).toBe(false);
    expect(isPlainObject(new Date())).toBe(false);
    expect(isPlainObject(Redacted.make("secret"))).toBe(false);
  });

  test("stripNullFields removes nulls recursively from arrays and records", () => {
    expect(
      stripNullFields({
        a: null,
        b: undefined,
        c: [{ d: null, e: 1 }],
      }),
    ).toEqual({
      b: undefined,
      c: [{ e: 1 }],
    });
  });

  test("stripUndefinedFields removes undefined recursively from arrays and records", () => {
    expect(
      stripUndefinedFields({
        a: null,
        b: undefined,
        c: [{ d: undefined, e: 1 }],
      }),
    ).toEqual({
      a: null,
      c: [{ e: 1 }],
    });
  });

  test("unwrapRedacted unwraps only arrays and plain records recursively", () => {
    const date = new Date("2026-05-20T00:00:00.000Z");

    expect(
      unwrapRedacted({
        value: Redacted.make("secret"),
        nested: [Redacted.make("nested")],
        date,
      }),
    ).toEqual({
      value: "secret",
      nested: ["nested"],
      date,
    });
  });
});
