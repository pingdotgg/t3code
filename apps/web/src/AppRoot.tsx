import { RouterProvider } from "@tanstack/react-router";

import { BrowserProfileReporter } from "./browser/BrowserProfileReporter";
import { ElectronBrowserHost } from "./browser/ElectronBrowserHost";
import { QuitHoldOverlay } from "./components/QuitHoldOverlay";
import { LanguageSync } from "./i18n";
import { AppAtomRegistryProvider } from "./rpc/atomRegistry";
import type { AppRouter } from "./router";

/**
 * Owns renderer-wide providers. The Electron browser host intentionally sits
 * outside the router so its webviews survive route transitions, but it must
 * share the same atom registry as routed UI.
 *
 * `LanguageSync` also sits here rather than inside `__root`, which renders
 * several route-specific trees (pair, welcome, app). Keeping it above the
 * router means a new branch cannot silently render in the source language.
 */
export function AppRoot({ router }: { readonly router: AppRouter }) {
  return (
    <AppAtomRegistryProvider>
      <LanguageSync />
      <RouterProvider router={router} />
      <ElectronBrowserHost />
      <BrowserProfileReporter />
      <QuitHoldOverlay />
    </AppAtomRegistryProvider>
  );
}
