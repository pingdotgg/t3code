/**
 * Languages a client can display.
 *
 * `en` is the source language: every message is written there first, and other
 * catalogs fall back to it. Adding a language means adding it here, adding the
 * matching value to `LanguagePreference` in `@t3tools/contracts`, and adding a
 * catalog to `resources.ts`.
 */
export const SUPPORTED_LANGUAGES = ["en", "zh"] as const;
export type SupportedLanguage = (typeof SUPPORTED_LANGUAGES)[number];

/** The source language, and what anything unrecognised resolves to. */
export const DEFAULT_LANGUAGE: SupportedLanguage = "en";

/** Native names, so the picker is readable before the app is translated. */
export const LANGUAGE_LABELS: Record<SupportedLanguage, string> = {
  en: "English",
  zh: "中文",
};

/**
 * What the user chose. `system` follows the host, which is what a first-run
 * client wants: an untranslated locale still resolves through
 * {@link resolveLanguage} rather than showing a picker nobody asked for.
 */
export type LanguagePreference = "system" | SupportedLanguage;

/** Internal: raw values narrow through {@link isLanguagePreference}. */
function isSupportedLanguage(value: string): value is SupportedLanguage {
  return (SUPPORTED_LANGUAGES as readonly string[]).includes(value);
}

/** Narrows a raw select value to something the preference field accepts. */
export function isLanguagePreference(
  value: string | null | undefined,
): value is LanguagePreference {
  return (
    value === "system" || (value !== null && value !== undefined && isSupportedLanguage(value))
  );
}

/** The primary subtag of a BCP-47 tag, lowercased: `zh-Hans-CN` -> `zh`. */
function primarySubtag(locale: string): string {
  return locale.trim().toLowerCase().split(/[-_]/)[0] ?? "";
}

/**
 * Pick the language to display from the stored preference and the host's
 * locales, most preferred first.
 *
 * Only the primary subtag is matched, so `zh-Hans-CN` and `zh-TW` both resolve
 * to `zh`. A host list with nothing we ship — Japanese, say — falls back to
 * English rather than showing untranslated keys.
 */
export function resolveLanguage(
  preference: LanguagePreference,
  systemLocales: readonly string[] = [],
): SupportedLanguage {
  if (preference !== "system") return preference;

  for (const locale of systemLocales) {
    const primary = primarySubtag(locale);
    if (isSupportedLanguage(primary)) return primary;
  }

  return DEFAULT_LANGUAGE;
}
