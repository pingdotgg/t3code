import {
  deepEqual,
  hasUnresolvedInputs,
  havePropsChanged,
  stripEffects,
  stripUnresolved,
} from "@/Diff";
import * as Output from "@/Output";
import { describe, expect, test } from "alchemy-test";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";

describe("Diff", () => {
  describe("havePropsChanged with Redacted values", () => {
    // Config values yielded in a Worker's init phase (e.g.
    // `yield* Config.string("MY_VARIABLE")`) land in `props.env`
    // as `Redacted<string>`. Before unwrapping, every Redacted serialized
    // to the constant mask `"<redacted>"`, so a changed secret was
    // invisible to the diff and the Worker never redeployed.
    test("detects a changed yielded config value in env", () => {
      const olds = {
        env: {
          MY_VARIABLE: Redacted.make("my-variable-abc1234"),
        },
      };
      const news = {
        env: {
          MY_VARIABLE: Redacted.make("my-variable-CHANGED"),
        },
      };
      expect(havePropsChanged(olds, news)).toBe(true);
    });

    test("does not flag an unchanged yielded config value", () => {
      const olds = {
        env: {
          MY_VARIABLE: Redacted.make("my-variable-abc1234"),
        },
      };
      const news = {
        env: {
          MY_VARIABLE: Redacted.make("my-variable-abc1234"),
        },
      };
      expect(havePropsChanged(olds, news)).toBe(false);
    });

    test("detects a changed top-level Redacted value", () => {
      expect(
        havePropsChanged(
          { secret: Redacted.make("a") },
          { secret: Redacted.make("b") },
        ),
      ).toBe(true);
    });

    test("detects a Redacted value changing to a different inner type", () => {
      expect(
        havePropsChanged(
          { secret: Redacted.make("123") },
          { secret: Redacted.make(123) },
        ),
      ).toBe(true);
    });

    test("detects a changed Redacted value nested in arrays", () => {
      expect(
        havePropsChanged(
          { secrets: [Redacted.make("a"), Redacted.make("b")] },
          { secrets: [Redacted.make("a"), Redacted.make("c")] },
        ),
      ).toBe(true);
    });

    test("does not flag unchanged plain env values", () => {
      expect(
        havePropsChanged(
          { env: { MY_VARIABLE: "value" } },
          { env: { MY_VARIABLE: "value" } },
        ),
      ).toBe(false);
    });

    test("detects changed env when a Redacted value sits alongside plain values", () => {
      const olds = {
        env: {
          MY_VARIABLE: "value",
          MY_SECRET: Redacted.make("secret-1"),
        },
      };
      const news = {
        env: {
          MY_VARIABLE: "value",
          MY_SECRET: Redacted.make("secret-2"),
        },
      };
      expect(havePropsChanged(olds, news)).toBe(true);
    });
  });

  describe("deepEqual with Redacted values", () => {
    test("distinguishes Redacted values with different inner values", () => {
      expect(deepEqual(Redacted.make("a"), Redacted.make("b"))).toBe(false);
    });

    test("equates Redacted values with the same inner value", () => {
      expect(deepEqual(Redacted.make("a"), Redacted.make("a"))).toBe(true);
    });

    test("distinguishes Redacted values nested in objects", () => {
      expect(
        deepEqual(
          { secret: Redacted.make("a") },
          { secret: Redacted.make("b") },
        ),
      ).toBe(false);
    });
  });

  // effect ≥4.0.0-beta.103's Context is self-referential; every deep walker
  // must treat Effect/Layer/Context values as leaves instead of recursing
  // into (or JSON-encoding) their internals (#1082).
  describe("opaque effect values in props (#1082)", () => {
    const opaqueProps = () => ({
      name: "worker",
      exports: {
        Store: {
          kind: "durableObject",
          constructor: Effect.void,
          services: Context.empty(),
        },
      },
      layer: Layer.empty,
    });

    test("hasUnresolvedInputs treats Layer/Context as resolved leaves", () => {
      expect(
        hasUnresolvedInputs({ context: Context.empty(), layer: Layer.empty }),
      ).toBe(false);
    });

    test("stripUnresolved drops Effect/Layer/Context", () => {
      const stripped: any = stripUnresolved(opaqueProps());
      expect(stripped.name).toBe("worker");
      expect(stripped.exports.Store.kind).toBe("durableObject");
      expect(stripped.exports.Store.constructor).toBeUndefined();
      expect(stripped.exports.Store.services).toBeUndefined();
      expect(stripped.layer).toBeUndefined();
      // Round-trips through JSON — the commit boundary's contract.
      expect(() => JSON.stringify(stripped)).not.toThrow();
    });

    test("stripEffects drops Effect/Layer/Context", () => {
      const stripped: any = stripEffects(opaqueProps());
      expect(stripped.exports.Store.constructor).toBeUndefined();
      expect(stripped.exports.Store.services).toBeUndefined();
      expect(stripped.layer).toBeUndefined();
    });

    test("havePropsChanged terminates and compares only plain data", () => {
      expect(havePropsChanged(opaqueProps(), opaqueProps())).toBe(false);
      expect(
        havePropsChanged(opaqueProps(), {
          ...opaqueProps(),
          name: "renamed",
        }),
      ).toBe(true);
    });

    test("deepEqual does not recurse into Context internals", () => {
      expect(
        deepEqual({ ctx: Context.empty() }, { ctx: Context.empty() }),
      ).toBe(true);
    });

    test("havePropsChanged terminates on cyclic plain objects", () => {
      const make = () => {
        const cyclic: any = { name: "cycle" };
        cyclic.self = cyclic;
        return { config: cyclic };
      };
      // The full comparison — stripUnresolved cuts the cycle, so the
      // JSON.stringify comparison sees identical truncated shapes.
      expect(havePropsChanged(make(), make())).toBe(false);
      expect(havePropsChanged(make(), { ...make(), extra: "x" } as any)).toBe(
        true,
      );
      expect(hasUnresolvedInputs(make())).toBe(false);
    });
  });

  describe("hasUnresolvedInputs across nesting shapes", () => {
    test("finds an Output expr deep in arrays-in-objects-in-arrays", () => {
      const expr = Output.literal("x");
      expect(
        hasUnresolvedInputs({ layers: [{ config: { hosts: [expr] } }] }),
      ).toBe(true);
      expect(hasUnresolvedInputs({ matrix: [[[expr]]] })).toBe(true);
    });

    test("finds an Effect deep in nested containers", () => {
      expect(hasUnresolvedInputs({ a: [{ b: { c: [Effect.void] } }] })).toBe(
        true,
      );
    });

    test("a shared diamond subtree containing an expr is found from either parent", () => {
      const shared = { dep: Output.literal("x") };
      expect(hasUnresolvedInputs({ left: shared, right: shared })).toBe(true);
      expect(hasUnresolvedInputs({ left: { v: 1 }, right: shared })).toBe(true);
    });

    test("fully-plain deep structures are resolved", () => {
      expect(
        hasUnresolvedInputs({ a: [{ b: [[{ c: 1 }]], d: new Date(0) }] }),
      ).toBe(false);
    });
  });

  describe("stripUnresolved semantics", () => {
    test("preserves Date/Redacted/Duration by identity", () => {
      const date = new Date(0);
      const secret = Redacted.make("s");
      const dur = Duration.seconds(5);
      const stripped: any = stripUnresolved({ date, secret, dur });
      expect(stripped.date).toBe(date);
      expect(stripped.secret).toBe(secret);
      expect(stripped.dur).toBe(dur);
    });

    test("drops Output exprs and Effects at any nesting depth", () => {
      const stripped: any = stripUnresolved({
        deep: [{ inner: { expr: Output.literal("x") } }],
        arr: [[Effect.void]],
        keep: [{ v: 1 }],
      });
      expect(stripped.deep[0].inner.expr).toBeUndefined();
      expect(stripped.arr[0][0]).toBeUndefined();
      expect(stripped.keep).toEqual([{ v: 1 }]);
    });

    test("cuts cycles but preserves diamonds", () => {
      const shared = { v: 1 };
      const cyclic: any = { name: "c" };
      cyclic.self = cyclic;
      const stripped: any = stripUnresolved({
        left: shared,
        right: shared,
        cyc: cyclic,
      });
      expect(stripped.left).toEqual({ v: 1 });
      expect(stripped.right).toEqual({ v: 1 });
      expect(stripped.cyc.name).toBe("c");
      expect(stripped.cyc.self).toBeUndefined();
      expect(() => JSON.stringify(stripped)).not.toThrow();
    });
  });

  describe("stripEffects semantics", () => {
    test("keeps Output exprs intact but drops Effects, deeply", () => {
      const expr = Output.literal("x");
      const stripped: any = stripEffects({
        deep: [{ expr, eff: Effect.void }],
      });
      expect(stripped.deep[0].expr).toBe(expr);
      expect(stripped.deep[0].eff).toBeUndefined();
    });

    test("preserves Date/Redacted/Duration and cuts cycles", () => {
      const date = new Date(0);
      const cyclic: any = { date };
      cyclic.self = cyclic;
      const stripped: any = stripEffects({ cyc: cyclic });
      expect(stripped.cyc.date).toBe(date);
      expect(stripped.cyc.self).toBeUndefined();
    });
  });

  describe("deepEqual / havePropsChanged across nesting shapes", () => {
    test("deepEqual is key-order insensitive at every depth", () => {
      expect(
        deepEqual(
          { a: [{ x: 1, y: [{ p: 1, q: 2 }] }], b: 2 },
          { b: 2, a: [{ y: [{ q: 2, p: 1 }], x: 1 }] },
        ),
      ).toBe(true);
    });

    test("deepEqual compares Dates by value", () => {
      expect(
        deepEqual({ d: new Date("2027-01-01") }, { d: new Date("2027-01-01") }),
      ).toBe(true);
      expect(
        deepEqual({ d: new Date("2027-01-01") }, { d: new Date("2027-01-02") }),
      ).toBe(false);
    });

    test("deepEqual compares Durations by value", () => {
      expect(
        deepEqual({ d: Duration.seconds(5) }, { d: Duration.seconds(5) }),
      ).toBe(true);
      expect(
        deepEqual({ d: Duration.seconds(5) }, { d: Duration.seconds(6) }),
      ).toBe(false);
    });

    test("deepEqual terminates on cyclic values on either side", () => {
      const make = () => {
        const c: any = { v: 1 };
        c.self = c;
        return c;
      };
      expect(deepEqual({ c: make() }, { c: make() })).toBe(true);
    });

    test("havePropsChanged detects a change deep in arrays-in-objects-in-arrays", () => {
      const shape = (url: string) => ({
        layers: [{ config: { hosts: [{ url }, { url: "static" }] } }],
      });
      expect(havePropsChanged(shape("a"), shape("a"))).toBe(false);
      expect(havePropsChanged(shape("a"), shape("b"))).toBe(true);
    });

    test("havePropsChanged detects array length and order changes", () => {
      expect(
        havePropsChanged({ arr: [[1, 2]] }, { arr: [[2, 1]] } as any),
      ).toBe(true);
      expect(havePropsChanged({ arr: [[1]] }, { arr: [[1], []] } as any)).toBe(
        true,
      );
    });

    test("havePropsChanged detects a changed Date", () => {
      expect(
        havePropsChanged(
          { expires: new Date("2027-01-01") },
          { expires: new Date("2027-01-01") },
        ),
      ).toBe(false);
      expect(
        havePropsChanged(
          { expires: new Date("2027-01-01") },
          { expires: new Date("2028-01-01") },
        ),
      ).toBe(true);
    });

    test("class instances never churn a diff — different instances compare equal", () => {
      class SdkConfig {
        constructor(readonly v: number) {}
      }
      // Runtime-only wiring: stripped at the commit boundary, so two deploys
      // constructing fresh instances must not report a phantom change.
      expect(
        havePropsChanged(
          { config: new SdkConfig(1) } as any,
          { config: new SdkConfig(2) } as any,
        ),
      ).toBe(false);
    });
  });
});
