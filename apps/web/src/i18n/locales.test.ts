import { getTranslationsSnapshot, initializeGT, msg } from "gt-react";
import { describe, expect, it } from "vite-plus/test";

import { DEFAULT_LOCALE, resolveWebLocaleSelection } from "./locales";
import { m, setActiveLocale } from "./messages";
import enCatalog from "./translations/en.json";
import ruCatalog from "./translations/ru.json";

describe("resolveWebLocaleSelection", () => {
  it.each([
    ["system", ["en-GB"], "en", undefined],
    ["system", ["zh-TW", "en-GB"], "en", undefined],
    ["en", ["en-GB"], "en", undefined],
    ["en", ["de-DE"], "en", "en"],
    ["de", ["en-US"], "de", "de"],
  ] as const)("%s with browser languages %j", (language, browserLocales, catalog, formatting) => {
    expect(resolveWebLocaleSelection(language, browserLocales)).toEqual({
      catalogLocale: catalog,
      formattingLocale: formatting,
    });
  });
});

describe("Russian force-stop shared-process toast", () => {
  it("keeps singular instruction for 1 thread and plural instruction for 21 threads", async () => {
    await initializeGT({
      defaultLocale: DEFAULT_LOCALE,
      locales: [DEFAULT_LOCALE, "ru"],
      loadTranslations: async (locale: string) => (locale === "ru" ? ruCatalog : {}),
      cacheExpiryTime: null,
    });
    await getTranslationsSnapshot("ru");
    setActiveLocale("ru");
    try {
      const format = (others: number) => m(msg(enCatalog["46f927ee332c1065"], { others }));
      expect(format(0)).toBe(
        "Он используется другими работающими тредами. Остановите их, чтобы освободить его.",
      );
      expect(format(1)).toBe(
        "Он используется ещё 1 работающим тредом. Остановите его, чтобы освободить процесс.",
      );
      expect(format(2)).toBe(
        "Он используется ещё 2 работающими тредами. Остановите их, чтобы освободить процесс.",
      );
      expect(format(21)).toBe(
        "Он используется ещё 21 работающим тредом. Остановите их, чтобы освободить процесс.",
      );
    } finally {
      setActiveLocale(DEFAULT_LOCALE);
    }
  });
});
