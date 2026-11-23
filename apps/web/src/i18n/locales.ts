import { resolveLocale } from "@t3tools/client-runtime/locales";

import gtConfig from "../../gt.config.json";

export const DEFAULT_LOCALE = gtConfig.defaultLocale;
export const SUPPORTED_LOCALES: ReadonlyArray<string> = [DEFAULT_LOCALE, ...gtConfig.locales];

export function localeDirection(locale: string) {
  return locale === "ar" ? "rtl" : "ltr";
}

export function resolveWebLocaleSelection(language: string, browserLocales: ReadonlyArray<string>) {
  const catalogLocale = resolveLocale(language, browserLocales, SUPPORTED_LOCALES, DEFAULT_LOCALE);
  // Undefined formats with the host locale: "system", and English over a regional English browser.
  const keepEnglishRegion =
    language === DEFAULT_LOCALE && /^en(?:-|$)/i.test(browserLocales[0] ?? "");
  const formattingLocale = language === catalogLocale && !keepEnglishRegion ? language : undefined;
  return { catalogLocale, formattingLocale };
}
