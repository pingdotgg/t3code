import { describe, expect, it } from "vite-plus/test";

import { formattingLocales } from "./locales.js";

describe("formattingLocales", () => {
  it.each([
    { uiLocale: "en", systemLocales: ["en-GB"], expected: ["en-GB", "en"] },
    { uiLocale: "de", systemLocales: ["en-US", "de-AT", "de-DE"], expected: ["de-AT", "de"] },
    { uiLocale: "de", systemLocales: ["en-US"], expected: ["de-US", "de"] },
    { uiLocale: "pt-BR", systemLocales: ["en-US"], expected: ["pt-BR"] },
    {
      uiLocale: "pt-BR",
      systemLocales: ["pt-PT"],
      regionalLocale: "pt-PT",
      expected: ["pt-BR"],
    },
    { uiLocale: "zh", systemLocales: ["zh-Hant-HK"], expected: ["zh"] },
    { uiLocale: "zh", systemLocales: ["zh-Hant-HK", "zh-Hans-SG"], expected: ["zh-Hans-SG", "zh"] },
    { uiLocale: "en", systemLocales: ["nl-NL"], expected: ["en-NL", "en"] },
    {
      uiLocale: "en",
      systemLocales: ["nl-NL", "en-US"],
      regionalLocale: "nl-NL",
      expected: ["en-NL", "en"],
    },
    { uiLocale: "en", systemLocales: [], expected: ["en"] },
  ])("formats $uiLocale with system locales $systemLocales as $expected", (testCase) => {
    expect(
      formattingLocales(testCase.uiLocale, testCase.systemLocales, testCase.regionalLocale),
    ).toEqual(testCase.expected);
  });
});
