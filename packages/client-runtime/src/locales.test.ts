import { describe, expect, it } from "vite-plus/test";

import { resolveLocale, SYSTEM_LANGUAGE } from "./locales.ts";

const SUPPORTED = ["en", "ja", "zh", "zh-TW"];

describe("resolveLocale", () => {
  it.each([
    [["zh-TW"], "zh-TW"],
    [["zh-Hant-TW"], "zh-TW"],
    [["zh-Hant"], "zh-TW"],
    [["zh-HK"], "zh-TW"],
    [["zh_TW"], "zh-TW"],
    [["zh-CN"], "zh"],
    [["zh-Hans-CN"], "zh"],
    [["zh"], "zh"],
    [["ja-JP"], "ja"],
    [["fr-FR", "zh-Hant-TW"], "zh-TW"],
    [["fr-FR"], "en"],
  ])("follows system languages %j to %s", (systemLocales, expected) => {
    expect(resolveLocale(SYSTEM_LANGUAGE, systemLocales, SUPPORTED, "en")).toBe(expected);
  });

  it("keeps Traditional tags out of Simplified when there is no Traditional locale", () => {
    expect(resolveLocale(SYSTEM_LANGUAGE, ["zh-Hant-TW"], ["en", "zh"], "en")).toBe("en");
  });

  it("uses a saved supported language over the system languages", () => {
    expect(resolveLocale("zh-TW", ["en-US"], SUPPORTED, "en")).toBe("zh-TW");
  });
});
