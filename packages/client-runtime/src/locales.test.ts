import { describe, expect, it } from "vite-plus/test";

import { formattingLocales } from "./locales.js";

describe("formattingLocales", () => {
  it.each([
    { uiLocale: "en", systemLocales: ["en-GB"], expected: ["en-GB", "en"] },
    { uiLocale: "de", systemLocales: ["en-US", "de-AT", "de-DE"], expected: ["de-AT", "de"] },
    { uiLocale: "de", systemLocales: ["en-US"], expected: ["de-US", "de"] },
    { uiLocale: "pt-BR", systemLocales: ["en-US"], expected: ["pt-BR"] },
    { uiLocale: "zh", systemLocales: ["zh-Hant-HK"], expected: ["zh"] },
    { uiLocale: "zh", systemLocales: ["zh-Hant-HK", "zh-Hans-SG"], expected: ["zh-Hans-SG", "zh"] },
    { uiLocale: "en", systemLocales: ["nl-NL"], expected: ["en-NL", "en"] },
    { uiLocale: "en", systemLocales: ["de-DE"], expected: ["en-DE", "en"] },
    { uiLocale: "en", systemLocales: [], expected: ["en"] },
  ])("formats $uiLocale with system locales $systemLocales as $expected", (testCase) => {
    // The UI locale stays last: Hermes on Android formats a tag ICU lacks (de-US) in the device locale.
    expect(formattingLocales(testCase.uiLocale, testCase.systemLocales)).toEqual(testCase.expected);
  });
});
