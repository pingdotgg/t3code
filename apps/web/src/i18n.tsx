import { useEffect, useMemo } from "react";
import { createTranslator } from "@t3tools/client-runtime/i18n";

import { useClientSettings } from "./hooks/useSettings";

export function useTranslation() {
  const language = useClientSettings((settings) => settings.interfaceLanguage);
  return useMemo(() => createTranslator(language), [language]);
}

/** Keep assistive technology in sync, including on routes outside the app shell. */
export function DocumentLanguage() {
  const language = useClientSettings((settings) => settings.interfaceLanguage);
  useEffect(() => {
    document.documentElement.lang = language;
  }, [language]);
  return null;
}
