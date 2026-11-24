import gtConfig from "../../gt.config.json";

export const DEFAULT_LOCALE = gtConfig.defaultLocale;
// Keep the Russian catalog frozen. GT falls back to English for missing entries.
export const SUPPORTED_LOCALES: ReadonlyArray<string> = [DEFAULT_LOCALE, ...gtConfig.locales, "ru"];
