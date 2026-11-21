import { lazy } from "react";

import type { ClientPluginSdk } from "../PluginHost";
import { declareBuiltinFeatures } from "../features";

declareBuiltinFeatures("t3.usage", ["usage"]);

export function activate(sdk: ClientPluginSdk) {
  sdk.register([
    {
      slot: "usage",
      order: -1000,
      component: lazy(() =>
        import("~/components/usage/UsagePage").then((module) => ({
          default: module.BuiltinUsagePage,
        })),
      ),
    },
  ]);
}
