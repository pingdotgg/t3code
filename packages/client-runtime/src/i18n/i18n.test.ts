import { describe, expect, it } from "vite-plus/test";

import { localeMessages, resolveUiLocale, translateMessage, type MessageKey } from "./i18n.ts";

describe("resolveUiLocale", () => {
  it("maps Chinese host locales to zh-Hans under system", () => {
    expect(resolveUiLocale("system", "zh-CN")).toBe("zh-Hans");
    expect(resolveUiLocale("system", "zh-TW")).toBe("zh-Hans");
    expect(resolveUiLocale("system", "ZH-Hans-CN")).toBe("zh-Hans");
  });

  it("falls back to English for non-Chinese host locales under system", () => {
    expect(resolveUiLocale("system", "en-US")).toBe("en");
    expect(resolveUiLocale("system", "fr")).toBe("en");
    expect(resolveUiLocale("system", "")).toBe("en");
  });

  it("passes an explicit language through regardless of the host locale", () => {
    expect(resolveUiLocale("en", "zh-CN")).toBe("en");
    expect(resolveUiLocale("zh-Hans", "en-US")).toBe("zh-Hans");
  });
});

describe("translateMessage", () => {
  it("uses the locale catalog and falls back to English for missing keys", () => {
    const key: MessageKey = "settings.interface.chatWidth.wide";
    expect(translateMessage("en", key)).toBe(localeMessages.en[key]);
    expect(translateMessage("zh-Hans", key)).toBe(localeMessages["zh-Hans"][key]);

    const original = localeMessages["zh-Hans"][key];
    delete localeMessages["zh-Hans"][key];
    expect(translateMessage("zh-Hans", key)).toBe(localeMessages.en[key]);
    if (original === undefined) {
      delete localeMessages["zh-Hans"][key];
    } else {
      localeMessages["zh-Hans"][key] = original;
    }
  });

  it("interpolates named params and leaves unknown placeholders intact", () => {
    const key: MessageKey = "settings.interface.language.system";
    const original = localeMessages["zh-Hans"][key];
    localeMessages["zh-Hans"][key] = "跟随系统 ({browser})";
    try {
      expect(translateMessage("zh-Hans", key, { browser: "Chrome" })).toBe("跟随系统 (Chrome)");
      expect(translateMessage("zh-Hans", key, { other: "x" })).toBe("跟随系统 ({browser})");
    } finally {
      if (original === undefined) {
        delete localeMessages["zh-Hans"][key];
      } else {
        localeMessages["zh-Hans"][key] = original;
      }
    }
  });

  it("keeps every zh-Hans key present in the English catalog", () => {
    const missing = Object.keys(localeMessages.en).filter(
      (key) => !(key in localeMessages["zh-Hans"]),
    );
    expect(missing).toEqual([]);
  });
});
