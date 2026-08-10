import { en, type TranslationKey } from "./locales/en.ts";
import { zhCN } from "./locales/zh-CN.ts";

export type SupportedLocale = "en" | "zh-CN";
export type TranslationParams = Readonly<Record<string, string | number>>;

export const I18N_LOCALE_STORAGE_KEY = "t3.locale";

export function normalizeLocale(locale: string | null | undefined): SupportedLocale {
  const normalized = locale?.trim().toLowerCase().replaceAll("_", "-");
  return normalized === "zh" || normalized?.startsWith("zh-") ? "zh-CN" : "en";
}

export function resolveSystemLocale(): SupportedLocale {
  try {
    return normalizeLocale(Intl.DateTimeFormat().resolvedOptions().locale);
  } catch {
    return "en";
  }
}

export function translate(
  locale: SupportedLocale,
  key: TranslationKey,
  params: TranslationParams = {},
): string {
  const template = (locale === "zh-CN" ? zhCN[key] : undefined) ?? en[key];
  return template.replace(/\{([^{}]+)\}/g, (placeholder, name: string) =>
    Object.hasOwn(params, name) ? String(params[name]) : placeholder,
  );
}

export const createTranslator =
  (locale: SupportedLocale) =>
  (key: TranslationKey, params?: TranslationParams): string =>
    translate(locale, key, params);

export interface LocaleStorage {
  readonly getItem: (key: string) => string | null | Promise<string | null>;
  readonly setItem: (key: string, value: string) => void | Promise<void>;
}

export async function loadLocale(storage: LocaleStorage): Promise<SupportedLocale> {
  return normalizeLocale(await storage.getItem(I18N_LOCALE_STORAGE_KEY));
}

export async function persistLocale(
  storage: LocaleStorage,
  locale: SupportedLocale,
): Promise<void> {
  await storage.setItem(I18N_LOCALE_STORAGE_KEY, locale);
}

export type { TranslationKey };
