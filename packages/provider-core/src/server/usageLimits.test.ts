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

  it("leaves an unsupported account and an empty update alone", () => {
    const unsupported = { checkedAt, windows: [], unavailable: { reason: "unsupported" as const } };
    expect(
      applyUsageLimitsUpdate({ previous: unsupported, checkedAt, update: { windows: [session] } }),
    ).toBe(unsupported);
    expect(
      applyUsageLimitsUpdate({ previous: published, checkedAt, update: { windows: [] } }),
    ).toBe(published);
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
});

describe("native permission retention", () => {
  const denied = {
    ...published,
    ordinaryUsageAllowed: false,
    ordinaryUsageCheckedAt: checkedAt,
    rateLimitReachedType: "workspace_member_usage_limit_reached",
  };
  it("keeps denial and its original probe time when windows change", () => {
    expect(
      applyUsageLimitsUpdate({
        previous: denied,
        checkedAt: "2026-09-03T12:01:00.000Z",
        update: { windows: [{ ...session, usedPercent: 1 }] },
      }),
    ).toMatchObject({
      ordinaryUsageAllowed: false,
      ordinaryUsageCheckedAt: checkedAt,
      rateLimitReachedType: denied.rateLimitReachedType,
    });
  });
  it("publishes a denial-only update with no windows", () => {
    expect(
      applyUsageLimitsUpdate({
        previous: published,
        checkedAt,
        update: { windows: [], rateLimitReachedType: denied.rateLimitReachedType },
      }),
    ).toMatchObject({
      rateLimitReachedType: denied.rateLimitReachedType,
      windows: published.windows,
    });
  });
  it("clears an explicitly cleared reason without inventing included-use permission", () => {
    expect(
      applyUsageLimitsUpdate({
        previous: denied,
        checkedAt,
        update: { windows: [], rateLimitReachedType: null },
      }),
    ).toMatchObject({
      rateLimitReachedType: null,
      ordinaryUsageAllowed: false,
      ordinaryUsageCheckedAt: checkedAt,
    });
  });
  it("only a successful new probe replaces included-use permission", () => {
    const fresh = {
      ...published,
      ordinaryUsageAllowed: true,
      ordinaryUsageCheckedAt: "2026-09-03T12:01:00.000Z",
      rateLimitReachedType: null,
    };
    expect(resolveUsageLimitsAfterProbe({ published: denied, probed: fresh })).toBe(fresh);
    expect(
      resolveUsageLimitsAfterProbe({
        published: denied,
        probed: { checkedAt, windows: [], unavailable: { reason: "probeFailed" } },
      }),
    ).toBe(denied);
  });
});

describe("spend-control sparse retention", () => {
  const allowed = {
    ...published,
    ordinaryUsageAllowed: true,
    ordinaryUsageCheckedAt: checkedAt,
    spendControlReached: false,
    rateLimitReachedType: null,
  };
  const deniedSpend = { ...allowed, spendControlReached: true };
  it("publishes a spend-control-only denial without erasing windows or freshening permission", () => {
    const update = { windows: [], spendControlReached: true };
    expect(
      applyUsageLimitsUpdate({ previous: allowed, checkedAt: "2026-09-03T12:01:00.000Z", update }),
    ).toMatchObject({
      windows: published.windows,
      spendControlReached: true,
      ordinaryUsageAllowed: true,
      ordinaryUsageCheckedAt: checkedAt,
    });
  });
  it("retains denial through window updates and reason clearing", () => {
    for (const update of [
      { windows: [{ ...session, usedPercent: 1 }] },
      { windows: [], rateLimitReachedType: null },
    ]) {
      expect(applyUsageLimitsUpdate({ previous: deniedSpend, checkedAt, update })).toMatchObject({
        spendControlReached: true,
        ordinaryUsageCheckedAt: checkedAt,
      });
    }
  });
  it.each([false, null])(
    "records explicit %s without manufacturing permission or probe freshness",
    (spendControlReached) => {
      const previous = { ...deniedSpend, ordinaryUsageAllowed: false };
      const update = { windows: [], spendControlReached };
      expect(
        applyUsageLimitsUpdate({ previous, checkedAt: "2026-09-03T12:01:00.000Z", update }),
      ).toMatchObject({
        spendControlReached,
        ordinaryUsageAllowed: false,
        ordinaryUsageCheckedAt: checkedAt,
        windows: previous.windows,
      });
    },
  );
  it("does not invent permission when a spend-only update starts the published snapshot", () => {
    const update = { windows: [], spendControlReached: true };
    const next = applyUsageLimitsUpdate({ previous: undefined, checkedAt, update });
    expect(next).toMatchObject({ spendControlReached: true, windows: [] });
    expect(next).not.toHaveProperty("ordinaryUsageAllowed");
    expect(next).not.toHaveProperty("ordinaryUsageCheckedAt");
  });
  it("keeps no-op identity and unsupported accounts", () => {
    const update = { windows: [], spendControlReached: true };
    expect(applyUsageLimitsUpdate({ previous: deniedSpend, checkedAt, update })).toBe(deniedSpend);
    const unsupported = { checkedAt, windows: [], unavailable: { reason: "unsupported" as const } };
    expect(applyUsageLimitsUpdate({ previous: unsupported, checkedAt, update })).toBe(unsupported);
  });
  it("a failed probe keeps denial while successful missing or null data remains unknown", () => {
    expect(
      resolveUsageLimitsAfterProbe({
        published: deniedSpend,
        probed: { checkedAt, windows: [], unavailable: { reason: "probeFailed" } },
      }),
    ).toBe(deniedSpend);
    const missing = {
      ...published,
      ordinaryUsageAllowed: true,
      ordinaryUsageCheckedAt: checkedAt,
      rateLimitReachedType: null,
    };
    expect(resolveUsageLimitsAfterProbe({ published: deniedSpend, probed: missing })).toBe(missing);
    const unavailable = { ...deniedSpend, spendControlReached: null };
    expect(resolveUsageLimitsAfterProbe({ published: deniedSpend, probed: unavailable })).toBe(
      unavailable,
    );
  });
});
