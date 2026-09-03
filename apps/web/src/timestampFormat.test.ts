import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  formatDayAwareTimestamp,
  formatElapsedDurationLabel,
  formatExpiresInLabel,
  formatRelativeTime,
  formatRelativeTimeLabel,
  formatShortTimestamp,
  getRelativeTimeState,
  getTimestampFormatOptions,
  resolveTimestampLocale,
} from "./timestampFormat";

describe("getTimestampFormatOptions", () => {
  it("omits hour12 when locale formatting is requested", () => {
    expect(getTimestampFormatOptions("locale", true)).toEqual({
      hour: "numeric",
      minute: "2-digit",
      second: "2-digit",
    });
  });

  it("builds a 12-hour formatter with seconds when requested", () => {
    expect(getTimestampFormatOptions("12-hour", true)).toEqual({
      hour: "numeric",
      minute: "2-digit",
      second: "2-digit",
      hour12: true,
    });
  });

  it("builds a 24-hour formatter without seconds when requested", () => {
    expect(getTimestampFormatOptions("24-hour", false)).toEqual({
      hour: "numeric",
      minute: "2-digit",
      hour12: false,
    });
  });
});

describe("resolveTimestampLocale", () => {
  it("defers to the runtime default when the host reports no locale", () => {
    expect(resolveTimestampLocale(null)).toBeUndefined();
    expect(resolveTimestampLocale(undefined)).toBeUndefined();
    expect(resolveTimestampLocale("   ")).toBeUndefined();
  });

  it("uses a BCP-47 tag reported by the host", () => {
    expect(resolveTimestampLocale("en-GB")).toBe("en-GB");
  });

  it("defers to the runtime default rather than throwing on an unusable tag", () => {
    // The desktop bridge normalizes POSIX identifiers before reporting them, so
    // anything Intl still rejects here falls back instead of breaking every
    // timestamp in the UI.
    expect(resolveTimestampLocale("not a locale")).toBeUndefined();
    expect(resolveTimestampLocale("en_GB")).toBeUndefined();
  });

  it("renders the host locale's hour cycle under the locale setting", () => {
    const formatAt1544 = (systemLocale: string | null) =>
      new Intl.DateTimeFormat(resolveTimestampLocale(systemLocale), {
        ...getTimestampFormatOptions("locale", false),
        timeZone: "UTC",
      })
        .format(new Date("2026-04-07T15:44:00.000Z"))
        // ICU separates the day period with a narrow no-break space.
        .replace(/[  ]/g, " ");

    expect(formatAt1544("en-GB")).toBe("15:44");
    expect(formatAt1544("en-US")).toBe("3:44 PM");
  });
});

describe("formatExpiresInLabel", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-07T12:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns Expired when the instant is in the past", () => {
    expect(formatExpiresInLabel("2026-04-07T11:59:00.000Z")).toBe("Expired");
  });

  it("uses sub-minute second count", () => {
    expect(formatExpiresInLabel("2026-04-07T12:00:45.000Z")).toBe("Expires in 45s");
  });

  it("uses minutes and seconds under one hour", () => {
    expect(formatExpiresInLabel("2026-04-07T12:04:12.000Z")).toBe("Expires in 4m 12s");
    expect(formatExpiresInLabel("2026-04-07T12:15:00.000Z")).toBe("Expires in 15m");
  });

  it("uses hours with minute and second remainder", () => {
    expect(formatExpiresInLabel("2026-04-07T14:02:03.000Z")).toBe("Expires in 2h 2m 3s");
    expect(formatExpiresInLabel("2026-04-07T18:00:00.000Z")).toBe("Expires in 6h");
  });
});

describe("formatDayAwareTimestamp", () => {
  // Instants are built with the local-time Date constructor so the
  // calendar-day boundaries hold in any test timezone or locale.
  const iso = (y: number, monthIndex: number, d: number, h: number, mi: number) =>
    new Date(y, monthIndex, d, h, mi).toISOString();
  const now = new Date(2026, 7, 14, 12, 0).getTime();
  const time = (isoDate: string) => formatShortTimestamp(isoDate, "12-hour");

  it("shows time only for today", () => {
    const messageAt = iso(2026, 7, 14, 9, 30);
    expect(formatDayAwareTimestamp(messageAt, "12-hour", now)).toBe(time(messageAt));
  });

  it("labels the previous calendar day as yesterday even when under 24h old", () => {
    const messageAt = iso(2026, 7, 13, 23, 30);
    const justPastMidnight = new Date(2026, 7, 14, 0, 30).getTime();
    expect(formatDayAwareTimestamp(messageAt, "12-hour", justPastMidnight)).toBe(
      `yesterday at ${time(messageAt)}`,
    );
  });

  it("prefixes older same-year messages with the numeric date", () => {
    const messageAt = iso(2026, 7, 12, 12, 34);
    const datePart = new Intl.DateTimeFormat(undefined, {
      month: "numeric",
      day: "numeric",
    }).format(new Date(messageAt));
    expect(formatDayAwareTimestamp(messageAt, "12-hour", now)).toBe(
      `${datePart} ${time(messageAt)}`,
    );
  });

  it("includes the year once the calendar year differs", () => {
    const messageAt = iso(2025, 11, 31, 18, 0);
    const datePart = new Intl.DateTimeFormat(undefined, {
      month: "numeric",
      day: "numeric",
      year: "numeric",
    }).format(new Date(messageAt));
    expect(formatDayAwareTimestamp(messageAt, "12-hour", now)).toBe(
      `${datePart} ${time(messageAt)}`,
    );
  });

  it("uses the host locale for both the numeric date and wall-clock time", async () => {
    vi.stubGlobal("window", {
      desktopBridge: { getSystemLocale: () => "en-GB" },
    });
    vi.resetModules();

    const { formatDayAwareTimestamp: formatWithHostLocale } = await import("./timestampFormat");
    const messageAt = iso(2026, 7, 12, 15, 44);

    expect(formatWithHostLocale(messageAt, "locale", now)).toBe("12/08 15:44");

    vi.unstubAllGlobals();
  });

  it("returns an empty string for invalid input", () => {
    expect(formatDayAwareTimestamp("not-a-date", "12-hour", now)).toBe("");
  });
});

describe("invalid timestamp inputs", () => {
  it("returns an empty short timestamp instead of throwing", () => {
    expect(formatShortTimestamp("not-a-date", "12-hour")).toBe("");
  });

  it("returns an empty relative time label instead of a NaN label", () => {
    expect(formatRelativeTime("not-a-date")).toBeNull();
    expect(formatRelativeTimeLabel("not-a-date")).toBe("");
  });

  it("distinguishes missing and invalid relative time state", () => {
    expect(getRelativeTimeState(null)).toEqual({ status: "missing" });
    expect(getRelativeTimeState("not-a-date")).toEqual({ status: "invalid" });
  });

  it("returns an empty elapsed duration instead of a NaN label", () => {
    expect(formatElapsedDurationLabel("not-a-date")).toBe("");
  });

  it("returns an empty expires-in label instead of a NaN label", () => {
    expect(formatExpiresInLabel("not-a-date")).toBe("");
  });
});

describe("getRelativeTimeState", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-07T12:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns relative parts for valid timestamps", () => {
    expect(getRelativeTimeState("2026-04-07T11:45:00.000Z")).toEqual({
      status: "relative",
      value: "15m",
      suffix: "ago",
    });
  });
});

describe("formatElapsedDurationLabel", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-07T12:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns just now when the instant is current or in the future", () => {
    expect(formatElapsedDurationLabel("2026-04-07T12:00:00.000Z")).toBe("just now");
    expect(formatElapsedDurationLabel("2026-04-07T12:01:00.000Z")).toBe("just now");
  });

  it("formats seconds, minutes, hours, and days", () => {
    expect(formatElapsedDurationLabel("2026-04-07T11:59:45.000Z")).toBe("15s");
    expect(formatElapsedDurationLabel("2026-04-07T11:45:00.000Z")).toBe("15m");
    expect(formatElapsedDurationLabel("2026-04-07T06:00:00.000Z")).toBe("6h");
    expect(formatElapsedDurationLabel("2026-04-03T12:00:00.000Z")).toBe("4d");
  });
});
