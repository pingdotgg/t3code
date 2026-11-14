import { describe, expect, it } from "@effect/vitest";

import { fxSubagentOutcome } from "./subagents.ts";

describe("fx subagent replies", () => {
  it.each(["", "1", "12", "123"])("preserves literal Unicode spelling ending in u%s", (digits) => {
    for (const slashes of [1, 2]) {
      const suffix = "\\".repeat(slashes) + "u" + digits;
      const padding = "x".repeat(
        200 - '{"ok":true,"result":"'.length - JSON.stringify(suffix).length + 2,
      );
      const reply = padding + suffix + "4 more text";
      const whole = JSON.stringify({ ok: true, result: reply });
      expect(fxSubagentOutcome(whole)).toEqual({ ok: true, result: reply });
      expect(fxSubagentOutcome(Buffer.from(whole).subarray(0, 200).toString("utf8"))).toEqual({
        ok: true,
        result: padding + suffix + "…",
      });
    }
  });

  it.each([0, 1, 2])(
    "recovers incomplete Unicode escapes after %i literal backslashes",
    (slashes) => {
      for (const digits of ["", "0", "00", "000"]) {
        const prefix = "reply" + "\\".repeat(slashes * 2);
        expect(fxSubagentOutcome('{"ok":true,"result":"' + prefix + "\\u" + digits)).toEqual({
          ok: true,
          result: "reply" + "\\".repeat(slashes) + "…",
        });
      }
    },
  );

  it.each([
    ['{"ok":true,"result":"hello', { ok: true, result: "hello…" }],
    ['{"ok":false,"result":null}', { ok: false, result: null }],
    ['{"ok":true,"result":"hello"', { ok: true, result: "hello" }],
    ['{"unexpected":"body"}', undefined],
    ['{"ok":true,"result":"\\q', { ok: true, result: null }],
  ])("retains existing normalization for %s", (text, expected) => {
    expect(fxSubagentOutcome(text)).toEqual(expected);
  });
});
