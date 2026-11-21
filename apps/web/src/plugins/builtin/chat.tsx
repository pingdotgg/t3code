import { lazy } from "react";

import type { ClientPluginSdk } from "../PluginHost";
import { declareBuiltinFeatures } from "../features";

declareBuiltinFeatures("t3.chat", ["chat"]);

export function activate(sdk: ClientPluginSdk) {
  sdk.register([
    {
      slot: "chat",
      order: -1000,
      component: lazy(() =>
        import("~/components/ChatView").then((module) => ({
          default: module.BuiltinChatView,
        })),
      ),
    },
  ]);
}
