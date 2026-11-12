import { initializeGTSPA } from "gt-react";

import { DEFAULT_LOCALE, SUPPORTED_LOCALES } from "./locales";

// English is the source text, so it never loads a chunk.
async function loadTranslations(locale: string): Promise<unknown> {
  if (locale === DEFAULT_LOCALE) return {};
  const module: { default: unknown } = await import(`./translations/${locale}.json`);
  return module.default;
}

/** Sets up GT's singletons. `onLocaleRequest` receives GT's own locale changes. */
export function initializeI18n(onLocaleRequest: (locale: string) => void): void {
  void initializeGTSPA({
    defaultLocale: DEFAULT_LOCALE,
    locales: [...SUPPORTED_LOCALES],
    locale: DEFAULT_LOCALE,
    loadTranslations,
    _reload: (state) => onLocaleRequest(state.locale),
  });
}
