import { lazy } from "react";

import type { ClientPluginSdk } from "../PluginHost";
import { declareBuiltinFeatures } from "../features";

declareBuiltinFeatures("t3.markdown", ["markdown"]);

export function activate(sdk: ClientPluginSdk) {
  sdk.register([
    {
      slot: "markdown",
      order: -1000,
      component: lazy(() =>
        import("~/components/ChatMarkdown").then((module) => ({
          default: module.BuiltinChatMarkdown,
        })),
      ),
    },
  ]);
}
