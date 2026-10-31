import { describe, expect, it } from "vite-plus/test";

import { classifyLinearFailure, resolveLinearDegradation } from "./degradation.ts";

const linearError = (reason: string) => ({ _tag: "LinearError", reason });
const now = Date.parse("2026-01-01T00:00:00.000Z");

describe("classifyLinearFailure", () => {
  it("reads LinearError reasons and treats transport failures as unavailable", () => {
    expect(classifyLinearFailure(linearError("rate_limited"))).toBe("rate_limited");
    expect(classifyLinearFailure(linearError("unauthorized"))).toBe("unauthorized");
    expect(classifyLinearFailure(linearError("not_connected"))).toBe("not_connected");
    expect(classifyLinearFailure(linearError("not_found"))).toBe("other");
    expect(classifyLinearFailure(new Error("socket closed"))).toBe("unavailable");
    expect(classifyLinearFailure(null)).toBe("other");
  });
});

describe("resolveLinearDegradation", () => {
  const input = { failures: [], stale: false, status: { rateLimitedUntil: null }, now };

  it("is quiet when everything is fresh", () => {
    expect(resolveLinearDegradation(input)).toBeNull();
  });

  it("prefers the rate limit over an outage", () => {
    expect(
      resolveLinearDegradation({
        ...input,
        failures: [linearError("unavailable"), linearError("rate_limited")],
      }),
    ).toBe("rate_limited");
  });

  it("honours a server-reported rate limit still in the future", () => {
    expect(
      resolveLinearDegradation({
        ...input,
        status: { rateLimitedUntil: "2026-01-01T00:05:00.000Z" },
      }),
    ).toBe("rate_limited");
    expect(
      resolveLinearDegradation({
        ...input,
        status: { rateLimitedUntil: "2025-12-31T00:00:00.000Z" },
      }),
    ).toBeNull();
  });

  it("flags stale answers and a single failed panel as unreachable", () => {
    expect(resolveLinearDegradation({ ...input, stale: true })).toBe("unavailable");
    expect(resolveLinearDegradation({ ...input, failures: [new Error("x")] })).toBe("unavailable");
  });
});
