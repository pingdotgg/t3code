import { initializeGTSPA } from "gt-react";

import { DEFAULT_LOCALE, SUPPORTED_LOCALES } from "./locales";

// English is the only language and the source text, so there are no catalogs to load.
async function loadTranslations(): Promise<unknown> {
  return {};
}

/** Sets up GT's singletons. `onLocaleRequest` receives GT's own locale changes. */
export function initializeI18n(onLocaleRequest: (locale: string) => void): void {
  void initializeGTSPA({
    defaultLocale: DEFAULT_LOCALE,
    locales: [...SUPPORTED_LOCALES],
    locale: DEFAULT_LOCALE,
    loadTranslations,
    // GT's default drops a catalog from its cache after 60 s; call-time `m()` reads that cache.
    cacheExpiryTime: null,
    _reload: (state) => onLocaleRequest(state.locale),
  });
}
