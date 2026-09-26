import { RouterProvider, useRouterState } from "@tanstack/react-router";

import { ElectronBrowserHost } from "./browser/ElectronBrowserHost";
import { PreviewAutomationHosts } from "./components/preview/PreviewAutomationHosts";
import { QuitHoldOverlay } from "./components/QuitHoldOverlay";
import { AppAtomRegistryProvider } from "./rpc/atomRegistry";
import type { AppRouter } from "./router";
import { resolveThreadRouteRef } from "./threadRoutes";

/**
 * Owns renderer-wide providers. The Electron browser host intentionally sits
 * outside the router so its webviews survive route transitions, but it must
 * share the same atom registry as routed UI.
 */
export function AppRoot({ router }: { readonly router: AppRouter }) {
  const routeEnvironmentId = useRouterState({
    router,
    select: (state) => resolveThreadRouteRef(state.matches.at(-1)?.params ?? {})?.environmentId,
  });
  const routeThreadId = useRouterState({
    router,
    select: (state) => resolveThreadRouteRef(state.matches.at(-1)?.params ?? {})?.threadId,
  });
  return (
    <AppAtomRegistryProvider>
      <RouterProvider router={router} />
      <PreviewAutomationHosts
        routeThreadRef={
          routeEnvironmentId && routeThreadId
            ? { environmentId: routeEnvironmentId, threadId: routeThreadId }
            : null
        }
      />
      <ElectronBrowserHost />
      <QuitHoldOverlay />
    </AppAtomRegistryProvider>
  );
}
