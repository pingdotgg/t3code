import type { ProviderUsageWindow, ServerProvider } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import { describe, expect, it } from "vite-plus/test";

import {
  formatUsagePercent,
  formatUsageResetLabel,
  formatUsageRingLabel,
  formatUsageUpdatedAtLabel,
  pickWorstUsageWindow,
  selectProviderUsageWindows,
} from "./providerUsage.ts";

const NOW_MS = Date.parse("2026-08-09T12:00:00.000Z");

// Epoch millis -> ISO, without reaching for the global `Date` constructor.
const isoAt = (millis: number): string =>
  Option.match(DateTime.make(millis), {
    onNone: () => "",
    onSome: DateTime.formatIso,
  });
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const usageWindow = (id: string, usedPercent: number): ProviderUsageWindow => ({
  id,
  label: id,
  usedPercent,
  resetsAt: null,
});

describe("selectProviderUsageWindows", () => {
  const providers = [
    {
      instanceId: "claudeAgent",
      usageLimits: { windows: [usageWindow("session", 42)], updatedAt: "2026-08-09T12:00:00.000Z" },
    },
    { instanceId: "opencode" },
  ] as unknown as ReadonlyArray<ServerProvider>;

  it("reads the selected instance's windows", () => {
    expect(selectProviderUsageWindows(providers, "claudeAgent")).toHaveLength(1);
  });

  it("returns empty for a provider that reports no usage", () => {
    expect(selectProviderUsageWindows(providers, "opencode")).toEqual([]);
  });

  it("returns empty for an unknown or absent instance", () => {
    expect(selectProviderUsageWindows(providers, "cursor")).toEqual([]);
    expect(selectProviderUsageWindows(providers, null)).toEqual([]);
  });
});

describe("pickWorstUsageWindow", () => {
  it("picks the bucket closest to running out", () => {
    const worst = pickWorstUsageWindow([
      usageWindow("session", 42),
      usageWindow("weekly", 61),
      usageWindow("weekly-fable", 12),
    ]);
    expect(worst?.id).toBe("weekly");
  });

  it("breaks ties by array order so the circle does not flicker", () => {
    const worst = pickWorstUsageWindow([usageWindow("session", 50), usageWindow("weekly", 50)]);
    expect(worst?.id).toBe("session");
  });

  it("returns null when there is nothing to show", () => {
    expect(pickWorstUsageWindow([])).toBeNull();
  });
});

describe("formatUsageRingLabel", () => {
  it("renders bare integers so two digits fit inside the ring", () => {
    expect(formatUsageRingLabel(0)).toBe("0");
    expect(formatUsageRingLabel(42.6)).toBe("43");
    expect(formatUsageRingLabel(100)).toBe("100");
  });

  it("clamps out-of-range readings rather than drawing them", () => {
    expect(formatUsageRingLabel(140)).toBe("100");
    expect(formatUsageRingLabel(Number.NaN)).toBe("0");
  });
});

describe("formatUsagePercent", () => {
  it("keeps one decimal below 10% where rounding would read as zero", () => {
    expect(formatUsagePercent(0.4)).toBe("0.4%");
    expect(formatUsagePercent(5)).toBe("5%");
    expect(formatUsagePercent(61.4)).toBe("61%");
  });
});

describe("formatUsageResetLabel", () => {
  const at = (offsetMs: number) => isoAt(NOW_MS + offsetMs);

  it("counts down within a day", () => {
    expect(formatUsageResetLabel(at(2 * HOUR + 15 * MINUTE), NOW_MS)).toBe("resets in 2h 15m");
    expect(formatUsageResetLabel(at(3 * HOUR), NOW_MS)).toBe("resets in 3h");
    expect(formatUsageResetLabel(at(45 * MINUTE), NOW_MS)).toBe("resets in 45m");
  });

  it("never counts down to zero minutes", () => {
    expect(formatUsageResetLabel(at(20_000), NOW_MS)).toBe("resets in 1m");
  });

  it("switches to an absolute time past a day, where a countdown stops helping", () => {
    // Punctuation between the parts is ICU-version dependent, so assert on
    // the parts rather than the exact rendering.
    const label = formatUsageResetLabel(at(30 * HOUR), NOW_MS, "en-US");
    expect(label).toMatch(/^resets \w{3}\b/);
    expect(label).toMatch(/\d{1,2}:\d{2}/);
  });

  it("includes the date once a weekday alone would be ambiguous", () => {
    // A weekly window resetting in 6 days reads identically to one
    // resetting tomorrow if all you print is "Sat".
    const label = formatUsageResetLabel(at(6 * DAY), NOW_MS, "en-US");
    expect(label).toMatch(/Aug/);
    expect(label).toMatch(/\b15\b/);
  });

  it("omits the line rather than guessing when there is no reset time", () => {
    expect(formatUsageResetLabel(null, NOW_MS)).toBeNull();
    expect(formatUsageResetLabel("not-a-date", NOW_MS)).toBeNull();
  });

  it("degrades gracefully once the reset is in the past", () => {
    expect(formatUsageResetLabel(at(-HOUR), NOW_MS)).toBe("resets shortly");
  });
});

describe("formatUsageUpdatedAtLabel", () => {
  const at = (ageMs: number) => isoAt(NOW_MS - ageMs);

  it("stays quiet while the reading is essentially current", () => {
    expect(formatUsageUpdatedAtLabel(at(30_000), NOW_MS)).toBeNull();
  });

  it("reports age at the coarsest useful unit", () => {
    expect(formatUsageUpdatedAtLabel(at(12 * MINUTE), NOW_MS)).toBe("as of 12m ago");
    expect(formatUsageUpdatedAtLabel(at(5 * HOUR), NOW_MS)).toBe("as of 5h ago");
    expect(formatUsageUpdatedAtLabel(at(3 * DAY), NOW_MS)).toBe("as of 3d ago");
  });

  it("says nothing when there is no reading", () => {
    expect(formatUsageUpdatedAtLabel(null, NOW_MS)).toBeNull();
    expect(formatUsageUpdatedAtLabel("not-a-date", NOW_MS)).toBeNull();
  });
});
