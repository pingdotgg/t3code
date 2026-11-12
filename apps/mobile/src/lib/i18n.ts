// Shares the web app's bundled locale files; Metro watches the workspace root,
// so the relative import across apps resolves at bundle time.
import enSettings from "../../../web/locales/en/settings.json";
import zhHansSettings from "../../../web/locales/zh-Hans/settings.json";
import i18next, { type i18n as I18n } from "i18next";
import { initReactI18next } from "react-i18next";

i18next.use(initReactI18next).init({
  ns: ["settings"],
  defaultNS: "settings",
  resources: {
    en: { settings: enSettings },
    "zh-Hans": { settings: zhHansSettings },
  },
  lng: "en",
  fallbackLng: "en",
  interpolation: { escapeValue: false },
});

export const i18n: I18n = i18next;
