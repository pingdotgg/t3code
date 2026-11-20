import { resolveLocaleSelection, SYSTEM_LANGUAGE } from "@t3tools/client-runtime/locales";
import { describe, expect, it } from "vite-plus/test";

import { DEFAULT_LOCALE, SUPPORTED_LOCALES } from "../../i18n/locales";
import {
  applySnoozePickerDate,
  snoozeDateToPickerDate,
  snoozePickerLabels,
} from "./customSnoozeDate";

describe("custom snooze calendar conversion", () => {
  it("passes the local calendar day to Compose without shifting it across time zones", () => {
    const date = new Date(2026, 8, 17, 0, 30);
    expect(snoozeDateToPickerDate(date)).toBe("2026-09-17T00:00:00.000Z");
  });

  it("applies Compose's UTC calendar day while retaining the local time", () => {
    const date = new Date(2026, 8, 16, 23, 45);
    const next = applySnoozePickerDate(date, new Date("2026-09-20T00:00:00Z"));
    expect([
      next.getFullYear(),
      next.getMonth(),
      next.getDate(),
      next.getHours(),
      next.getMinutes(),
    ]).toEqual([2026, 8, 20, 23, 45]);
    expect(date.getDate()).toBe(16);
  });

  it.each([
    { language: SYSTEM_LANGUAGE, catalog: "en", dateLabel: "5 May" },
    { language: "fr", catalog: "fr", dateLabel: "5 mai" },
  ])("labels the picked date and time for the $language preference", (test) => {
    const date = new Date(2027, 4, 5, 14, 30);
    const { catalogLocale, formattingLocale } = resolveLocaleSelection(
      test.language,
      ["it-IT", "en-GB"],
      SUPPORTED_LOCALES,
      DEFAULT_LOCALE,
    );
    expect(catalogLocale).toBe(test.catalog);
    expect(snoozePickerLabels(date, formattingLocale, true)).toEqual({
      date: test.dateLabel,
      time: "14:30",
    });
  });
});
