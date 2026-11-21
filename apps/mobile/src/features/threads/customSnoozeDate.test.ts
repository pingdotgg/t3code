import { resolveLocaleSelection, SYSTEM_LANGUAGE } from "@lathe/client-runtime/locales";
import { localSnoozeDate, localSnoozeTime } from "@lathe/client-runtime/state/thread-settled";
import { describe, expect, it } from "vite-plus/test";

import { DEFAULT_LOCALE, SUPPORTED_LOCALES } from "../../i18n/locales";
import {
  applySnoozePickerDate,
  initialCustomSnoozeDate,
  resolveSheetSnoozedUntil,
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

describe("initial custom snooze date", () => {
  const now = new Date("2026-09-30T12:00:00.000Z");

  it("starts an hour out when the thread is not snoozed", () => {
    expect(initialCustomSnoozeDate(null, now).toISOString()).toBe("2026-09-30T13:00:00.000Z");
    expect(initialCustomSnoozeDate(undefined, now).toISOString()).toBe("2026-09-30T13:00:00.000Z");
  });

  it("starts at the current wake time when re-snoozing, so only the note has to change", () => {
    expect(initialCustomSnoozeDate("2026-10-02T09:00:00.000Z", now).toISOString()).toBe(
      "2026-10-02T09:00:00.000Z",
    );
  });

  it("ignores a wake time that has passed or does not parse", () => {
    expect(initialCustomSnoozeDate("2026-09-30T11:00:00.000Z", now).toISOString()).toBe(
      "2026-09-30T13:00:00.000Z",
    );
    expect(initialCustomSnoozeDate("not a date", now).toISOString()).toBe(
      "2026-09-30T13:00:00.000Z",
    );
  });
});

describe("sheet snooze wake time", () => {
  const now = new Date("2026-09-30T12:00:00.000Z");
  const wake = "2026-09-30T15:00:30.000Z";
  const pickerAt = (date: Date) =>
    ({ mode: "date", date: localSnoozeDate(date), time: localSnoozeTime(date) }) as const;

  it("keeps the exact wake time when only the note changed", () => {
    expect(resolveSheetSnoozedUntil(pickerAt(new Date(wake)), wake, now)).toBe(wake);
  });

  it("keeps the wake time even when its picker minute has already started", () => {
    const lateInMinute = new Date("2026-09-30T15:00:10.000Z");
    expect(resolveSheetSnoozedUntil(pickerAt(new Date(wake)), wake, lateInMinute)).toBe(wake);
  });

  it("uses the picked time once the schedule differs from the current wake", () => {
    const picked = new Date("2026-09-30T16:00:00.000Z");
    expect(resolveSheetSnoozedUntil(pickerAt(picked), wake, now)).toBe(picked.toISOString());
  });

  it("resolves normally for a thread that is not snoozed or whose wake has passed", () => {
    const picked = new Date("2026-09-30T16:00:00.000Z");
    expect(resolveSheetSnoozedUntil(pickerAt(picked), null, now)).toBe(picked.toISOString());
    const after = new Date("2026-09-30T15:01:00.000Z");
    expect(resolveSheetSnoozedUntil(pickerAt(new Date(wake)), wake, after)).toBeNull();
  });

  it("treats a duration as a new schedule", () => {
    expect(
      resolveSheetSnoozedUntil({ mode: "duration", amount: "2", unit: "hours" }, wake, now),
    ).toBe("2026-09-30T14:00:00.000Z");
  });
});
