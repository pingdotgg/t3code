import { describe, expect, it } from "vite-plus/test";

import { applyUsageLimitsUpdate, resolveUsageLimitsAfterProbe } from "./usageLimits.ts";

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

  it("leaves an unsupported account and an empty update alone", () => {
    const unsupported = { checkedAt, windows: [], unavailable: { reason: "unsupported" as const } };
    expect(
      applyUsageLimitsUpdate({ previous: unsupported, checkedAt, update: { windows: [session] } }),
    ).toBe(unsupported);
    expect(
      applyUsageLimitsUpdate({ previous: published, checkedAt, update: { windows: [] } }),
    ).toBe(published);
  });

  it("marks a first sparse update as unavailable", () => {
    expect(
      applyUsageLimitsUpdate({ previous: undefined, checkedAt, update: { windows: [weekly] } }),
    ).toEqual({ checkedAt, windows: [weekly], unavailable: { reason: "probeFailed" } });
  });

  it("accepts a first whole-state report without a failure notice", () => {
    expect(
      applyUsageLimitsUpdate({
        previous: undefined,
        checkedAt,
        update: { windows: [session, weekly] },
        replace: true,
      }),
    ).toEqual(published);
  });

  it("clears all windows when a whole-state report is empty", () => {
    expect(
      applyUsageLimitsUpdate({
        previous: published,
        checkedAt,
        update: { windows: [] },
        replace: true,
      }),
    ).toEqual({ checkedAt, windows: [] });
  });

  it("clears a failed probe on replacement even when windows and time are unchanged", () => {
    const previous = {
      ...published,
      unavailable: { reason: "probeFailed" as const, message: "Could not read limits." },
    };
    expect(
      applyUsageLimitsUpdate({
        previous,
        checkedAt,
        update: { windows: [session, weekly] },
        replace: true,
      }),
    ).toEqual(published);
    expect(
      applyUsageLimitsUpdate({
        previous,
        checkedAt,
        update: { windows: [{ ...session, usedPercent: 55 }] },
      })?.unavailable,
    ).toEqual(previous.unavailable);
  });

  it("replaces the windows outright when the update is the account's whole state", () => {
    // Muse reports a window that has reset since with no reset time; a sparse
    // merge would keep the expired one.
    const restarted = {
      id: "five_hour",
      kind: "session",
      label: "Session",
      usedPercent: 0,
      windowDurationMins: 300,
    } as const;
    expect(
      applyUsageLimitsUpdate({
        previous: published,
        checkedAt: "2026-09-03T15:00:00.000Z",
        update: { windows: [restarted] },
        replace: true,
      }),
    ).toEqual({ checkedAt: "2026-09-03T15:00:00.000Z", windows: [restarted] });
    // The same report again publishes nothing new.
    expect(
      applyUsageLimitsUpdate({
        previous: published,
        checkedAt,
        update: { windows: [session, weekly] },
        replace: true,
      }),
    ).toBe(published);
    // A later report with the same windows publishes its time, so this account's
    // report still counts as the freshest when Limits merges environments.
    expect(
      applyUsageLimitsUpdate({
        previous: published,
        checkedAt: "2026-09-03T12:00:05.000Z",
        update: { windows: [session, weekly] },
        replace: true,
      }),
    ).toEqual({ ...published, checkedAt: "2026-09-03T12:00:05.000Z" });
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
  it("uses read order for windows while taking metadata from the successful probe", () => {
    const live = {
      checkedAt: "2026-09-03T12:00:05.000Z",
      windows: [
        { ...session, usedPercent: 95 },
        { ...weekly, usedPercent: 70 },
      ],
      resetCredits: { availableCount: 2 },
      externalUsage: { label: "Old dashboard", url: "https://example.com/old" },
    };
    const probed = {
      ...published,
      windows: [{ ...session, usedPercent: 0 }],
      resetCredits: { availableCount: 1 },
      externalUsage: { label: "Usage dashboard", url: "https://example.com/usage" },
    };

    expect(resolveUsageLimitsAfterProbe({ published: live, probed })).toEqual({
      ...probed,
      checkedAt: live.checkedAt,
      windows: live.windows,
    });

    const sameTime = { ...probed, checkedAt: live.checkedAt };
    const newer = { ...probed, checkedAt: "2026-09-03T12:00:06.000Z" };
    expect(resolveUsageLimitsAfterProbe({ published: live, probed: sameTime })).toEqual(sameTime);
    expect(resolveUsageLimitsAfterProbe({ published: live, probed: newer })).toEqual(newer);
  });

  it("keeps the last good windows through a failed probe but not an unsupported one", () => {
    const failed = { checkedAt, windows: [], unavailable: { reason: "probeFailed" as const } };
    const unsupported = { checkedAt, windows: [], unavailable: { reason: "unsupported" as const } };
    expect(resolveUsageLimitsAfterProbe({ published, probed: failed })).toBe(published);
    expect(resolveUsageLimitsAfterProbe({ published, probed: unsupported })).toBe(unsupported);
    expect(resolveUsageLimitsAfterProbe({ published: undefined, probed: failed })).toBe(failed);
  });
});
