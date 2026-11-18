export const SYSTEM_LANGUAGE = "system";

// Shown in their own language so a user can find theirs from any UI language.
const NATIVE_LANGUAGE_NAMES: Readonly<Record<string, string>> = {
  en: "English",
  de: "Deutsch",
  es: "Español",
  fr: "Français",
  ja: "日本語",
  ko: "한국어",
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
  if (supported.includes(language)) return language;
  for (const tag of systemLocales) {
    const match = matchSupportedLocale(tag, supported);
    if (match) return match;
  }
  return fallback;
}

function parseSystemLocale(tag: string): Intl.Locale | undefined {
  try {
    return new Intl.Locale(tag);
  } catch {
    return undefined;
  }
}

/**
 * Locales for Intl formatters from normalized language tags. Keep an explicit UI region;
 * otherwise prefer a compatible system variant or region, with the UI locale as a fallback
 * since Hermes on Android formats a tag ICU lacks (such as de-US) in the device locale.
 */
export function formattingLocales(
  uiLocale: string,
  systemLocales: ReadonlyArray<string>,
  regionalLocale?: string,
): ReadonlyArray<string> {
  const ui = new Intl.Locale(uiLocale);
  if (ui.region) return [uiLocale];
  const compatible = [uiLocale, ui.language];
  const preferredRegion = regionalLocale ? parseSystemLocale(regionalLocale)?.region : undefined;
  let region: string | undefined;
  let variant: string | undefined;
  for (const tag of systemLocales) {
    const system = parseSystemLocale(tag);
    if (!system) continue;
    region ??= system.region;
    if (matchSupportedLocale(system.baseName, compatible)) {
      variant = system.baseName;
      break;
    }
  }
  const locale = variant ?? uiLocale;
  const formattingRegion = preferredRegion ?? (variant ? undefined : region);
  const regional = formattingRegion
    ? new Intl.Locale(locale, { region: formattingRegion }).baseName
    : locale;
  const preferred = matchSupportedLocale(regional, compatible) ? regional : locale;
  return preferred === uiLocale ? [uiLocale] : [preferred, uiLocale];
}
