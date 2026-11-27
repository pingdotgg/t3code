import { gtFallback } from "gt-react";
import { describe, expect, it } from "vite-plus/test";

import { resolveWebLocaleSelection } from "./locales";
import ja from "./translations/ja.json";
import ko from "./translations/ko.json";
import ru from "./translations/ru.json";
import zh from "./translations/zh.json";

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

it("held sends announce the pending image count except for exactly one image", () => {
  for (const [locale, catalog] of Object.entries({ ru, ja, ko, zh })) {
    const status = (count: number) =>
      gtFallback(catalog["1a1f128d70c62304"], { count, $locale: locale });
    expect(status(1), locale).not.toMatch(/\d/);
    for (const count of [2, 5, 21, 22, 25, 100]) {
      expect(status(count), `${locale}: ${count} pending images`).toContain(String(count));
    }
  }
});
