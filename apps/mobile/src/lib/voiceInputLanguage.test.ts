import { describe, expect, it } from "vite-plus/test";

import { normalizeLanguages, resolveVoiceInputLanguage } from "./voiceInputLanguage";

describe("normalizeLanguages", () => {
  it("keeps string tags in order without duplicates", () => {
    expect(normalizeLanguages(["de-CH", "en-CH", 4, "", "de-CH"])).toEqual(["de-CH", "en-CH"]);
  });

  it("returns nothing for a missing value", () => {
    expect(normalizeLanguages(undefined)).toEqual([]);
  });
});

describe("resolveVoiceInputLanguage", () => {
  it("follows the device's first language rather than the app locale", () => {
    expect(resolveVoiceInputLanguage(["ko-KR", "en-KR"], "en-KR")).toBe("ko-KR");
  });

  it("falls back to the app locale without a language list", () => {
    expect(resolveVoiceInputLanguage([], "en-US")).toBe("en-US");
  });
});
