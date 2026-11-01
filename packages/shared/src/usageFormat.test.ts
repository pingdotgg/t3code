// @effect-diagnostics globalDate:off -- A fixed instant keeps calendar-window assertions deterministic.
import { describe, expect, it, vi } from "vite-plus/test";
import type { UsageSource } from "@t3tools/contracts";

import {
  formatHourShort,
  formatMalformedUsageWarning,
  makeWindow,
  usageSourceMessagesByProvider,
} from "./usageFormat.ts";

const codexMessages = (sources: readonly UsageSource[]) =>
  usageSourceMessagesByProvider(sources).get("codex") ?? [];

const skipped = (count: number) =>
  count === 1
    ? "1 usage record couldn't be read, so totals may be low."
    : `${count} usage records couldn't be read, so totals may be low.`;

function malformedSource(count: number, overrides: Partial<UsageSource> = {}): UsageSource {
  return {
    fingerprint: {
      hostId: "demo-host",
      provider: "codex",
      resolvedHomePath: "/demo/codex",
      volumeId: "demo-volume",
    },
    status: "partial",
    scannedFiles: 1,
    skippedFiles: 0,
    malformedRecords: count,
    distinctSessions: 1,
    message: formatMalformedUsageWarning(count),
    ...overrides,
  };
}

describe("usage source messages", () => {
  it("keeps each provider's skipped records on that provider", () => {
    const codex = malformedSource(1);
    const claude = malformedSource(11, {
      fingerprint: { ...codex.fingerprint, provider: "claude", resolvedHomePath: "/demo/claude" },
    });

    expect(usageSourceMessagesByProvider([codex, claude])).toEqual(
      new Map([
        ["codex", [skipped(1)]],
        ["claude", [skipped(11)]],
      ]),
    );
  });

  it("combines hosts reporting the same count once per source", () => {
    const source = malformedSource(1);
    const otherHost = malformedSource(1, {
      fingerprint: { ...source.fingerprint, hostId: "other-demo-host" },
    });

    expect(codexMessages([source, source, otherHost, otherHost])).toEqual([skipped(2)]);
  });

  it("keeps different machines with the same hostname and home path distinct", () => {
    const source = malformedSource(1);
    const otherMachine = malformedSource(11, {
      fingerprint: { ...source.fingerprint, volumeId: "other-demo-volume" },
    });

    expect(codexMessages([source, otherMachine])).toEqual([skipped(12)]);
  });

  it("uses the largest count when connected environments report the same source", () => {
    const source = malformedSource(1);

    expect(codexMessages([source, malformedSource(11), source])).toEqual([skipped(11)]);
  });

  it("retains other diagnostics beside the combined warning", () => {
    const source = malformedSource(1);
    const readFailure = "2 transcript path(s) could not be read; usage may be incomplete.";
    const cursor = malformedSource(0, {
      fingerprint: { ...source.fingerprint, provider: "cursor" },
      status: "ok",
      message: "Cursor history is limited to the last 30 days.",
    });

    expect(
      usageSourceMessagesByProvider([
        { ...source, message: `${readFailure} ${source.message}` },
        { ...source, malformedRecords: 0, message: readFailure },
        cursor,
      ]),
    ).toEqual(
      new Map([
        ["codex", [readFailure, skipped(1)]],
        ["cursor", [cursor.message]],
      ]),
    );
  });

  it("includes cached diagnostics when a transcript directory is missing", () => {
    const source = malformedSource(1);
    const missing = malformedSource(2, {
      fingerprint: { ...source.fingerprint, hostId: "other-demo-host" },
      status: "missing",
      scannedFiles: 0,
      skippedFiles: 1,
      distinctSessions: 0,
      message:
        "No transcript directory on this environment. 2 malformed or inconsistent usage record(s) were skipped; usage may be incomplete.",
    });

    expect(codexMessages([source, missing, missing])).toEqual([
      "No transcript directory on this environment.",
      skipped(3),
    ]);
  });

  it("omits empty missing sources, healthy sources, and diagnostics handled by an action", () => {
    expect(
      usageSourceMessagesByProvider([
        malformedSource(0, { status: "missing" }),
        malformedSource(1, { status: "ok" }),
        malformedSource(1, { action: "enableCursorKeychain" }),
      ]),
    ).toEqual(new Map());
  });
});

describe("hourly usage formatting", () => {
  it("keeps requested zones separate when formatting repeated calls", () => {
    const instant = "2026-08-11T12:37:00.000Z";
    for (const zone of ["UTC", "America/New_York", "Asia/Kathmandu", "UTC"]) {
      expect(formatHourShort(instant, zone)).toBe(
        new Intl.DateTimeFormat("en-US", { timeZone: zone, hour: "numeric" }).format(
          new Date(instant),
        ),
      );
    }
    expect(() => formatHourShort(instant, "Etc/Unknown")).toThrow(RangeError);
    expect(formatHourShort("invalid", "UTC")).toBe("invalid");
  });

  it("disambiguates repeated hours during a fall-back transition", () => {
    expect(formatHourShort("2026-11-01T05:37:00.000Z", "America/New_York")).toBe("1 AM EDT");
    expect(formatHourShort("2026-11-01T06:37:00.000Z", "America/New_York")).toBe("1 AM EST");
    expect(formatHourShort("2026-11-01T05:37:00.000Z", "America/New_York", false)).toBe(
      "01:00 EDT",
    );
    expect(formatHourShort("2026-11-01T06:37:00.000Z", "America/New_York", false)).toBe(
      "01:00 EST",
    );
  });

  it("builds an exact minute-aligned 24-hour request", () => {
    const window = makeWindow(1, new Date("2026-08-11T12:37:42.123Z"), "hour");

    expect(window.resolution).toBe("hour");
    expect(window.sinceTime).toBe("2026-08-10T12:37:00.000Z");
    expect(window.untilTime).toBe("2026-08-11T12:37:00.000Z");
  });

  it("degrades an unknown resolved zone to UTC instead of crashing", () => {
    const resolved = new Intl.DateTimeFormat().resolvedOptions();
    const resolvedOptions = vi
      .spyOn(Intl.DateTimeFormat.prototype, "resolvedOptions")
      .mockReturnValue({ ...resolved, timeZone: "Etc/Unknown" });

    try {
      const now = new Date("2026-08-11T12:37:42.123Z");

      expect(makeWindow(1, now, "hour").timeZone).toBe("UTC");
      expect(makeWindow(30, now).timeZone).toBe("UTC");
    } finally {
      resolvedOptions.mockRestore();
    }
  });
});
