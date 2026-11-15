import { GTProvider } from "gt-react";
import { useSyncExternalStore, type ReactNode } from "react";

import { getI18nSnapshot, persistGTLocale, subscribeI18n } from "./runtime";

const reloadToSetting = (state: { readonly locale: string }) => persistGTLocale(state.locale);

export function I18nProvider({ children }: { readonly children: ReactNode }) {
  const { locale, translations } = useSyncExternalStore(subscribeI18n, getI18nSnapshot);
  return (
    <GTProvider locale={locale} translations={translations} _reload={reloadToSetting}>
      {children}
    </GTProvider>
  );
}
