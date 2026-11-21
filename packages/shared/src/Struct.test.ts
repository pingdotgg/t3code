import { describe, expect, it } from "vite-plus/test";
import { deepMerge } from "./Struct.ts";

describe("deepMerge", () => {
  it("ignores __proto__ keys instead of mutating the prototype", () => {
    const patch = JSON.parse('{"__proto__":{"polluted":true},"kept":1}') as Record<string, unknown>;
    const merged = deepMerge({} as Record<string, unknown>, patch);
    expect((merged as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(merged, "__proto__")).toBe(false);
    expect(merged).toEqual({ kept: 1 });
  });
  it("strips nested __proto__ keys instead of sharing them by reference", () => {
    const patch = JSON.parse(
      '{"nested":{"__proto__":{"polluted":true},"kept":1},"kept":2}',
    ) as Record<string, unknown>;
    const merged = deepMerge({} as Record<string, unknown>, patch);
    expect(merged).toEqual({ nested: { kept: 1 }, kept: 2 });
    expect(JSON.parse(JSON.stringify(merged))).toEqual({ nested: { kept: 1 }, kept: 2 });
    expect(Object.hasOwn(merged.nested as Record<string, unknown>, "__proto__")).toBe(false);
  });
  it("resolves cyclic back-references to the sanitized clone", () => {
    const nested = JSON.parse('{"__proto__":{"polluted":true},"kept":1}') as Record<
      string,
      unknown
    >;
    const patch = { nested } as Record<string, unknown>;
    patch.self = patch;
    const merged = deepMerge({} as Record<string, unknown>, patch);
    const mergedSelf = (merged as Record<string, unknown>).self as Record<string, unknown>;
    expect(mergedSelf).not.toBe(patch);
    expect(mergedSelf.self).toBe(mergedSelf);
    expect(mergedSelf.nested).toEqual({ kept: 1 });
    expect(Object.hasOwn(mergedSelf.nested as Record<string, unknown>, "__proto__")).toBe(false);
    expect((merged.nested as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.hasOwn(merged.nested as Record<string, unknown>, "__proto__")).toBe(false);
  });
});
