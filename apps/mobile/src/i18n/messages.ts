import { decodeOptions, getReactI18nCache, gtFallback, type useMessages } from "gt-react-native";

import { DEFAULT_LOCALE } from "./locales";

export type MessageResolver = ReturnType<typeof useMessages>;

let activeLocale = DEFAULT_LOCALE;
const activeLocaleListeners = new Set<() => void>();

/** I18nProvider calls this once the locale's catalog is in GT's cache. */
export function setActiveLocale(locale: string): void {
  if (locale === activeLocale) return;
  activeLocale = locale;
  for (const listener of activeLocaleListeners) listener();
}

/** The language `m()` resolves in, for text written outside the app such as relay pushes. */
export function getActiveLocale(): string {
  return activeLocale;
}

export function subscribeActiveLocale(listener: () => void): () => void {
  activeLocaleListeners.add(listener);
  return () => activeLocaleListeners.delete(listener);
}

function resolve(message: string, variables: Parameters<MessageResolver>[1] = {}): string {
  const decoded = decodeOptions(message);
  const options = typeof decoded?.$_source === "string" ? decoded : variables;
  const source = typeof decoded?.$_source === "string" ? decoded.$_source : message;
  const target =
    activeLocale === DEFAULT_LOCALE
      ? undefined
      : getReactI18nCache().lookupTranslation(activeLocale, source, { ...options, $format: "ICU" });
  // Untranslated text is English, so it takes English plural rules.
  return typeof target === "string"
    ? gtFallback(target, { ...options, $locale: activeLocale, $_fallback: source })
    : gtFallback(source, { ...options, $locale: DEFAULT_LOCALE });
}

/**
 * Resolves a `msg()` string in the current UI language, at call time. For code outside React
 * (alerts, stores, notifications). Components use `useMessages()` so they re-render on a switch.
 */
export const m = ((message, variables) =>
  typeof message === "string" ? resolve(message, variables) : message) as MessageResolver;

/**
 * Keeps `msg()` text unresolved, for helpers whose result is cached past a language switch.
 * Only for helpers that pass a whole `msg()` string; display sites resolve the result.
 */
export const keepMarked = ((message: string) => message) as MessageResolver;
