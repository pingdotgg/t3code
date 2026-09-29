import { describe, expect, it } from "vite-plus/test";
import { resolveSupportedLocale } from "./index.ts";

describe("resolveSupportedLocale", () => {
  it("honors an explicit supported preference", () => {
    expect(resolveSupportedLocale("zh-CN", ["en-US"])).toBe("zh-CN");
    expect(resolveSupportedLocale("en", ["zh-CN"])).toBe("en");
  });

  it("uses the first supported system language", () => {
    expect(resolveSupportedLocale("system", ["fr-FR", "zh-Hans-CN", "en-US"])).toBe("zh-CN");
    expect(resolveSupportedLocale(undefined, ["en-GB", "zh-CN"])).toBe("en");
  });

  it("falls back to English for traditional Chinese and unsupported locales", () => {
    expect(resolveSupportedLocale("system", ["zh-Hant-TW"])).toBe("en");
    expect(resolveSupportedLocale(null, ["fr-FR", "ja-JP"])).toBe("en");
    expect(resolveSupportedLocale("system", ["not a locale"])).toBe("en");
  });
});
