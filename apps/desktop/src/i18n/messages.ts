import { resolveLocale } from "@t3tools/client-runtime/locales";
import * as Effect from "effect/Effect";
import { decodeOptions, gtFallback } from "gt-i18n";
import { hashMessage } from "gt-i18n/internal";

import * as ElectronApp from "../electron/ElectronApp.ts";

type Catalog = Readonly<Record<string, string>>;

const DEFAULT_LOCALE = "en";

// English is the source text and loads nothing. Keep the keys in step with gt.config.json.
const CATALOGS: Readonly<Record<string, () => Promise<{ readonly default: Catalog }>>> = {
  de: () => import("./translations/de.json", { with: { type: "json" } }),
  es: () => import("./translations/es.json", { with: { type: "json" } }),
  fr: () => import("./translations/fr.json", { with: { type: "json" } }),
  he: () => import("./translations/he.json", { with: { type: "json" } }),
  ja: () => import("./translations/ja.json", { with: { type: "json" } }),
  ko: () => import("./translations/ko.json", { with: { type: "json" } }),
  pl: () => import("./translations/pl.json", { with: { type: "json" } }),
  "pt-BR": () => import("./translations/pt-BR.json", { with: { type: "json" } }),
  ru: () => import("./translations/ru.json", { with: { type: "json" } }),
  sv: () => import("./translations/sv.json", { with: { type: "json" } }),
  zh: () => import("./translations/zh.json", { with: { type: "json" } }),
};
const SUPPORTED_LOCALES = [DEFAULT_LOCALE, ...Object.keys(CATALOGS)];

const loadedCatalogs = new Map<string, Catalog>([[DEFAULT_LOCALE, {}]]);
const listeners = new Set<() => void>();
let activeLocale = DEFAULT_LOCALE;
let activeCatalog: Catalog = {};
let requestedLocale = DEFAULT_LOCALE;

/**
 * Resolves a `msg()` string in the active UI language at call time. Variables are strings so
 * ICU never reformats a number (a PID of 12345 would print "12,345").
 */
export function m(message: string, variables: Readonly<Record<string, string>> = {}): string {
  const decoded = decodeOptions(message);
  const source = typeof decoded?.$_source === "string" ? decoded.$_source : message;
  const options = typeof decoded?.$_source === "string" ? decoded : variables;
  const target =
    activeLocale === DEFAULT_LOCALE
      ? undefined
      : activeCatalog[hashMessage(source, { ...options, $format: "ICU" })];
  // Untranslated text is English, so it takes English plural rules.
  return target === undefined
    ? gtFallback(source, { ...options, $locale: DEFAULT_LOCALE })
    : gtFallback(target, { ...options, $locale: activeLocale, $_fallback: source });
}

/** Runs `listener` after each switch to a different UI language. */
export function onLocaleChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

const loadCatalog = async (locale: string): Promise<Catalog> => {
  const loaded = loadedCatalogs.get(locale);
  if (loaded) return loaded;
  const catalog = (await CATALOGS[locale]!()).default;
  loadedCatalogs.set(locale, catalog);
  return catalog;
};

/** Activates the saved `language` client setting; "system" follows the OS language order. */
export const applyLanguage = Effect.fn("desktop.i18n.applyLanguage")(function* (language: string) {
  const electronApp = yield* ElectronApp.ElectronApp;
  const locale = resolveLocale(
    language,
    yield* electronApp.preferredSystemLanguages,
    SUPPORTED_LOCALES,
    DEFAULT_LOCALE,
  );
  requestedLocale = locale;
  if (locale === activeLocale) return;
  const catalog = yield* Effect.promise(() => loadCatalog(locale));
  // A later call may have asked for another language while this catalog loaded.
  if (requestedLocale !== locale) return;
  activeLocale = locale;
  activeCatalog = catalog;
  for (const listener of listeners) listener();
});
