import { lazy } from "react";

import type { ClientPluginSdk } from "../PluginHost";
import { declareBuiltinFeatures } from "../features";

declareBuiltinFeatures("t3.preview", ["preview", "preview.native-host", "preview.session-sync"]);

export function activate(sdk: ClientPluginSdk) {
  sdk.register([
    {
      slot: "preview",
      order: -1000,
      component: lazy(() =>
        import("~/components/preview/PreviewPanel").then((module) => ({
          default: module.BuiltinPreviewPanel,
        })),
      ),
    },
  ]);
  sdk.register([
    {
      slot: "preview.native-host",
      order: -1000,
      component: lazy(() =>
        import("~/browser/ElectronBrowserHost").then((module) => ({
          default: module.BuiltinElectronBrowserHost,
        })),
      ),
    },
  ]);
  sdk.register([
    {
      slot: "preview.session-sync",
      order: -1000,
      component: lazy(() =>
        import("~/components/ChatView").then((module) => ({
          default: module.BuiltinPreviewSessionSync,
        })),
      ),
    },
  ]);
}
