import { DirectionProvider } from "@base-ui/react/direction-provider";
import { GTProvider } from "gt-react";
import { useSyncExternalStore, type ReactNode } from "react";

import { localeDirection } from "./locales";
import { getI18nSnapshot, persistGTLocale, subscribeI18n } from "./runtime";

const reloadToSetting = (state: { readonly locale: string }) => persistGTLocale(state.locale);

export function I18nProvider({ children }: { readonly children: ReactNode }) {
  const { locale, translations } = useSyncExternalStore(subscribeI18n, getI18nSnapshot);
  return (
    <GTProvider locale={locale} translations={translations} _reload={reloadToSetting}>
      <DirectionProvider direction={localeDirection(locale)}>{children}</DirectionProvider>
    </GTProvider>
  );
}
