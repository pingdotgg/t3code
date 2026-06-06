import { registerPluginUi, type T3PluginHostGlobal } from "@t3tools/plugin-api/ui";

import { AUTOMATIONS_PLUGIN_ID } from "../shared/constants.ts";
import { AutomationsPage } from "./AutomationsPage.tsx";

declare global {
  interface Window {
    readonly T3PluginHost?: T3PluginHostGlobal;
  }
}

const host = window.T3PluginHost;
if (!host) {
  throw new Error("T3PluginHost is not available.");
}

registerPluginUi(host, AUTOMATIONS_PLUGIN_ID, () => ({
  routes: {
    main: ({ ctx: routeCtx }) => {
      return routeCtx.react.createElement(AutomationsPage, { ctx: routeCtx });
    },
  },
}));
