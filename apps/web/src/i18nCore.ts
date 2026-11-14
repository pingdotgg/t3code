import enChat from "../locales/en/chat.json";
import enDiffs from "../locales/en/diffs.json";
import enPalette from "../locales/en/palette.json";
import enSettings from "../locales/en/settings.json";
import enTerminal from "../locales/en/terminal.json";
import zhHansChat from "../locales/zh-Hans/chat.json";
import zhHansDiffs from "../locales/zh-Hans/diffs.json";
import zhHansPalette from "../locales/zh-Hans/palette.json";
import zhHansSettings from "../locales/zh-Hans/settings.json";
import zhHansTerminal from "../locales/zh-Hans/terminal.json";
import enSidebar from "../locales/en/sidebar.json";
import zhHansSidebar from "../locales/zh-Hans/sidebar.json";
import enPullRequest from "../locales/en/pullRequest.json";
import zhHansPullRequest from "../locales/zh-Hans/pullRequest.json";
import enRightPanel from "../locales/en/rightPanel.json";
import zhHansRightPanel from "../locales/zh-Hans/rightPanel.json";
import enFiles from "../locales/en/files.json";
import zhHansFiles from "../locales/zh-Hans/files.json";
import enPreview from "../locales/en/preview.json";
import zhHansPreview from "../locales/zh-Hans/preview.json";
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
      palette: typeof enPalette;
      chat: typeof enChat;
      diffs: typeof enDiffs;
      terminal: typeof enTerminal;
      pullRequest: typeof enPullRequest;
      rightPanel: typeof enRightPanel;
      files: typeof enFiles;
      preview: typeof enPreview;
    };
  }
}

// The i18next global instance, so non-React modules can `i18next.t()` without
// importing the app-state side of i18n.ts into logic-only tests.
export const i18n = i18next;

/** Translates a key that is computed at runtime and lives outside the typed key union. */
export function translateDynamic(key: string, options?: Record<string, unknown>): string {
  return options === undefined
    ? (i18n.t(key as never) as string)
    : (i18n.t(key as never, { ...options }) as string);
}

// Init runs at import so `useTranslation` works wherever the module is reached
// from, including tests that render components directly.
if (!i18next.isInitialized) {
  void i18next.use(initReactI18next).init({
    lng: "en",
    fallbackLng: "en",
    defaultNS: "settings",
    ns: [
      "settings",
      "sidebar",
      "palette",
      "chat",
      "diffs",
      "terminal",
      "pullRequest",
      "rightPanel",
    ],
    resources: {
      en: {
        settings: enSettings,
        sidebar: enSidebar,
        palette: enPalette,
        chat: enChat,
        diffs: enDiffs,
        terminal: enTerminal,
        pullRequest: enPullRequest,
        rightPanel: enRightPanel,
        files: enFiles,
        preview: enPreview,
      },
      "zh-Hans": {
        settings: zhHansSettings,
        sidebar: zhHansSidebar,
        palette: zhHansPalette,
        chat: zhHansChat,
        diffs: zhHansDiffs,
        terminal: zhHansTerminal,
        pullRequest: zhHansPullRequest,
        rightPanel: zhHansRightPanel,
        files: zhHansFiles,
        preview: zhHansPreview,
      },
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
