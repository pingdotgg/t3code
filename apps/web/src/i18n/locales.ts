import gtConfig from "../../gt.config.json";

export const SYSTEM_LANGUAGE = "system";
export const DEFAULT_LOCALE = gtConfig.defaultLocale;
export const SUPPORTED_LOCALES: ReadonlyArray<string> = [DEFAULT_LOCALE, ...gtConfig.locales];

// Shown in their own language so a user can find theirs from any UI language.
const NATIVE_LANGUAGE_NAMES: Readonly<Record<string, string>> = {
  en: "English",
  es: "Español",
  zh: "中文（简体）",
};

export function nativeLanguageName(locale: string): string {
  return NATIVE_LANGUAGE_NAMES[locale] ?? locale;
}

// Our `zh` is Simplified, so Traditional tags only match an exact locale.
const TRADITIONAL_CHINESE = /^zh[-_](hant|tw|hk|mo)\b/;

function matchSupportedLocale(tag: string): string | undefined {
  const normalized = tag.trim().toLowerCase();
  const language = normalized.split(/[-_]/)[0];
  const exact = SUPPORTED_LOCALES.find((locale) => locale.toLowerCase() === normalized);
  if (exact || TRADITIONAL_CHINESE.test(normalized)) return exact;
  return SUPPORTED_LOCALES.find((locale) => locale.toLowerCase() === language);
}

/** Saved setting to active locale; "system" and unknown values follow the host's languages. */
export function resolveLocale(language: string, systemLocales: ReadonlyArray<string>): string {
  if (SUPPORTED_LOCALES.includes(language)) return language;
  for (const tag of systemLocales) {
    const match = matchSupportedLocale(tag);
    if (match) return match;
  }
  return DEFAULT_LOCALE;
}

let desktopSystemLocale: string | null | undefined;

export function readSystemLocales(): ReadonlyArray<string> {
  // The desktop bridge call is a synchronous IPC round trip, so read it once.
  if (desktopSystemLocale === undefined) {
    desktopSystemLocale = window.desktopBridge?.getSystemLocale() ?? null;
  }
  return [...(desktopSystemLocale ? [desktopSystemLocale] : []), ...navigator.languages];
}
