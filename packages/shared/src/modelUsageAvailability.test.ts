import { describe, expect, it } from "vitest";
import type { ServerProviderUsageLimits, ServerProviderUsageWindow } from "@t3tools/contracts";
import { modelUsageAvailability } from "./usageLimits";

const now = Date.parse("2026-09-05T12:00:00Z");
const window = (
  id: string,
  usedPercent: number,
  resetsAt = "2026-09-05T13:00:00Z",
): ServerProviderUsageWindow => ({ id, usedPercent, resetsAt, label: id, kind: "session" });
const limits = (...windows: ServerProviderUsageWindow[]): ServerProviderUsageLimits => ({
  checkedAt: new Date(now).toISOString(),
  windows,
});

describe("model subscription availability", () => {
  it("requires fresh positive evidence for unattended starts", () => {
    expect(modelUsageAvailability(undefined, "gpt-5", now).status).toBe("unknown");
    expect(modelUsageAvailability(limits(), "gpt-5", now).status).toBe("unknown");
    expect(modelUsageAvailability(limits(window("primary", 99)), "gpt-5", now).status).toBe(
      "available",
    );
    expect(
      modelUsageAvailability(limits(window("primary", 99)), "gpt-5", now + 6 * 60_000).status,
    ).toBe("unknown");
    expect(
      modelUsageAvailability(
        { ...limits(window("primary", 0)), unavailable: { reason: "probeFailed" } },
        "gpt-5",
        now,
      ).status,
    ).toBe("unknown");
  });
  it("waits for all applicable windows and does not infer recovery from elapsed reset time", () => {
    const snapshot = limits(
      window("primary", 100),
      window("secondary", 100, "2026-09-06T12:00:00Z"),
    );
    expect(modelUsageAvailability(snapshot, "gpt-5", now)).toEqual({
      status: "exhausted",
      resetsAt: Date.parse("2026-09-06T12:00:00Z"),
    });
    expect(modelUsageAvailability(snapshot, "gpt-5", now + 2 * 24 * 3600_000).status).toBe(
      "exhausted",
    );
    expect(
      modelUsageAvailability(limits(window("primary", 0, "2026-09-05T11:00:00Z")), "gpt-5", now)
        .status,
    ).toBe("unknown");
  });
  it("matches model-specific windows without blocking a different Claude model", () => {
    const snapshot = limits(window("five_hour", 50), window("seven_day_opus", 100));
    expect(modelUsageAvailability(snapshot, "claude-opus-5", now).status).toBe("exhausted");
    expect(modelUsageAvailability(snapshot, "claude-fable-5", now).status).toBe("available");
  });
  it("keeps an exhausted window with unknown reset blocked", () => {
    expect(
      modelUsageAvailability(
        limits({ id: "primary", usedPercent: 100, kind: "session", label: "Session" }),
        "gpt-5",
        now,
      ),
    ).toEqual({ status: "exhausted", resetsAt: null });
  });
});
