import enChat from "../locales/en/chat.json";
import enPalette from "../locales/en/palette.json";
import enSettings from "../locales/en/settings.json";
import zhHansChat from "../locales/zh-Hans/chat.json";
import zhHansPalette from "../locales/zh-Hans/palette.json";
import zhHansSettings from "../locales/zh-Hans/settings.json";
import { type UiLocale } from "@t3tools/contracts/settings";
import i18next from "i18next";
import { initReactI18next } from "react-i18next";

import { subscribeActiveUiLocale } from "./hooks/useUiLocale";

const UI_LANGUAGES = ["en", "zh-Hans"] as const;
type UiLanguage = (typeof UI_LANGUAGES)[number];

declare module "i18next" {
  interface CustomTypeOptions {
    defaultNS: "settings";
    resources: {
      settings: typeof enSettings;
      palette: typeof enPalette;
      chat: typeof enChat;
    };
  }
}

export const i18n = i18next.createInstance();

/** Translates a key that is computed at runtime and lives outside the typed key union. */
export function translateDynamic(key: string, options?: Record<string, unknown>): string {
  return options === undefined
    ? (i18n.t(key as never) as string)
    : (i18n.t(key as never, { ...options }) as string);
}

// Init runs at import so `useTranslation` works wherever the module is reached
// from, including tests that render components directly.
if (!i18n.isInitialized) {
  void i18n.use(initReactI18next).init({
    lng: "en",
    fallbackLng: "en",
    defaultNS: "settings",
    ns: ["settings", "palette", "chat"],
    resources: {
      en: { settings: enSettings, palette: enPalette, chat: enChat },
      "zh-Hans": { settings: zhHansSettings, palette: zhHansPalette, chat: zhHansChat },
    },
    // Locale files are bundled per language, so nothing is fetched at runtime.
    // resolveUiLanguage only ever yields exact codes, so no non-explicit matching.
    supportedLngs: UI_LANGUAGES,
    interpolation: { escapeValue: false },
    returnNull: false,
    react: { useSuspense: false },
  });
}

/**
 * Maps the `uiLocale` setting plus the device languages to a bundled language.
 * `system` tries each device language in order; Traditional Chinese variants
 * fall back to English rather than showing the wrong script.
 */
export function resolveUiLanguage(
  uiLocale: UiLocale,
  systemLanguages: readonly string[],
): UiLanguage {
  if (uiLocale === "en") return "en";
  if (uiLocale === "zh-Hans") return "zh-Hans";
  for (const language of systemLanguages) {
    const normalized = language.toLowerCase();
    if (normalized.startsWith("zh")) {
      const scriptOrRegion = normalized.split("-")[1] ?? "";
      if (
        scriptOrRegion === "" ||
        scriptOrRegion === "hans" ||
        scriptOrRegion === "cn" ||
        scriptOrRegion === "sg"
      ) {
        return "zh-Hans";
      }
      continue;
    }
    if (normalized === "en" || normalized.startsWith("en-")) return "en";
  }
  return "en";
}

function applyUiLocale(uiLocale: UiLocale): void {
  void i18n.changeLanguage(
    resolveUiLanguage(uiLocale, [...(navigator.languages ?? []), navigator.language]),
  );
}

/** Applies the synced uiLocale now and on every server settings push. */
export function startUiLocaleSync(): () => void {
  return subscribeActiveUiLocale(applyUiLocale);
}

/** Cycles system → en → zh-Hans → system. */
export function nextUiLocale(uiLocale: UiLocale): UiLocale {
  return uiLocale === "system" ? "en" : uiLocale === "en" ? "zh-Hans" : "system";
}
