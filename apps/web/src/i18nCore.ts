import enSettings from "../locales/en/settings.json";
import zhHansSettings from "../locales/zh-Hans/settings.json";
import enSidebar from "../locales/en/sidebar.json";
import zhHansSidebar from "../locales/zh-Hans/sidebar.json";
import { type UiLocale } from "@t3tools/contracts/settings";
import i18next from "i18next";
import { initReactI18next } from "react-i18next";

const UI_LANGUAGES = ["en", "zh-Hans"] as const;
export type UiLanguage = (typeof UI_LANGUAGES)[number];

declare module "i18next" {
  interface CustomTypeOptions {
    defaultNS: "settings";
    resources: {
      settings: typeof enSettings;
      sidebar: typeof enSidebar;
    };
  }
}

// The i18next global instance, so non-React modules can `i18next.t()` without
// importing the app-state side of i18n.ts into logic-only tests.
export const i18n = i18next;

// Init runs at import so `useTranslation` works wherever the module is reached
// from, including tests that render components directly.
if (!i18next.isInitialized) {
  void i18next.use(initReactI18next).init({
    lng: "en",
    fallbackLng: "en",
    defaultNS: "settings",
    ns: ["settings", "sidebar"],
    resources: {
      en: { settings: enSettings, sidebar: enSidebar },
      "zh-Hans": { settings: zhHansSettings, sidebar: zhHansSidebar },
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
