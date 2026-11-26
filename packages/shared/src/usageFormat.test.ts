// @effect-diagnostics globalDate:off -- A fixed instant keeps calendar-window assertions deterministic.
import { describe, expect, it, vi } from "vite-plus/test";
import type { UsageSource } from "@t3tools/contracts";

import {
  formatDateTimeShort,
  formatHourShort,
  formatTokens,
  makeWindow,
  usageSourceMessages,
} from "./usageFormat.ts";
import { usageSourceMessages as localizedUsageSourceMessages } from "./usageFormatCopy.ts";

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
    message: `${count} malformed or inconsistent usage record(s) were skipped; usage may be incomplete.`,
    ...overrides,
  };
}

describe("usage source messages", () => {
  it("combines different skipped-record counts into one warning", () => {
    const codex = malformedSource(1);
    const claude = malformedSource(11, {
      fingerprint: { ...codex.fingerprint, provider: "claude", resolvedHomePath: "/demo/claude" },
    });

    expect(usageSourceMessages([codex, claude])).toEqual([
      "12 malformed or inconsistent usage record(s) were skipped; usage may be incomplete.",
    ]);
  });

  it.each([
    { first: 1, second: 1, total: 2 },
    { first: 1, second: 11, total: 12 },
  ])(
    "combines hosts reporting $first and $second skipped records once per source",
    ({ first, second, total }) => {
      const source = malformedSource(first);
      const otherHost = malformedSource(second, {
        fingerprint: { ...source.fingerprint, hostId: "other-demo-host" },
      });

      expect(usageSourceMessages([source, source, otherHost, otherHost])).toEqual([
        `${total} malformed or inconsistent usage record(s) were skipped; usage may be incomplete.`,
      ]);
      expect(usageSourceMessages([source, source])).toEqual([
        `${first} malformed or inconsistent usage record(s) were skipped; usage may be incomplete.`,
      ]);
      expect(usageSourceMessages([otherHost, otherHost])).toEqual([
        `${second} malformed or inconsistent usage record(s) were skipped; usage may be incomplete.`,
      ]);
    },
  );

  it("keeps different machines with the same hostname and home path distinct", () => {
    const source = malformedSource(1);
    const otherMachine = malformedSource(11, {
      fingerprint: { ...source.fingerprint, volumeId: "other-demo-volume" },
    });

    expect(usageSourceMessages([source, otherMachine])).toEqual([
      "12 malformed or inconsistent usage record(s) were skipped; usage may be incomplete.",
    ]);
  });

  it("uses the largest count when connected environments report the same source", () => {
    const source = malformedSource(1);

    expect(usageSourceMessages([source, malformedSource(11), source])).toEqual([
      "11 malformed or inconsistent usage record(s) were skipped; usage may be incomplete.",
    ]);
  });

  describe("shared Windows and WSL warning counts", () => {
    const windows = malformedSource(3, {
      fingerprint: {
        hostId: "MainPC",
        provider: "claude",
        resolvedHomePath: "C:\\Users\\user\\.claude\\projects",
        volumeId: "1280555009:3659174697951285",
        physicalSourceId: "physical-claude-projects",
      },
    });
    const wsl = malformedSource(3, {
      fingerprint: {
        ...windows.fingerprint,
        resolvedHomePath: "/mnt/c/Users/user/.claude/projects",
        volumeId: "112:3659174697951287",
      },
    });

    it("counts the same malformed records once across Windows and WSL", () => {
      for (const sources of [
        [windows, wsl],
        [wsl, windows],
      ]) {
        expect(usageSourceMessages(sources)).toEqual([
          "3 malformed or inconsistent usage record(s) were skipped; usage may be incomplete.",
        ]);
      }
    });

    it("keeps sources distinct without a shared alias or with different providers", () => {
      const { physicalSourceId: _omitted, ...legacy } = wsl.fingerprint;
      for (const fingerprint of [
        legacy,
        { ...wsl.fingerprint, physicalSourceId: "other-directory" },
        { ...wsl.fingerprint, provider: "codex" as const },
      ]) {
        expect(usageSourceMessages([windows, { ...wsl, fingerprint }])).toEqual([
          "6 malformed or inconsistent usage record(s) were skipped; usage may be incomplete.",
        ]);
      }
    });
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
      usageSourceMessages([
        { ...source, message: `${readFailure} ${source.message}` },
        { ...source, malformedRecords: 0, message: readFailure },
        cursor,
      ]),
    ).toEqual([
      readFailure,
      cursor.message,
      "1 malformed or inconsistent usage record(s) were skipped; usage may be incomplete.",
    ]);
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

    expect(usageSourceMessages([source, missing, missing])).toEqual([
      "No transcript directory on this environment.",
      "3 malformed or inconsistent usage record(s) were skipped; usage may be incomplete.",
    ]);
  });

  it("omits empty missing sources and healthy sources", () => {
    expect(
      usageSourceMessages([
        malformedSource(0, { status: "missing" }),
        malformedSource(1, { status: "ok" }),
      ]),
    ).toEqual([]);
    expect(usageSourceMessages([])).toEqual([]);
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

  it("uses a 12-hour clock in locales that default to 24-hour", () => {
    const instant = "2026-11-24T18:03:00.000Z";
    for (const locale of ["fr", "de", "es"]) {
      expect(formatHourShort(instant, "UTC", true, locale)).not.toContain("18");
    }
    expect(formatDateTimeShort(instant, "UTC", true, "fr")).not.toContain("18");
    expect(formatHourShort(instant, "UTC", false, "es")).toBe("18:00");
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

describe("token formatting", () => {
  it("moves to the next unit when rounding reaches it", () => {
    expect(formatTokens(999_999)).toBe("1M");
    expect(formatTokens(999_999_999)).toBe("1B");
    expect(formatTokens(-999_999)).toBe("-1M");
  });
});

describe("localized usage source messages", () => {
  it("uses singular and plural copy for skipped malformed records", () => {
    expect(localizedUsageSourceMessages([malformedSource(1)])).toEqual([
      "1 malformed or inconsistent usage record was skipped; usage may be incomplete.",
    ]);
    expect(localizedUsageSourceMessages([malformedSource(2)])).toEqual([
      "2 malformed or inconsistent usage records were skipped; usage may be incomplete.",
    ]);
  });
});
