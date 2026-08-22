import { describe, expect, it } from "vite-plus/test";
import type { ServerProviderUsageLimits } from "@t3tools/contracts";
import {
  applyRuntimeUsageLimits,
  clampPercent,
  makeUsageLimitsSnapshot,
  resolveUsageLimitsAfterRefresh,
  windowKindFromDuration,
} from "./providerUsageLimits.ts";

describe("providerUsageLimits", () => {
  it("clamps percentages into the supported range", () => {
    expect(clampPercent(-10)).toBe(0);
    expect(clampPercent(42)).toBe(42);
    expect(clampPercent(150)).toBe(100);
  });

  it("maps the shortest window to session and the longest to weekly", () => {
    expect(
      makeUsageLimitsSnapshot({
        source: "codexAppServer",
        checkedAt: "2026-04-17T10:00:00.000Z",
        unavailableReason: "missing",
        windows: [
          {
            label: "Five hour",
            usedPercent: 10,
            windowDurationMins: 300,
          },
          {
            label: "Seven day",
            usedPercent: 20,
            windowDurationMins: 10_080,
          },
        ],
      }).windows,
    ).toEqual([
      {
        kind: "session",
        label: "Five hour",
        usedPercent: 10,
        windowDurationMins: 300,
      },
      {
        kind: "weekly",
        label: "Seven day",
        usedPercent: 20,
        windowDurationMins: 10080,
      },
    ]);
    expect(
      windowKindFromDuration({
        windowDurationMins: 300,
        shortestWindowDurationMins: 300,
        longestWindowDurationMins: 10080,
      }),
    ).toBe("session");
    expect(
      windowKindFromDuration({
        windowDurationMins: 10080,
        shortestWindowDurationMins: 300,
        longestWindowDurationMins: 10080,
      }),
    ).toBe("weekly");
  });

  it("keeps intermediate windows as session instead of dropping them", () => {
    expect(
      makeUsageLimitsSnapshot({
        source: "codexAppServer",
        checkedAt: "2026-04-17T10:00:00.000Z",
        unavailableReason: "missing",
        windows: [
          { label: "Short", usedPercent: 10, windowDurationMins: 60 },
          { label: "Middle", usedPercent: 20, windowDurationMins: 1440 },
          { label: "Long", usedPercent: 30, windowDurationMins: 4320 },
        ],
      }).windows,
    ).toEqual([
      {
        kind: "session",
        label: "Short",
        usedPercent: 10,
        windowDurationMins: 60,
      },
      {
        kind: "session",
        label: "Middle",
        usedPercent: 20,
        windowDurationMins: 1440,
      },
      {
        kind: "weekly",
        label: "Long",
        usedPercent: 30,
        windowDurationMins: 4320,
      },
    ]);
  });
});

describe("applyRuntimeUsageLimits", () => {
  const previous: ServerProviderUsageLimits = {
    source: "claudeStatusProbe",
    available: true,
    checkedAt: "2026-08-09T10:00:00.000Z",
    windows: [
      {
        kind: "session",
        label: "Session",
        usedPercent: 10,
        windowDurationMins: 300,
        resetsAt: "2026-08-09T15:00:00.000Z",
      },
      {
        kind: "weekly",
        label: "Weekly",
        usedPercent: 20,
        windowDurationMins: 10_080,
        resetsAt: "2026-08-16T00:00:00.000Z",
      },
    ],
  };

  it("upserts by kind and leaves the untouched window alone", () => {
    const next = applyRuntimeUsageLimits({
      previous,
      source: "claudeStatusProbe",
      checkedAt: "2026-08-09T11:00:00.000Z",
      windows: [{ label: "Session", usedPercent: 55, windowDurationMins: 300 }],
    });

    expect(next?.checkedAt).toBe("2026-08-09T11:00:00.000Z");
    expect(next?.windows).toEqual([
      {
        kind: "session",
        label: "Session",
        usedPercent: 55,
        windowDurationMins: 300,
        // Carried over: the event reports a percentage only.
        resetsAt: "2026-08-09T15:00:00.000Z",
      },
      previous.windows[1],
    ]);
  });

  it("keeps the previous snapshot when the update parses to nothing", () => {
    expect(
      applyRuntimeUsageLimits({
        previous,
        source: "claudeStatusProbe",
        checkedAt: "2026-08-09T11:00:00.000Z",
        windows: [],
      }),
    ).toBe(previous);
  });

  it("does not merge windows out of an unavailable snapshot", () => {
    const next = applyRuntimeUsageLimits({
      previous: {
        source: "claudeStatusProbe",
        available: false,
        reason: "Could not read usage limits for this Claude account.",
        checkedAt: "2026-08-09T10:00:00.000Z",
        windows: [],
      },
      source: "claudeStatusProbe",
      checkedAt: "2026-08-09T11:00:00.000Z",
      windows: [{ label: "Weekly", usedPercent: 30, windowDurationMins: 10_080 }],
    });

    expect(next).toEqual({
      source: "claudeStatusProbe",
      available: true,
      checkedAt: "2026-08-09T11:00:00.000Z",
      windows: [{ kind: "weekly", label: "Weekly", usedPercent: 30, windowDurationMins: 10_080 }],
    });
  });

  it("builds a fresh snapshot when there is no previous one", () => {
    const next = applyRuntimeUsageLimits({
      previous: undefined,
      source: "codexAppServer",
      checkedAt: "2026-08-09T11:00:00.000Z",
      windows: [{ label: "Weekly", usedPercent: 61, windowDurationMins: 10_080 }],
    });

    expect(next?.available).toBe(true);
    expect(next?.windows).toHaveLength(1);
  });
});

describe("resolveUsageLimitsAfterRefresh", () => {
  const probed: ServerProviderUsageLimits = {
    source: "codexAppServer",
    available: true,
    checkedAt: "2026-08-09T10:00:00.000Z",
    windows: [{ kind: "weekly", label: "Weekly", usedPercent: 20, windowDurationMins: 10_080 }],
  };
  const published: ServerProviderUsageLimits = {
    source: "codexAppServer",
    available: true,
    checkedAt: "2026-08-09T10:00:05.000Z",
    windows: [
      {
        kind: "weekly",
        label: "Weekly",
        usedPercent: 80,
        windowDurationMins: 10_080,
        resetsAt: "2026-08-16T00:00:00.000Z",
      },
    ],
  };

  it("keeps published bars when the probe comes back unavailable", () => {
    expect(
      resolveUsageLimitsAfterRefresh({
        published,
        probed: {
          source: "codexAppServer",
          available: false,
          reason: "Could not read Codex usage",
          checkedAt: "2026-08-09T10:00:10.000Z",
          windows: [],
        },
        livePatchedWindows: [],
      }),
    ).toBe(published);
  });

  it("lets an API-key unavailable probe replace previously available bars", () => {
    const apiKeyUnavailable: ServerProviderUsageLimits = {
      source: "claudeStatusProbe",
      available: false,
      reason: "Usage limits unavailable for Claude API key accounts.",
      checkedAt: "2026-08-09T10:00:10.000Z",
      windows: [],
    };
    expect(
      resolveUsageLimitsAfterRefresh({
        published,
        probed: apiKeyUnavailable,
        livePatchedWindows: [],
      }),
    ).toBe(apiKeyUnavailable);
    expect(
      resolveUsageLimitsAfterRefresh({
        published,
        probed: apiKeyUnavailable,
        livePatchedWindows: [published.windows[0]!],
      }),
    ).toBe(apiKeyUnavailable);
  });

  it("keeps published bars when an unavailable refresh follows a settings change", () => {
    const probedUnavailable: ServerProviderUsageLimits = {
      source: "claudeStatusProbe",
      available: false,
      reason: "Could not read usage limits for this Claude account.",
      checkedAt: "2026-08-09T10:00:10.000Z",
      windows: [],
    };
    expect(
      resolveUsageLimitsAfterRefresh({
        published,
        probed: probedUnavailable,
        livePatchedWindows: [],
      }),
    ).toBe(published);
  });

  it("lets a successful probe replace bars when nothing live-patched during it", () => {
    expect(
      resolveUsageLimitsAfterRefresh({
        published,
        probed,
        livePatchedWindows: [],
      }),
    ).toBe(probed);
  });

  it("folds live windows onto the probe when usage was patched during the wait", () => {
    const next = resolveUsageLimitsAfterRefresh({
      published,
      probed: {
        ...probed,
        windows: [
          { kind: "session", label: "Session", usedPercent: 10, windowDurationMins: 300 },
          probed.windows[0]!,
        ],
      },
      livePatchedWindows: [published.windows[0]!],
    });

    expect(next?.checkedAt).toBe(published.checkedAt);
    expect(next?.windows).toEqual([
      { kind: "session", label: "Session", usedPercent: 10, windowDurationMins: 300 },
      published.windows[0],
    ]);
  });

  it("keeps the probe's unpatched windows when a live patch overlaps the refresh", () => {
    const liveSession = {
      kind: "session" as const,
      label: "Session",
      usedPercent: 80,
      windowDurationMins: 300,
    };
    const next = resolveUsageLimitsAfterRefresh({
      published: { ...published, windows: [liveSession, published.windows[0]!] },
      probed: {
        ...probed,
        windows: [
          { kind: "session", label: "Session", usedPercent: 10, windowDurationMins: 300 },
          { kind: "weekly", label: "Weekly", usedPercent: 30, windowDurationMins: 10_080 },
        ],
      },
      livePatchedWindows: [liveSession],
    });

    expect(next?.windows).toEqual([
      liveSession,
      { kind: "weekly", label: "Weekly", usedPercent: 30, windowDurationMins: 10_080 },
    ]);
  });
});
