/**
 * Public surface of the shared i18n foundation.
 *
 * Deliberately narrow: clients get one configured instance, language
 * negotiation, and the metadata a language picker needs. Catalogs and the
 * preference validator's internals stay private, so the only supported way to
 * render a message is through the instance.
 */
export {
  LANGUAGE_LABELS,
  SUPPORTED_LANGUAGES,
  isLanguagePreference,
  resolveLanguage,
  type LanguagePreference,
  type SupportedLanguage,
} from "./languages.ts";
export { createI18n } from "./createI18n.ts";
export type { MessageKey } from "./resources.ts";
