/**
 * Language catalogs, statically bundled.
 *
 * `en` is the source of truth; `zh` may be partial, because i18next falls back
 * to `en` per key. Both are imported eagerly: they are a few kilobytes, and an
 * async catalog would show raw keys on the first frame of an untranslated
 * install — exactly the case a fresh client hits first.
 *
 * Chinese has a single plural form, so a `_other` string serves every count;
 * i18next falls back to it when no `_one` form exists.
 */
import { en, type MessageKey } from "./messages.en.ts";
import { zh } from "./messages.zh.ts";

/** Key type only: the catalogs themselves stay private to this module. */
export type { MessageKey };
export type Messages = Record<MessageKey, string>;

/** Every shipped catalog, keyed by the language tag clients select. */
export const resources = {
  en: { translation: en },
  zh: { translation: zh },
} as const;
