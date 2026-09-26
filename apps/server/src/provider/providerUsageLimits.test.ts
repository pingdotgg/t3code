import type { ServerProviderUsageLimits } from "@t3tools/contracts";
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
  const checkStartedAt = Date.parse(checkedAt);

  it("keeps the last good windows through a failed probe but not an unsupported one", () => {
    const failed = { checkedAt, windows: [], unavailable: { reason: "probeFailed" as const } };
    const unsupported = { checkedAt, windows: [], unavailable: { reason: "unsupported" as const } };
    expect(resolveUsageLimitsAfterProbe({ published, probed: failed, checkStartedAt })).toBe(
      published,
    );
    expect(resolveUsageLimitsAfterProbe({ published, probed: unsupported, checkStartedAt })).toBe(
      unsupported,
    );
    expect(
      resolveUsageLimitsAfterProbe({ published: undefined, probed: failed, checkStartedAt }),
    ).toBe(failed);
  });

  it("keeps a turn update over an older cached read, not over a fresh probe", () => {
    const startedAt = Date.parse("2026-09-03T12:05:00.000Z");
    const turnUpdate = { checkedAt: "2026-09-03T12:04:00.000Z", windows: [session] };
    // Claude instances share cached probes, so a read can predate the check.
    const cached = { checkedAt: "2026-09-03T12:01:00.000Z", windows: [session, weekly] };
    // Codex dates its read at the check start, and a turn can update mid-probe.
    const fresh = { checkedAt: "2026-09-03T12:05:00.000Z", windows: [session, weekly] };
    const midProbeUpdate = { checkedAt: "2026-09-03T12:05:02.000Z", windows: [session] };
    const resolve = (current: ServerProviderUsageLimits, probed: ServerProviderUsageLimits) =>
      resolveUsageLimitsAfterProbe({ published: current, probed, checkStartedAt: startedAt });
    expect(resolve(turnUpdate, cached)).toEqual(turnUpdate);
    // The check read credits itself, so a spent credit does not survive.
    const spent = { availableCount: 1, nextCreditId: "spent" };
    const current = { availableCount: 0 };
    expect(
      resolve({ ...turnUpdate, resetCredits: spent }, { ...cached, resetCredits: current }),
    ).toEqual({ ...turnUpdate, resetCredits: current });
    expect(resolve({ ...turnUpdate, resetCredits: spent }, cached)).toEqual(turnUpdate);
    expect(resolve(midProbeUpdate, fresh)).toBe(fresh);
    expect(resolve(published, cached)).toBe(cached);
  });
});
