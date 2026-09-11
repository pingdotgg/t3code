import { enMessages, type MessageKey } from "./en.ts";
import { zhCNMessages } from "./zh-CN.ts";

export type { MessageKey } from "./en.ts";

export type Locale = "en" | "zh-CN";

export const SUPPORTED_LOCALES: readonly Locale[] = ["en", "zh-CN"] as const;

/** Language shown when no locale is resolved (per project decision). */
export const DEFAULT_LOCALE: Locale = "zh-CN";

type Params = Record<string, string | number>;

type Listener = () => void;

/**
 * Lightweight, zero-dependency, framework-agnostic message catalog usable from
 * web, desktop (which renders web), and mobile. Missing keys fall through the
 * active catalog -> en -> the key itself, so lookups never throw.
 *
 * Conventions (locale files, t() usage, key naming, scope): docs/internals/i18n.md
 */
export class I18n {
  private _locale: Locale;
  private readonly listeners = new Set<Listener>();

  constructor(options: { locale: Locale }) {
    this._locale = options.locale;
  }

  get locale(): Locale {
    return this._locale;
  }

  /** Switch language and notify subscribers (used by React via useI18n). */
  setLocale(locale: Locale): void {
    if (locale === this._locale) return;
    this._locale = locale;
    for (const listener of this.listeners) listener();
  }

  /** Subscribe to future locale changes. Returns an unsubscribe function. */
  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Translate a key. Lookup order: active locale, then English fallback, then
   * the raw key. Supports `{name}` interpolation via params.
   */
  t = (key: MessageKey, params?: Params): string => {
    const active = this._locale === "zh-CN" ? zhCNMessages : {};
    let text = active[key] ?? enMessages[key] ?? key;
    if (params) {
      for (const [name, value] of Object.entries(params)) {
        text = text.split(`{${name}}`).join(String(value));
      }
    }
    return text;
  };
}

/** Default instance at the project default locale (zh-CN). */
export const i18n = new I18n({ locale: DEFAULT_LOCALE });

/** Build a catalog for a specific locale. */
export function createI18n(options: { locale?: Locale } = {}): I18n {
  return new I18n({ locale: options.locale ?? DEFAULT_LOCALE });
}
