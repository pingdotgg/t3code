import {
  isPlainData,
  isPlainObject,
  mapPlainData,
  stripNullFields,
  stripUndefinedFields,
  unwrapRedacted,
} from "@/Util/data";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
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

// The engine's traversal rule (#1082): plain data is walked; every class
// instance is a leaf. isPlainData is the single gate, mapPlainData the
// single cycle-guarded rebuild — pin their exact semantics here.
describe("isPlainData", () => {
  test("accepts arrays, object literals, and null-prototype objects", () => {
    expect(isPlainData([])).toBe(true);
    expect(isPlainData([1, 2, 3])).toBe(true);
    expect(isPlainData({})).toBe(true);
    expect(isPlainData({ a: 1 })).toBe(true);
    expect(isPlainData(Object.create(null))).toBe(true);
  });

  test("rejects primitives and functions", () => {
    expect(isPlainData(undefined)).toBe(false);
    expect(isPlainData(null)).toBe(false);
    expect(isPlainData(0)).toBe(false);
    expect(isPlainData("s")).toBe(false);
    expect(isPlainData(true)).toBe(false);
    expect(isPlainData(Symbol("s"))).toBe(false);
    expect(isPlainData(10n)).toBe(false);
    expect(isPlainData(() => {})).toBe(false);
  });

  test("rejects every class instance — built-in, effect, and user-defined", () => {
    class Custom {}
    expect(isPlainData(new Custom())).toBe(false);
    expect(isPlainData(new Date())).toBe(false);
    expect(isPlainData(new Map())).toBe(false);
    expect(isPlainData(new Set())).toBe(false);
    expect(isPlainData(new URL("https://example.com"))).toBe(false);
    expect(isPlainData(/regex/)).toBe(false);
    expect(isPlainData(Buffer.from("x"))).toBe(false);
    expect(isPlainData(Effect.succeed(1))).toBe(false);
    expect(isPlainData(Layer.empty)).toBe(false);
    expect(isPlainData(Context.empty())).toBe(false);
    expect(isPlainData(Redacted.make("s"))).toBe(false);
    expect(isPlainData(Duration.seconds(1))).toBe(false);
  });
});

describe("mapPlainData", () => {
  const identity = (ancestors: WeakSet<object>) => {
    const walk = (child: unknown): unknown =>
      isPlainData(child) ? mapPlainData(child, ancestors, walk) : child;
    return walk;
  };

  test("rebuilds arrays as arrays and objects as objects", () => {
    const ancestors = new WeakSet<object>();
    const rebuilt: any = mapPlainData(
      { a: [1, { b: 2 }], c: { d: [3] } },
      ancestors,
      identity(ancestors),
    );
    expect(rebuilt).toEqual({ a: [1, { b: 2 }], c: { d: [3] } });
    expect(Array.isArray(rebuilt.a)).toBe(true);
    expect(Array.isArray(rebuilt.c.d)).toBe(true);
  });

  test("cuts a self-referencing object to undefined", () => {
    const cyclic: any = { name: "x" };
    cyclic.self = cyclic;
    const ancestors = new WeakSet<object>();
    const rebuilt: any = mapPlainData(cyclic, ancestors, identity(ancestors));
    expect(rebuilt.name).toBe("x");
    expect(rebuilt.self).toBeUndefined();
  });

  test("cuts a mutual object<->array cycle to undefined", () => {
    const obj: any = { tag: "obj" };
    const arr: any[] = [obj];
    obj.arr = arr;
    const ancestors = new WeakSet<object>();
    const rebuilt: any = mapPlainData(
      { root: obj },
      ancestors,
      identity(ancestors),
    );
    expect(rebuilt.root.tag).toBe("obj");
    expect(rebuilt.root.arr[0]).toBeUndefined();
  });

  test("preserves diamonds — the same object referenced twice is rebuilt twice", () => {
    const shared = { v: 1 };
    const ancestors = new WeakSet<object>();
    const rebuilt: any = mapPlainData(
      { left: shared, right: shared, list: [shared] },
      ancestors,
      identity(ancestors),
    );
    expect(rebuilt.left).toEqual({ v: 1 });
    expect(rebuilt.right).toEqual({ v: 1 });
    expect(rebuilt.list[0]).toEqual({ v: 1 });
  });

  test("leaves the ancestors set empty afterwards (guard is path-scoped)", () => {
    const value = { a: { b: [1] } };
    const ancestors = new WeakSet<object>();
    mapPlainData(value, ancestors, identity(ancestors));
    // Re-walking the same value must not see stale ancestors.
    const again: any = mapPlainData(value, ancestors, identity(ancestors));
    expect(again).toEqual({ a: { b: [1] } });
  });
});
