import { describe, expect, it, vi } from "vite-plus/test";

import { getI18nSnapshot, startI18n, whenLocaleReady } from "./runtime";

const settings = vi.hoisted(() => ({ language: "system" }));
vi.mock("../hooks/useSettings", () => ({
  getClientSettings: () => settings,
  subscribeClientSettings: () => () => {},
  updateClientSettings: vi.fn(),
}));
vi.mock("./initializeI18n", () => ({ initializeI18n: vi.fn() }));
vi.mock("gt-react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("gt-react")>()),
  getTranslationsSnapshot: async (locale: string) => ({ [locale]: { example: "Example" } }),
}));

describe("web language formatting", () => {
  it.each([
    ["system", ["en-GB"], "en", undefined],
    ["system", ["zh-TW", "en-GB"], "en", undefined],
    ["en", ["en-GB"], "en", undefined],
    ["en", ["de-DE"], "en", "en"],
    ["de", ["en-US"], "de", "de"],
  ] as const)(
    "formats %s with browser languages %j",
    async (language, languages, catalog, expected) => {
      settings.language = language;
      vi.stubGlobal("navigator", { languages });
      vi.stubGlobal("document", { documentElement: { lang: "" } });
      try {
        startI18n();
        await whenLocaleReady();
        const { locale, formattingLocale } = getI18nSnapshot();
        expect(locale).toBe(catalog);
        expect(formattingLocale).toBe(expected);
      } finally {
        vi.unstubAllGlobals();
      }
    },
  );
});
