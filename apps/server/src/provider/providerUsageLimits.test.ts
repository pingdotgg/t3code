import { describe, expect, it } from "vite-plus/test";

import { applyUsageLimitsUpdate, resolveUsageLimitsAfterProbe } from "./providerUsageLimits.ts";

const checkedAt = "2026-09-03T12:00:00.000Z";
const session = {
  id: "five_hour",
  kind: "session",
  label: "Session",
  usedPercent: 40,
  windowDurationMins: 300,
  resetsAt: "2026-09-03T14:00:00.000Z",
} as const;
const weekly = {
  id: "seven_day",
  kind: "weekly",
  label: "Weekly",
  usedPercent: 20,
  windowDurationMins: 10_080,
} as const;
const published = { checkedAt, windows: [session, weekly] };

describe("applyUsageLimitsUpdate", () => {
  it("returns the published object itself when no window moved", () => {
    // Codex repeats the same numbers beside every token-usage tick; the
    // ingestion path relies on identity to skip the publish.
    const next = applyUsageLimitsUpdate({
      previous: published,
      checkedAt: "2026-09-03T12:00:05.000Z",
      update: {
        windows: [
          { ...weekly },
          { id: "five_hour", kind: "session", label: "Session", usedPercent: 40 },
        ],
      },
    });
    expect(next).toBe(published);
  });

  it("upserts by id and keeps the reset a percent-only update omits", () => {
    const next = applyUsageLimitsUpdate({
      previous: published,
      checkedAt: "2026-09-03T12:00:05.000Z",
      update: {
        windows: [{ id: "five_hour", kind: "session", label: "Session", usedPercent: 55 }],
      },
    });
    expect(next).not.toBe(published);
    expect(next).toEqual({
      checkedAt: "2026-09-03T12:00:05.000Z",
      windows: [{ ...session, usedPercent: 55 }, weekly],
    });
  });

  it("leaves an empty update alone and recovers windows from a mistaken unsupported lock", () => {
    const unsupported = { checkedAt, windows: [], unavailable: { reason: "unsupported" as const } };
    expect(
      applyUsageLimitsUpdate({ previous: published, checkedAt, update: { windows: [] } }),
    ).toBe(published);
    const next = applyUsageLimitsUpdate({
      previous: unsupported,
      checkedAt: "2026-09-03T12:00:05.000Z",
      update: { windows: [session] },
    });
    expect(next).toEqual({
      checkedAt: "2026-09-03T12:00:05.000Z",
      windows: [session],
      unavailable: { reason: "probeFailed" },
    });
  });

  it("keeps a failed probe marked when a sparse update lands on it", () => {
    const failed = {
      checkedAt,
      windows: [],
      unavailable: { reason: "probeFailed" as const, message: "usage timed out" },
    };
    const next = applyUsageLimitsUpdate({
      previous: failed,
      checkedAt: "2026-09-03T12:00:05.000Z",
      update: { windows: [weekly] },
    });
    expect(next).toEqual({
      checkedAt: "2026-09-03T12:00:05.000Z",
      windows: [weekly],
      unavailable: failed.unavailable,
    });
    expect(
      applyUsageLimitsUpdate({ previous: next, checkedAt, update: { windows: [weekly] } }),
    ).toBe(next);
  });

  it("marks a sparse update with no previous snapshot as probeFailed", () => {
    expect(
      applyUsageLimitsUpdate({ previous: undefined, checkedAt, update: { windows: [weekly] } }),
    ).toEqual({ checkedAt, windows: [weekly], unavailable: { reason: "probeFailed" } });
  });

  it("preserves reset credits when a streamed window update changes usage", () => {
    const resetCredits = { availableCount: 2, nextExpiresAt: "2026-10-01T00:00:00.000Z" };
    const next = applyUsageLimitsUpdate({
      previous: { ...published, resetCredits },
      checkedAt: "2026-09-03T12:00:05.000Z",
      update: { windows: [{ ...session, usedPercent: 55 }] },
    });

    expect(next).toEqual({
      checkedAt: "2026-09-03T12:00:05.000Z",
      windows: [{ ...session, usedPercent: 55 }, weekly],
      resetCredits,
    });
  });
});

describe("resolveUsageLimitsAfterProbe", () => {
  it("keeps the last good windows through a failed probe but not an unsupported one", () => {
    const failed = { checkedAt, windows: [], unavailable: { reason: "probeFailed" as const } };
    const unsupported = { checkedAt, windows: [], unavailable: { reason: "unsupported" as const } };
    expect(resolveUsageLimitsAfterProbe({ published, probed: failed })).toBe(published);
    expect(resolveUsageLimitsAfterProbe({ published, probed: unsupported })).toBe(unsupported);
    expect(resolveUsageLimitsAfterProbe({ published: undefined, probed: failed })).toBe(failed);
  });

  it("keeps turn-reported windows through a later failed or unsupported probe", () => {
    const failed = { checkedAt, windows: [], unavailable: { reason: "probeFailed" as const } };
    const partial = applyUsageLimitsUpdate({
      previous: failed,
      checkedAt: "2026-09-03T12:00:05.000Z",
      update: { windows: [weekly] },
    });
    expect(resolveUsageLimitsAfterProbe({ published: partial, probed: failed })).toBe(partial);
    expect(
      resolveUsageLimitsAfterProbe({
        published: partial,
        probed: { checkedAt, windows: [], unavailable: { reason: "unsupported" } },
      }),
    ).toBe(partial);
  });
});
