import { lazy } from "react";

import type { ClientPluginSdk } from "../PluginHost";
import { declareBuiltinFeatures } from "../features";

declareBuiltinFeatures("t3.diff", ["diff"]);

export function activate(sdk: ClientPluginSdk) {
  sdk.register([
    {
      slot: "diff",
      order: -1000,
      component: lazy(() =>
        import("~/components/DiffPanel").then((module) => ({
          default: module.BuiltinDiffPanel,
        })),
      ),
    },
  ]);
}
