import { resolveLocale, SYSTEM_LANGUAGE } from "@t3tools/client-runtime/locales";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

import { DEFAULT_LOCALE, readDeviceLocales, SUPPORTED_LOCALES } from "../../i18n/locales";
import { createMessageTimeFormatter } from "./messageTimestamp";
import { useMessageTimeFormatter } from "./useMessageTimeFormatter";

const mocks = vi.hoisted(() => ({
  platform: vi.fn<() => "android" | "ios">(),
  nativeLocales: vi.fn<() => string[]>(),
  languagePreference: vi.fn<() => string>(),
  activeLocale: vi.fn<() => string>(),
}));

vi.mock("react-native", () => ({
  Platform: {
    get OS() {
      return mocks.platform();
    },
  },
  TurboModuleRegistry: { get: () => ({ getNativeLocales: mocks.nativeLocales }) },
}));
vi.mock("expo", () => ({ requireNativeModule: () => ({ is24HourFormat: () => true }) }));
vi.mock("gt-react-native", () => ({ useLocale: mocks.activeLocale }));
vi.mock("../../i18n/I18nProvider", () => ({ useLanguagePreference: mocks.languagePreference }));

function mockDeviceLocale(deviceLocale: string) {
  const DateTimeFormat = Intl.DateTimeFormat;
  return vi.spyOn(Intl, "DateTimeFormat").mockImplementation(function (locale, options) {
    return new DateTimeFormat(locale ?? deviceLocale, options);
  });
}

describe("formatMessageTimestamp", () => {
  const formatMessageTimestamp = createMessageTimeFormatter(undefined);
  const now = new Date(2026, 10, 8, 20, 0).getTime();
  const time = (date: Date) =>
    date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });

  it("shows only the time for today, and the day and month for any earlier day", () => {
    const today = new Date(2026, 10, 8, 0, 5);
    const yesterday = new Date(2026, 10, 7, 23, 55);
    const lastYear = new Date(2025, 10, 5, 19, 17);
    expect(formatMessageTimestamp(today.toISOString(), now)).toBe(time(today));
    expect(formatMessageTimestamp(yesterday.toISOString(), now)).toBe(
      `${yesterday.toLocaleDateString(undefined, { month: "numeric", day: "numeric" })} ${time(yesterday)}`,
    );
    expect(formatMessageTimestamp(lastYear.toISOString(), now)).toBe(
      `${lastYear.toLocaleDateString(undefined, { month: "numeric", day: "numeric", year: "numeric" })} ${time(lastYear)}`,
    );
  });

  it("follows a system time zone change", () => {
    const previous = process.env.TZ;
    vi.useFakeTimers({ now: 0 });
    const sameDay = "2026-11-07T04:45:43.877Z";
    const earlierInWeek = "2026-11-04T20:00:00.000Z";
    const nowMs = Date.parse(sameDay);
    const timeIn = (iso: string, timeZone: string) =>
      new Date(iso).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit", timeZone });
    const dayIn = (iso: string, timeZone: string) =>
      new Date(iso).toLocaleDateString(undefined, { month: "numeric", day: "numeric", timeZone });
    try {
      // Node re-resolves the default zone when TZ is assigned, like the OS zone changing.
      process.env.TZ = "America/New_York";
      const format24 = createMessageTimeFormatter(true);
      expect(formatMessageTimestamp(sameDay, nowMs)).toBe(timeIn(sameDay, "America/New_York"));
      expect(format24(sameDay, nowMs)).toBe("23:45");
      process.env.TZ = "Asia/Bangkok";
      vi.setSystemTime(Date.now() + 1_000);
      expect(formatMessageTimestamp(sameDay, nowMs)).toBe(timeIn(sameDay, "Asia/Bangkok"));
      expect(format24(sameDay, nowMs)).toBe("11:45");
      expect(formatMessageTimestamp(earlierInWeek, nowMs)).toBe(
        `${dayIn(earlierInWeek, "Asia/Bangkok")} ${timeIn(earlierInWeek, "Asia/Bangkok")}`,
      );
    } finally {
      vi.useRealTimers();
      if (previous === undefined) delete process.env.TZ;
      else process.env.TZ = previous;
    }
  });
});

describe("createMessageTimeFormatter", () => {
  const now = new Date(2026, 0, 1, 20, 0).getTime();

  it("follows the system clock preference over the locale's hour cycle", () => {
    {
      using _deviceLocale = mockDeviceLocale("en-US");
      const format24 = createMessageTimeFormatter(true);
      expect(format24(new Date(2026, 0, 1, 15, 7).toISOString(), now)).toBe("15:07");
      expect(format24(new Date(2026, 0, 1, 0, 7).toISOString(), now)).toBe("00:07");
    }
    using _deviceLocale = mockDeviceLocale("en-GB");
    const format12 = createMessageTimeFormatter(false);
    expect(format12(new Date(2026, 0, 1, 15, 7).toISOString(), now)).toMatch(/^3:07\spm$/i);
  });

  it("writes earlier days in the given locale's date order", () => {
    const format = createMessageTimeFormatter(true, "de");
    const june = new Date(2026, 5, 1, 20, 0).getTime();
    expect(format(new Date(2026, 2, 5, 15, 7).toISOString(), june)).toBe("5.3. 15:07");
    expect(format(new Date(2025, 2, 5, 15, 7).toISOString(), june)).toBe("5.3.2025 15:07");
  });

  it("formats dates in the UI locale and keeps the device clock when no override is available", () => {
    using _deviceLocale = mockDeviceLocale("en-US");
    const format = createMessageTimeFormatter(undefined, "de");
    const june = new Date(2026, 5, 1, 20, 0).getTime();
    expect(format(new Date(2026, 5, 1, 15, 7).toISOString(), june)).toMatch(/^3:07\sPM$/);
    expect(format(new Date(2026, 2, 5, 15, 7).toISOString(), june)).toMatch(/^5\.3\. 3:07\sPM$/);
  });

  it.each([
    { platform: "ios", nativeLocales: ["en_GB@calendar=gregorian", "en-US"], preference: "en" },
    { platform: "android", nativeLocales: ["nl-NL", "en-US"], preference: SYSTEM_LANGUAGE },
    { platform: "android", nativeLocales: ["nl-NL", "en-US"], preference: "en" },
  ] as const)("keeps the device date order on $platform with $preference language", (testCase) => {
    using _deviceLocale = mockDeviceLocale("en-US");
    mocks.platform.mockReturnValue(testCase.platform);
    mocks.nativeLocales.mockReturnValue([...testCase.nativeLocales]);
    mocks.languagePreference.mockReturnValue(testCase.preference);
    mocks.activeLocale.mockReturnValue(
      resolveLocale(
        testCase.preference,
        readDeviceLocales().preferredLanguages,
        SUPPORTED_LOCALES,
        DEFAULT_LOCALE,
      ),
    );
    function Timestamp() {
      const format = useMessageTimeFormatter();
      const june = new Date(2026, 5, 1, 20, 0).getTime();
      return format(new Date(2026, 2, 5, 15, 7).toISOString(), june);
    }
    expect(renderToStaticMarkup(createElement(Timestamp))).toMatch(/^05\/03 /);
  });
});
