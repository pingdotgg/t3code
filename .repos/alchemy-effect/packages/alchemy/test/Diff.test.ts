import { deepEqual, havePropsChanged } from "@/Diff";
import { describe, expect, test } from "alchemy-test";
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
});
