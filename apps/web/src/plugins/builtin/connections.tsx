import { lazy } from "react";

import type { ClientPluginSdk } from "../PluginHost";
import { declareBuiltinFeatures } from "../features";

declareBuiltinFeatures("t3.connections", [
  "settings.connections",
  "settings.access",
  "component:components/settings/ConnectionsSettings/ConnectionsSettings",
]);

export function activate(sdk: ClientPluginSdk) {
  sdk.register([
    {
      slot: "settings.connections",
      order: -1000,
      component: lazy(() =>
        import("~/components/settings/ConnectionsSettings").then((module) => ({
          default: () => <module.PluginOriginalConnectionsSettings view="environments" />,
        })),
      ),
    },
  ]);
  sdk.register([
    {
      slot: "settings.access",
      order: -1000,
      component: lazy(() =>
        import("~/components/settings/ConnectionsSettings").then((module) => ({
          default: () => <module.PluginOriginalConnectionsSettings view="access" />,
        })),
      ),
    },
  ]);
  sdk.register([
    {
      slot: "component:components/settings/ConnectionsSettings/ConnectionsSettings",
      order: -1000,
      component: lazy(() =>
        import("~/components/settings/ConnectionsSettings").then((module) => ({
          default: module.PluginOriginalConnectionsSettings,
        })),
      ),
    },
  ]);
}
