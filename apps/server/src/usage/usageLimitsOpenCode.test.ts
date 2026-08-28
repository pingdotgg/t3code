import { describe, expect, it } from "@effect/vitest";

import {
  parseOpenCodeAuthState,
  parseOpenCodeErrorType,
  parseOpenCodeUsageWindows,
} from "./usageLimitsOpenCode.ts";

describe("parseOpenCodeAuthState", () => {
  it("picks the Zen API key from the provider-keyed map", () => {
    const raw = JSON.stringify({
      opencode: { type: "api", key: "zen-key" },
      anthropic: { type: "oauth", refresh: "r", access: "a", expires: 1 },
    });
    expect(parseOpenCodeAuthState(raw)).toEqual({ kind: "zen", key: "zen-key" });
  });

  it("reports pass-through-only sign-ins as other", () => {
    const raw = JSON.stringify({
      anthropic: { type: "oauth", refresh: "r", access: "a", expires: 1 },
    });
    expect(parseOpenCodeAuthState(raw)).toEqual({ kind: "other" });
    // A non-api opencode entry cannot query the usage endpoint either.
    expect(
      parseOpenCodeAuthState(
        JSON.stringify({ opencode: { type: "oauth", refresh: "r", access: "a", expires: 1 } }),
      ),
    ).toEqual({ kind: "other" });
  });

  it("returns null for junk and empty stores", () => {
    expect(parseOpenCodeAuthState("not json")).toBeNull();
    expect(parseOpenCodeAuthState("{}")).toBeNull();
    expect(
      parseOpenCodeAuthState(JSON.stringify({ opencode: { type: "api", key: " " } })),
    ).toBeNull();
  });
});

describe("parseOpenCodeErrorType", () => {
  it("reads the error marker, tolerating junk", () => {
    expect(
      parseOpenCodeErrorType({
        type: "error",
        error: { type: "EntitlementError", message: "OpenCode Go subscription required." },
      }),
    ).toBe("EntitlementError");
    expect(parseOpenCodeErrorType({ error: {} })).toBeNull();
    expect(parseOpenCodeErrorType(null)).toBeNull();
  });
});

describe("parseOpenCodeUsageWindows", () => {
  // Shape observed live from opencode.ai/zen/go/v1/usage (2026-08-18).
  const liveResponse = {
    usage: {
      rolling: { status: "ok", percent: 0, resetsAt: "2026-08-18T11:52:51.022Z" },
      weekly: { status: "ok", percent: 7, resetsAt: "2026-08-24T00:00:00.022Z" },
      monthly: { status: "ok", percent: 4, resetsAt: "2026-09-14T19:31:40.022Z" },
    },
  };

  it("maps the rolling, weekly and monthly windows", () => {
    expect(parseOpenCodeUsageWindows(liveResponse)).toEqual([
      {
        id: "rolling",
        label: "Session limit",
        detail: "Rolling 5-hour window",
        utilization: 0,
        resetsAt: "2026-08-18T11:52:51.022Z",
      },
      {
        id: "weekly",
        label: "Weekly limit",
        detail: "Weekly window",
        utilization: 7,
        resetsAt: "2026-08-24T00:00:00.022Z",
      },
      {
        id: "monthly",
        label: "Monthly limit",
        detail: "Monthly window",
        utilization: 4,
        resetsAt: "2026-09-14T19:31:40.022Z",
      },
    ]);
  });

  it("keeps unknown windows with a humanised label and clamps utilization", () => {
    const windows = parseOpenCodeUsageWindows({
      usage: {
        weekly: { status: "rate-limited", percent: 103.5, resetsAt: null },
        black_rolling: { status: "ok", percent: 12, resetsAt: "2026-09-01T00:00:00Z" },
      },
    });
    expect(windows).toEqual([
      {
        id: "weekly",
        label: "Weekly limit",
        detail: "Weekly window",
        utilization: 103.5,
        resetsAt: null,
      },
      {
        id: "black_rolling",
        label: "Black rolling",
        detail: null,
        utilization: 12,
        resetsAt: "2026-09-01T00:00:00Z",
      },
    ]);
  });

  it("returns empty for malformed documents", () => {
    expect(parseOpenCodeUsageWindows(null)).toEqual([]);
    expect(parseOpenCodeUsageWindows({ usage: null })).toEqual([]);
    expect(parseOpenCodeUsageWindows({ usage: { weekly: { percent: "lots" } } })).toEqual([]);
  });
});
