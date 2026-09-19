import { RouterProvider } from "@tanstack/react-router";
import { useEffect } from "react";

import { ElectronBrowserHost } from "./browser/ElectronBrowserHost";
import { PreviewAutomationHosts } from "./components/preview/PreviewAutomationHosts";
import { QuitHoldOverlay } from "./components/QuitHoldOverlay";
import { useClientSettings, useClientSettingsHydrated } from "./hooks/useSettings";
import { markInterfaceLanguageConfigured, setInterfaceLanguage } from "./i18n/translate";
import { AppAtomRegistryProvider } from "./rpc/atomRegistry";
import type { AppRouter } from "./router";

function InterfaceLanguageBootstrap() {
  const interfaceLanguage = useClientSettings((settings) => settings.interfaceLanguage);
  const settingsHydrated = useClientSettingsHydrated();

  useEffect(() => {
    if (!settingsHydrated) return;
    setInterfaceLanguage(interfaceLanguage);
    markInterfaceLanguageConfigured();
  }, [interfaceLanguage, settingsHydrated]);

  return null;
}

/**
 * Owns renderer-wide providers. The Electron browser host intentionally sits
 * outside the router so its webviews survive route transitions, but it must
 * share the same atom registry as routed UI.
 */
export function AppRoot({ router }: { readonly router: AppRouter }) {
  return (
    <AppAtomRegistryProvider>
      <InterfaceLanguageBootstrap />
      <RouterProvider router={router} />
      <PreviewAutomationHosts />
      <ElectronBrowserHost />
      <QuitHoldOverlay />
    </AppAtomRegistryProvider>
  );
}
