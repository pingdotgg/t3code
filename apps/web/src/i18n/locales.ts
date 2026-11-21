import gtConfig from "../../gt.config.json";

export const DEFAULT_LOCALE = gtConfig.defaultLocale;
export const SUPPORTED_LOCALES: ReadonlyArray<string> = [DEFAULT_LOCALE, ...gtConfig.locales];

export function localeDirection(locale: string) {
  return locale === "ar" ? "rtl" : "ltr";
}
