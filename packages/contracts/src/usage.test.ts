import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { UsageThreadBreakdownInput } from "./usage.ts";

const decodeThreadInput = Schema.decodeUnknownSync(UsageThreadBreakdownInput);

describe("UsageThreadBreakdownInput", () => {
  const input = {
    sinceDay: "2026-08-01",
    untilDay: "2026-08-02",
    timeZone: "UTC",
  };

  it("accepts and trims a refresh token", () => {
    expect(decodeThreadInput({ ...input, refreshToken: "  turn-2  " }).refreshToken).toBe("turn-2");
  });

  it("rejects a blank refresh token", () => {
    expect(() => decodeThreadInput({ ...input, refreshToken: "   " })).toThrow();
  });
});
