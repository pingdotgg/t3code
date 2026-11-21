import { lazy } from "react";

import type { ClientPluginSdk } from "../PluginHost";
import { declareBuiltinFeatures } from "../features";

declareBuiltinFeatures("t3.providers", [
  "settings.providers",
  "component:components/settings/ProviderSettingsPanel/ProviderSettingsPanel",
  "component:components/settings/ProviderSettingsPanel/EnvironmentProviderSettings",
]);

export function activate(sdk: ClientPluginSdk) {
  sdk.register([
    {
      slot: "settings.providers",
      order: -1000,
      component: lazy(() =>
        import("~/components/settings/SettingsProvidersPage").then((module) => ({
          default: module.SettingsProvidersRoute,
        })),
      ),
    },
  ]);
  sdk.register([
    {
      slot: "component:components/settings/ProviderSettingsPanel/ProviderSettingsPanel",
      order: -1000,
      component: lazy(() =>
        import("~/components/settings/ProviderSettingsPanel").then((module) => ({
          default: module.PluginOriginalProviderSettingsPanel,
        })),
      ),
    },
  ]);
  sdk.register([
    {
      slot: "component:components/settings/ProviderSettingsPanel/EnvironmentProviderSettings",
      order: -1000,
      component: lazy(() =>
        import("~/components/settings/ProviderSettingsPanel").then((module) => ({
          default: module.PluginOriginalEnvironmentProviderSettings,
        })),
      ),
    },
  ]);
}
