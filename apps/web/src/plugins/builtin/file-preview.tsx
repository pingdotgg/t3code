import { lazy } from "react";

import type { ClientPluginSdk } from "../PluginHost";
import { declareBuiltinFeatures } from "../features";

declareBuiltinFeatures("t3.file-preview", ["file-preview"]);

export function activate(sdk: ClientPluginSdk) {
  sdk.register([
    {
      slot: "file-preview",
      order: -1000,
      component: lazy(() =>
        import("~/components/files/FilePreviewPanel").then((module) => ({
          default: module.BuiltinFilePreviewPanel,
        })),
      ),
    },
  ]);
}
