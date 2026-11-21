import { lazy } from "react";

import type { ClientPluginSdk } from "../PluginHost";
import { declareBuiltinFeatures } from "../features";

declareBuiltinFeatures("t3.sidebar", ["sidebar.thread", "sidebar.settings"]);

export function activate(sdk: ClientPluginSdk) {
  sdk.register([
    {
      slot: "sidebar.thread",
      order: -1000,
      component: lazy(() =>
        import("~/components/Sidebar").then((module) => ({
          default: module.BuiltinSidebar,
        })),
      ),
    },
  ]);
  sdk.register([
    {
      slot: "sidebar.settings",
      order: -1000,
      component: lazy(() =>
        import("~/components/settings/SettingsSidebarNav").then((module) => ({
          default: module.BuiltinSettingsSidebarNav,
        })),
      ),
    },
  ]);
}
