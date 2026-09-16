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

  it("leaves an empty update alone", () => {
    expect(
      applyUsageLimitsUpdate({ previous: published, checkedAt, update: { windows: [] } }),
    ).toBe(published);
  });

  // Claude Team and Enterprise accounts probe as unsupported and then stream
  // their real windows on every turn, so the turn has to win.
  it("clears an unsupported snapshot once a turn reports a window", () => {
    const unsupported = { checkedAt, windows: [], unavailable: { reason: "unsupported" as const } };
    expect(
      applyUsageLimitsUpdate({ previous: unsupported, checkedAt, update: { windows: [session] } }),
    ).toEqual({ checkedAt, windows: [session] });
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
  const asOf = checkedAt;
  const failed = { checkedAt, windows: [], unavailable: { reason: "probeFailed" as const } };
  const unsupported = { checkedAt, windows: [], unavailable: { reason: "unsupported" as const } };

  it("keeps the last good windows through a failed probe", () => {
    expect(resolveUsageLimitsAfterProbe({ asOf, published, probed: failed })).toBe(published);
    expect(resolveUsageLimitsAfterProbe({ asOf, published: undefined, probed: failed })).toBe(
      failed,
    );
  });

  it("keeps the last good windows when the probe omits usageLimits entirely", () => {
    // Every driver omits usageLimits on early-return failure paths (missing
    // executable, spawn failure, timeout), and some drivers never populate it
    // at all. That carries no information, so it must not erase windows a
    // runtime update already established.
    expect(resolveUsageLimitsAfterProbe({ asOf, published, probed: undefined })).toBe(published);
    expect(resolveUsageLimitsAfterProbe({ asOf, published: undefined, probed: undefined })).toBe(
      undefined,
    );
  });

  // A driver that never reports usage limits leaves no probe timestamp, so
  // the refresh's own clock has to age the preserved windows out; otherwise a
  // provider whose executable went missing shows the same bars forever.
  it("ages preserved windows out when the probe omits usageLimits entirely", () => {
    const expiredSession = { ...session, resetsAt: "2026-09-03T11:00:00.000Z" };
    const partiallyExpired = { checkedAt, windows: [expiredSession, weekly] };
    expect(
      resolveUsageLimitsAfterProbe({ asOf, published: partiallyExpired, probed: undefined }),
    ).toEqual({ checkedAt, windows: [weekly] });
    expect(
      resolveUsageLimitsAfterProbe({
        asOf,
        published: { checkedAt, windows: [expiredSession] },
        probed: undefined,
      }),
    ).toBe(undefined);
  });

  // A probe that reads windows never answers unsupported, so windows on screen
  // mean a turn reported limits this probe cannot see. Blanking them here
  // would flicker the bars off on every status refresh. Only Claude asks for
  // this treatment; it's the provider whose probe misreads Team/Enterprise
  // accounts.
  it("keeps windows a turn established through an unsupported probe when opted in", () => {
    expect(
      resolveUsageLimitsAfterProbe({
        asOf,
        published,
        probed: unsupported,
        keepPublishedWindowsWhenProbeUnsupported: true,
      }),
    ).toBe(published);
  });

  it("reports unsupported over stale windows when not opted in", () => {
    // Codex's probe reporting unsupported (e.g. right after an account
    // switch) is authoritative and must replace the previous account's bars.
    expect(resolveUsageLimitsAfterProbe({ asOf, published, probed: unsupported })).toBe(
      unsupported,
    );
  });

  it("still reports unsupported when no windows were ever drawn", () => {
    expect(resolveUsageLimitsAfterProbe({ asOf, published: undefined, probed: unsupported })).toBe(
      unsupported,
    );
    expect(resolveUsageLimitsAfterProbe({ asOf, published: failed, probed: unsupported })).toBe(
      unsupported,
    );
  });

  // An interval probe runs whether or not a turn ever streams a fresh
  // reading, so a preserved window has to age out once its own resetsAt
  // passes rather than showing last window's percentage forever.
  it("drops a preserved window once its own resetsAt has passed", () => {
    const expiredSession = { ...session, resetsAt: "2026-09-03T11:00:00.000Z" };
    const partiallyExpired = { checkedAt, windows: [expiredSession, weekly] };
    const laterUnsupported = {
      checkedAt: "2026-09-03T11:30:00.000Z",
      windows: [],
      unavailable: { reason: "unsupported" as const },
    };
    expect(
      resolveUsageLimitsAfterProbe({
        asOf,
        published: partiallyExpired,
        probed: laterUnsupported,
        keepPublishedWindowsWhenProbeUnsupported: true,
      }),
    ).toEqual({ checkedAt, windows: [weekly] });
  });

  it("falls back to the probe result once every preserved window has expired", () => {
    const expiredOnly = {
      checkedAt,
      windows: [{ ...session, resetsAt: "2026-09-03T11:00:00.000Z" }],
    };
    const laterUnsupported = {
      checkedAt: "2026-09-03T11:30:00.000Z",
      windows: [],
      unavailable: { reason: "unsupported" as const },
    };
    expect(
      resolveUsageLimitsAfterProbe({
        asOf,
        published: expiredOnly,
        probed: laterUnsupported,
        keepPublishedWindowsWhenProbeUnsupported: true,
      }),
    ).toBe(laterUnsupported);
  });

  // A window streamed by a turn often carries only its length, never a
  // reset timestamp; it has to age out from the read that recorded it.
  it("drops a preserved window bounded only by windowDurationMins", () => {
    const streamed = { checkedAt, windows: [{ ...session, resetsAt: undefined }, weekly] };
    const laterUnsupported = {
      checkedAt: "2026-09-03T18:00:00.000Z",
      windows: [],
      unavailable: { reason: "unsupported" as const },
    };
    expect(
      resolveUsageLimitsAfterProbe({
        asOf,
        published: streamed,
        probed: laterUnsupported,
        keepPublishedWindowsWhenProbeUnsupported: true,
      }),
    ).toEqual({ checkedAt, windows: [weekly] });
  });

  it("ages preserved windows out across a failed probe too", () => {
    const expiredSession = { ...session, resetsAt: "2026-09-03T11:00:00.000Z" };
    const partiallyExpired = { checkedAt, windows: [expiredSession, weekly] };
    const laterFailed = {
      checkedAt: "2026-09-03T11:30:00.000Z",
      windows: [],
      unavailable: { reason: "probeFailed" as const },
    };
    expect(
      resolveUsageLimitsAfterProbe({ asOf, published: partiallyExpired, probed: laterFailed }),
    ).toEqual({ checkedAt, windows: [weekly] });
  });
});
