import { describe, expect, it } from "vite-plus/test";

import { deepMerge, type DeepPartial } from "./Struct.ts";

describe("deepMerge", () => {
  it("performs a shallow merge of two flat objects", () => {
    const base = { a: 1, b: 2 };
    const patch = { b: 3, c: 4 };
    expect(deepMerge(base, patch)).toEqual({ a: 1, b: 3, c: 4 });
  });

  it("does not mutate the base object", () => {
    const base = { a: 1, b: 2 };
    const snapshot = { ...base };
    deepMerge(base, { b: 9 });
    expect(base).toEqual(snapshot);
  });

  it("recursively merges nested objects", () => {
    const base = { user: { name: "alice", age: 30 }, active: true };
    const patch = { user: { age: 31 } };
    expect(deepMerge(base, patch)).toEqual({
      user: { name: "alice", age: 31 },
      active: true,
    });
    expect(base.user).toEqual({ name: "alice", age: 30 });
  });

  it("merges multiple patch objects in sequence", () => {
    const base = { a: 1, nested: { x: 1, y: 2 } };
    const merged = deepMerge(deepMerge(base, { a: 2 }), { nested: { y: 9 } });
    expect(merged).toEqual({ a: 2, nested: { x: 1, y: 9 } });
    expect(base.nested).toEqual({ x: 1, y: 2 });
  });

  it("skips keys with undefined values in the patch", () => {
    const base = { a: 1, b: 2 };
    const undefinedA: unknown = undefined;
    const patch = { a: undefinedA, b: 5 } as DeepPartial<typeof base>;
    expect(deepMerge(base, patch)).toEqual({ a: 1, b: 5 });
  });

  it("returns a shallow copy of the base (nested refs shared — known limitation)", () => {
    const base = { a: 1, b: { c: 2 } };
    const merged = deepMerge(base, {});
    expect(merged).toEqual({ a: 1, b: { c: 2 } });
    // DOCUMENTED LIMITATION (not ideal): deepMerge only shallow-copies the top
    // level. Nested objects NOT touched by the patch keep the SAME reference as
    // base, so mutating `merged.b` would mutate `base.b`. A future fix should
    // deep-clone untouched nested objects. Do not "fix" this test by changing
    // the assertion to `not.toBe` until that fix lands.
    expect(merged).not.toBe(base);
    expect(merged.b).toBe(base.b);
  });

  it("handles an empty base with a populated patch", () => {
    const base = {} as Record<string, unknown>;
    const patch = { a: 1, nested: { b: 2 } };
    expect(deepMerge(base, patch)).toEqual({ a: 1, nested: { b: 2 } });
  });
});
