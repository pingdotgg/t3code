import { describe, expect, it } from "vite-plus/test";

import { usageAxisDayLabel, usageAxisHourLabel } from "./usageAxisLabels.ts";
import { DEFAULT_LOCALE } from "../../i18n/locales";

describe("usageAxisDayLabel", () => {
  it("uses the shared short-day format for the default locale", () => {
    expect(usageAxisDayLabel("2026-01-15", DEFAULT_LOCALE)).toMatch(/Jan/);
  });

  it("localizes the month for a non-default locale", () => {
    expect(usageAxisDayLabel("2026-01-15", "fr")).toContain("15");
  });

  it("returns malformed days unchanged", () => {
    expect(usageAxisDayLabel("not-a-day", "fr")).toBe("not-a-day");
  });
});

describe("usageAxisHourLabel", () => {
  it("returns malformed hours unchanged", () => {
    expect(usageAxisHourLabel("not-an-hour", DEFAULT_LOCALE)).toBe("not-an-hour");
    expect(usageAxisHourLabel("not-an-hour", "fr")).toBe("not-an-hour");
  });

  it("formats a valid hour in the UI language", () => {
    expect(usageAxisHourLabel("2026-01-15T13:00:00Z", DEFAULT_LOCALE, "UTC")).toMatch(/1/);
    expect(usageAxisHourLabel("2026-01-15T13:00:00Z", "fr", "UTC")).toContain("13");
  });
});
