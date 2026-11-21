import { lazy } from "react";

import type { ClientPluginSdk } from "../PluginHost";
import { declareBuiltinFeatures } from "../features";

declareBuiltinFeatures("t3.ui", [
  "app-layout",
  "command-palette",
  "component:components/preview/ThreadPreviewMiniPlayer/ThreadPreviewMiniPlayer",
]);

export function activate(sdk: ClientPluginSdk) {
  sdk.register([
    {
      slot: "app-layout",
      order: -1000,
      component: lazy(() =>
        import("~/components/AppSidebarLayout").then((module) => ({
          default: module.BuiltinAppSidebarLayout,
        })),
      ),
    },
  ]);
  sdk.register([
    {
      slot: "command-palette",
      order: -1000,
      component: lazy(() =>
        import("~/components/CommandPalette").then((module) => ({
          default: module.BuiltinCommandPalette,
        })),
      ),
    },
  ]);
  sdk.register([
    {
      slot: "component:components/preview/ThreadPreviewMiniPlayer/ThreadPreviewMiniPlayer",
      order: -1000,
      component: lazy(() =>
        import("~/components/preview/ThreadPreviewMiniPlayer").then((module) => ({
          default: module.PluginOriginalThreadPreviewMiniPlayer,
        })),
      ),
    },
  ]);
}
