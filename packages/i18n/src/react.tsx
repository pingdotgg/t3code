import { useEffect, useState, type ReactNode } from "react";
import { createInstance } from "i18next";
import { I18nextProvider, initReactI18next, useTranslation } from "react-i18next";
import {
  getT3I18nOptions,
  resolveSupportedLocale,
  setActiveLocale,
  type LocalePreference,
} from "./index.ts";

export function T3I18nProvider(props: {
  readonly children: ReactNode;
  readonly preference: LocalePreference | null | undefined;
  readonly systemLocales: ReadonlyArray<string | null | undefined>;
  readonly onLocaleChange?: ((locale: "en" | "zh-CN") => void) | undefined;
}) {
  const locale = resolveSupportedLocale(props.preference, props.systemLocales);
  const [i18n] = useState(() => {
    setActiveLocale(locale);
    if (typeof document !== "undefined") document.documentElement.lang = locale;
    const instance = createInstance();
    void instance.use(initReactI18next).init(getT3I18nOptions(locale));
    return instance;
  });

  useEffect(() => {
    setActiveLocale(locale);
    if (typeof document !== "undefined") document.documentElement.lang = locale;
    if (i18n.language !== locale) void i18n.changeLanguage(locale);
    props.onLocaleChange?.(locale);
  }, [i18n, locale, props.onLocaleChange]);

  return <I18nextProvider i18n={i18n}>{props.children}</I18nextProvider>;
}

export { useTranslation };
