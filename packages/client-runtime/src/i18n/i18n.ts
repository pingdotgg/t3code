import type { UiLanguage } from "@t3tools/contracts";

import { enMessages as interfaceEn, zhHansMessages as interfaceZh } from "./messages.ts";
import { enMessages as navEn, zhHansMessages as navZh } from "./messagesSettingsNav.ts";
import {
  enMessages as typographyEn,
  zhHansMessages as typographyZh,
} from "./messagesTypography.ts";

/** Locales with shipped translations. English is the fallback for missing keys. */
export type UiLocale = Exclude<UiLanguage, "system">;

// Message catalogs are grouped by domain file, one per owning feature, so
// extraction work on separate panels never edits the same dictionary.
const enCatalog = {
  ...interfaceEn,
  ...navEn,
  ...typographyEn,
};

export type MessageKey = keyof typeof enCatalog;

const zhCatalog: Partial<Record<MessageKey, string>> = {
  ...interfaceZh,
  ...navZh,
  ...typographyZh,
};

export const localeMessages: Record<UiLocale, Partial<Record<MessageKey, string>>> = {
  en: enCatalog,
  "zh-Hans": zhCatalog,
};

export type TranslateParams = Record<string, string | number>;

export type TranslateFn = (key: MessageKey, params?: TranslateParams) => string;

/**
 * Resolves the "system" setting against the host locale. Any non-Chinese host
 * locale falls back to English; Chinese variants (zh-CN, zh-TW, ...) all map to
 * the single zh-Hans catalog.
 */
export function resolveUiLocale(language: UiLanguage, systemLocale: string): UiLocale {
  if (language !== "system") {
    return language;
  }
  return systemLocale.toLowerCase().split("-")[0] === "zh" ? "zh-Hans" : "en";
}

export function translateMessage(
  locale: UiLocale,
  key: MessageKey,
  params?: TranslateParams,
): string {
  const template = localeMessages[locale][key] ?? enCatalog[key];
  if (params === undefined) {
    return template;
  }
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    Object.hasOwn(params, name) ? String(params[name]) : match,
  );
}

export function createTranslator(locale: UiLocale): TranslateFn {
  return (key, params) => translateMessage(locale, key, params);
}
