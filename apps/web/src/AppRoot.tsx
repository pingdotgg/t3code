import { RouterProvider } from "@tanstack/react-router";
import type { ReactElement } from "react";

import { AppAtomRegistryProvider } from "./rpc/atomRegistry";
import type { AppRouter } from "./router";

type ElectronOnlyHostsComponent = () => ReactElement | null;

/**
 * Owns renderer-wide providers. The Electron browser host intentionally sits
 * outside the router so its webviews survive route transitions, but it must
 * share the same atom registry as routed UI.
 */
export function AppRoot({
  router,
  electronOnlyHosts: ElectronOnlyHosts,
}: {
  readonly router: AppRouter;
  readonly electronOnlyHosts: ElectronOnlyHostsComponent | undefined;
}) {
  return (
    <AppAtomRegistryProvider>
      <RouterProvider router={router} />
      {ElectronOnlyHosts ? <ElectronOnlyHosts /> : null}
    </AppAtomRegistryProvider>
  );
}
