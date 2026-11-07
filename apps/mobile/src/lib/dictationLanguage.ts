/** Locales Apple's on-device SpeechTranscriber offers. Unset follows the device language. */
export const DICTATION_LANGUAGES = [
  { locale: "en-US", label: "English (US)" },
  { locale: "en-GB", label: "English (UK)" },
  { locale: "en-AU", label: "English (Australia)" },
  { locale: "en-CA", label: "English (Canada)" },
  { locale: "en-IN", label: "English (India)" },
  { locale: "pt-BR", label: "Português (Brasil)" },
  { locale: "pt-PT", label: "Português (Portugal)" },
  { locale: "es-ES", label: "Español (España)" },
  { locale: "es-MX", label: "Español (México)" },
  { locale: "es-US", label: "Español (EE. UU.)" },
  { locale: "fr-FR", label: "Français (France)" },
  { locale: "fr-CA", label: "Français (Canada)" },
  { locale: "de-DE", label: "Deutsch" },
  { locale: "it-IT", label: "Italiano" },
  { locale: "ja-JP", label: "日本語" },
  { locale: "ko-KR", label: "한국어" },
  { locale: "zh-CN", label: "中文（普通话）" },
  { locale: "zh-TW", label: "中文（台灣）" },
  { locale: "yue-CN", label: "粵語" },
] as const;

export type DictationLocale = (typeof DICTATION_LANGUAGES)[number]["locale"];

const DICTATION_LOCALES: ReadonlySet<string> = new Set(
  DICTATION_LANGUAGES.map((language) => language.locale),
);

export function isDictationLocale(value: unknown): value is DictationLocale {
  return typeof value === "string" && DICTATION_LOCALES.has(value);
}
