export {
  DEFAULT_LOCALE,
  LOCALE_STORAGE_KEY,
  parseLocale,
  readLocalePreference,
  syncDocumentLocale,
  writeLocalePreference,
  type Locale,
} from "./locale";
export {
  createTranslator,
  translate,
  type MessageKey,
  type Translate,
  type TranslateValues,
} from "./messages";
export { I18nProvider, I18nText, useI18n, type I18nValue } from "./I18nProvider";
export { localizedConnectionStatusText } from "./connection";
export { localizedSourceControlDiscoveryText } from "./sourceControl";
