import { RouterProvider } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { T3I18nProvider } from "@t3tools/i18n/react";

import { ElectronBrowserHost } from "./browser/ElectronBrowserHost";
import { PreviewAutomationHosts } from "./components/preview/PreviewAutomationHosts";
import { QuitHoldOverlay } from "./components/QuitHoldOverlay";
import { AppAtomRegistryProvider } from "./rpc/atomRegistry";
import { useClientSettings } from "./hooks/useSettings";
import type { AppRouter } from "./router";

/**
 * Owns renderer-wide providers. The Electron browser host intentionally sits
 * outside the router so its webviews survive route transitions, but it must
 * share the same atom registry as routed UI.
 */
export function AppRoot({ router }: { readonly router: AppRouter }) {
  return (
    <AppAtomRegistryProvider>
      <LocalizedApp router={router} />
    </AppAtomRegistryProvider>
  );
}

function readSystemLocales(): ReadonlyArray<string> {
  const desktopLocale = window.desktopBridge?.getSystemLocale?.();
  return [desktopLocale, ...navigator.languages].filter(
    (locale): locale is string => typeof locale === "string" && locale.length > 0,
  );
}

function LocalizedApp({ router }: { readonly router: AppRouter }) {
  const localePreference = useClientSettings((settings) => settings.localePreference);
  const [systemLocales, setSystemLocales] = useState(readSystemLocales);
  const setDesktopLocale = useCallback((locale: "en" | "zh-CN") => {
    void window.desktopBridge?.setInterfaceLocale?.(locale);
  }, []);

  useEffect(() => {
    const refresh = () => {
      const next = readSystemLocales();
      setSystemLocales((current) =>
        current.length === next.length && current.every((locale, index) => locale === next[index])
          ? current
          : next,
      );
    };
    window.addEventListener("languagechange", refresh);
    window.addEventListener("focus", refresh);
    return () => {
      window.removeEventListener("languagechange", refresh);
      window.removeEventListener("focus", refresh);
    };
  }, []);

  return (
    <T3I18nProvider
      preference={localePreference}
      systemLocales={systemLocales}
      onLocaleChange={setDesktopLocale}
    >
      <RouterProvider router={router} />
      <PreviewAutomationHosts />
      <ElectronBrowserHost />
      <QuitHoldOverlay />
    </T3I18nProvider>
  );
}
