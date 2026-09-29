import { createInstance, type i18n, type InitOptions } from "i18next";
import type {
  LocalePreference as LocalePreferenceType,
  SupportedLocale as SupportedLocaleType,
} from "@t3tools/contracts/settings";
import type { ProjectCloneStage } from "@t3tools/contracts";
import { resources } from "./resources.ts";

export type { TFunction } from "i18next";

export { resources } from "./resources.ts";

export type SupportedLocale = SupportedLocaleType;
export type LocalePreference = LocalePreferenceType;
export type KeybindingsTranslationKey = keyof (typeof resources)["en"]["keybindings"];
export type IntegrationsTranslationKey = keyof (typeof resources)["en"]["integrations"];

export type ProjectCloneStageTranslationKey =
  | "connecting"
  | "countingObjects"
  | "receivingObjects"
  | "resolvingDeltas"
  | "checkingOutFiles";

export function projectCloneStageTranslationKey(
  stage: ProjectCloneStage,
): ProjectCloneStageTranslationKey {
  switch (stage) {
    case "connecting":
      return "connecting";
    case "counting":
      return "countingObjects";
    case "receiving":
      return "receivingObjects";
    case "resolving":
      return "resolvingDeltas";
    case "checkout":
      return "checkingOutFiles";
  }
}

export type ServerUpdateStageTranslationKey = "downloading" | "restarting";

export function serverUpdateStageTranslationKey(
  stage: "downloading" | "installing" | "resuming",
): ServerUpdateStageTranslationKey {
  return stage === "resuming" ? "restarting" : "downloading";
}

export const SUPPORTED_LOCALES: ReadonlyArray<SupportedLocale> = ["en", "zh-CN"];

let activeLocale: SupportedLocale = "en";
const dateTimeFormatterCache = new Map<string, Intl.DateTimeFormat>();

export function setActiveLocale(locale: SupportedLocale): void {
  activeLocale = locale;
}

export function getActiveLocale(): SupportedLocale {
  return activeLocale;
}

export function getLocalizedDateTimeFormatter(
  options: Intl.DateTimeFormatOptions,
  locale: SupportedLocale = activeLocale,
): Intl.DateTimeFormat {
  const cacheKey = `${locale}:${JSON.stringify(options)}`;
  const cached = dateTimeFormatterCache.get(cacheKey);
  if (cached) return cached;
  const formatter = new Intl.DateTimeFormat(locale, options);
  dateTimeFormatterCache.set(cacheKey, formatter);
  return formatter;
}

export function resolveSupportedLocale(
  preference: LocalePreference | null | undefined,
  systemLocales: ReadonlyArray<string | null | undefined>,
): SupportedLocale {
  if (preference === "en" || preference === "zh-CN") return preference;

  for (const candidate of systemLocales) {
    if (!candidate?.trim()) continue;
    try {
      const locale = new Intl.Locale(candidate.replaceAll("_", "-"));
      if (locale.language === "en") return "en";
      if (locale.language !== "zh") continue;
      if (
        locale.script === "Hant" ||
        locale.region === "TW" ||
        locale.region === "HK" ||
        locale.region === "MO"
      ) {
        return "en";
      }
      return "zh-CN";
    } catch {
      continue;
    }
  }

  return "en";
}

export function getT3I18nOptions(locale: SupportedLocale): InitOptions {
  return {
    resources,
    lng: locale,
    fallbackLng: "en",
    supportedLngs: SUPPORTED_LOCALES,
    defaultNS: "common",
    ns: [
      "common",
      "settings",
      "desktop",
      "connections",
      "snooze",
      "diffs",
      "sidebar",
      "projectScripts",
      "deviceTools",
      "onboarding",
      "gitActions",
      "branchToolbar",
      "browserDeviceToolbar",
      "agents",
      "chatView",
      "projectClone",
      "serverUpdate",
      "usage",
      "markdown",
      "keybindings",
      "integrations",
      "storage",
      "projectDefaults",
      "pullRequests",
    ],
    returnNull: false,
    interpolation: { escapeValue: false },
    react: { useSuspense: false },
  };
}

export function createT3I18n(locale: SupportedLocale): i18n {
  const instance = createInstance();
  void instance.init(getT3I18nOptions(locale));
  return instance;
}

declare module "i18next" {
  interface CustomTypeOptions {
    defaultNS: "common";
    resources: (typeof resources)["en"];
    returnNull: false;
  }
}
