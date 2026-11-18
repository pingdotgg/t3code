import { describe, expect, it } from "vite-plus/test";

import { formattingLocale } from "./locales.js";

describe("formattingLocale", () => {
  it.each([
    ["en", "en-GB", "en-GB"],
    ["de", "de-AT", "de-AT"],
    ["de", "en-US", "de"],
    ["pt-BR", "en-US", "pt-BR"],
  ])("formats %s with system locale %s as %s", (uiLocale, systemLocale, expected) => {
    expect(formattingLocale(uiLocale, systemLocale)).toBe(expected);
  });
});
