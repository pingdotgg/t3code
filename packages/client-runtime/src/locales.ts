export const SYSTEM_LANGUAGE = "system";

// Shown in their own language so a user can find theirs from any UI language.
const NATIVE_LANGUAGE_NAMES: Readonly<Record<string, string>> = {
  en: "English",
  de: "Deutsch",
  es: "Español",
  fr: "Français",
  ja: "日本語",
  ko: "한국어",
  nl: "Nederlands",
  "pt-BR": "Português (Brasil)",
  ru: "Русский",
  sv: "Svenska",
  zh: "中文（简体）",
};

export function nativeLanguageName(locale: string): string {
  return NATIVE_LANGUAGE_NAMES[locale] ?? locale;
}

// Our `zh` is Simplified, so Traditional tags only match an exact locale.
const TRADITIONAL_CHINESE = /^zh[-_](hant|tw|hk|mo)\b/;

function matchSupportedLocale(tag: string, supported: ReadonlyArray<string>): string | undefined {
  const normalized = tag.trim().toLowerCase();
  const language = normalized.split(/[-_]/)[0];
  const exact = supported.find((locale) => locale.toLowerCase() === normalized);
  if (exact || TRADITIONAL_CHINESE.test(normalized)) return exact;
  return supported.find((locale) => locale.toLowerCase() === language);
}

/** Saved setting to active locale; "system" and unknown values follow the host's languages. */
export function resolveLocale(
  language: string,
  systemLocales: ReadonlyArray<string>,
  supported: ReadonlyArray<string>,
  fallback: string,
): string {
  return resolveLocaleSelection(language, systemLocales, supported, fallback).catalogLocale;
}

/** Keep the matching system tag for regional formats while loading a supported catalog. */
export function resolveLocaleSelection(
  language: string,
  systemLocales: ReadonlyArray<string>,
  supported: ReadonlyArray<string>,
  fallback: string,
): { readonly catalogLocale: string; readonly formattingLocale: string } {
  if (supported.includes(language)) return { catalogLocale: language, formattingLocale: language };
  for (const tag of systemLocales) {
    const match = matchSupportedLocale(tag, supported);
    if (match) return { catalogLocale: match, formattingLocale: tag.trim().replaceAll("_", "-") };
  }
  return { catalogLocale: fallback, formattingLocale: fallback };
}
