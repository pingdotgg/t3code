export const LOCALE_STORAGE_KEY = "t3code:locale";

export const APP_LOCALES = ["en", "de", "fr", "es", "zh-CN"] as const;
export type AppLocale = (typeof APP_LOCALES)[number];

export const LOCALE_LABELS: Record<AppLocale, string> = {
  en: "English",
  de: "Deutsch",
  fr: "Français",
  es: "Español",
  "zh-CN": "简体中文",
};

export function isAppLocale(value: unknown): value is AppLocale {
  return value === "en" || value === "de" || value === "fr" || value === "es" || value === "zh-CN";
}

export function currentLocale(): AppLocale {
  const locale = typeof document === "undefined" ? "en" : document.documentElement.lang;
  return isAppLocale(locale) ? locale : "en";
}

export function applyLocale(locale: AppLocale): void {
  window.localStorage.setItem(LOCALE_STORAGE_KEY, locale);
  window.location.reload();
}
