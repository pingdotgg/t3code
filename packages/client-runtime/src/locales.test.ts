import { describe, expect, it } from "vite-plus/test";

import { formattingLocale } from "./locales.js";

describe("formattingLocale", () => {
  it.each([
    { uiLocale: "en", systemLocales: ["en-GB"], expected: "en-GB" },
    { uiLocale: "de", systemLocales: ["en-US", "de-AT", "de-DE"], expected: "de-AT" },
    { uiLocale: "de", systemLocales: ["en-US"], expected: "de-US" },
    { uiLocale: "pt-BR", systemLocales: ["en-US"], expected: "pt-BR" },
    { uiLocale: "zh", systemLocales: ["zh-Hant-HK"], expected: "zh" },
    { uiLocale: "zh", systemLocales: ["zh-Hant-HK", "zh-Hans-SG"], expected: "zh-Hans-SG" },
    { uiLocale: "en", systemLocales: ["nl-NL"], expected: "en-NL" },
    { uiLocale: "en", systemLocales: ["de-DE"], expected: "en-DE" },
    { uiLocale: "en", systemLocales: [], expected: "en" },
  ])("formats $uiLocale with system locales $systemLocales as $expected", (testCase) => {
    expect(formattingLocale(testCase.uiLocale, testCase.systemLocales)).toBe(testCase.expected);
  });
});
