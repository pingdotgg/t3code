import { RouterProvider } from "@tanstack/react-router";

import { ElectronBrowserHost } from "./browser/ElectronBrowserHost";
import { QuitHoldOverlay } from "./components/QuitHoldOverlay";
import { I18nProvider } from "./i18n/I18nProvider";
import { AppAtomRegistryProvider } from "./rpc/atomRegistry";
import type { AppRouter } from "./router";
import { EnvironmentPluginHost } from "./plugins/PluginHost";
import { useEnvironments, usePrimaryEnvironmentId } from "./state/environments";
import { PluginRecoveryManager } from "./plugins/RecoveryManager";
import { PluginSlot } from "./plugins/features";

function PersistentBrowserPluginHosts() {
  const environmentId = usePrimaryEnvironmentId();
  return (
    <EnvironmentPluginHost environmentId={environmentId}>
      <ElectronBrowserHost />
    </EnvironmentPluginHost>
  );
}

function RoutedPluginClient({ router }: { readonly router: AppRouter }) {
  const environmentId = usePrimaryEnvironmentId();
  return (
    <EnvironmentPluginHost environmentId={environmentId}>
      <RouterProvider router={router} />
    </EnvironmentPluginHost>
  );
}

function PersistentCanvasPluginHosts({ router }: { readonly router: AppRouter }) {
  const { environments } = useEnvironments();
  return environments.map(({ environmentId }) => (
    <EnvironmentPluginHost key={environmentId} environmentId={environmentId}>
      <PluginSlot slot="canvas.host" props={{ environmentId, router }} />
    </EnvironmentPluginHost>
  ));
}

// Keep webviews outside the router but inside its atom registry so route changes preserve them.
export function AppRoot({ router }: { readonly router: AppRouter }) {
  return (
    <I18nProvider>
      <AppAtomRegistryProvider>
        <RoutedPluginClient router={router} />
        <PersistentBrowserPluginHosts />
        <PluginRecoveryManager />
        <PersistentCanvasPluginHosts router={router} />
        <QuitHoldOverlay />
      </AppAtomRegistryProvider>
    </I18nProvider>
  );
}
