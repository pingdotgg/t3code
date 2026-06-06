import { registerPluginUi, type T3PluginHostGlobal } from "@t3tools/plugin-api/ui";

import { VOICE_INPUT_ACTION_ID, VOICE_INPUT_PLUGIN_ID } from "../shared/constants.ts";
import { VoiceInputComposerAction } from "./VoiceInputComposerAction.tsx";
import { VoiceInputSettingsPage } from "./VoiceInputSettingsPage.tsx";

declare global {
  interface Window {
    readonly T3PluginHost?: T3PluginHostGlobal;
  }
}

const host = window.T3PluginHost;
if (!host) {
  throw new Error("T3PluginHost is not available.");
}

registerPluginUi(host, VOICE_INPUT_PLUGIN_ID, () => ({
  routes: {
    main: ({ ctx: routeCtx }) => {
      return routeCtx.react.createElement(VoiceInputSettingsPage, { ctx: routeCtx });
    },
  },
  composerActions: {
    [VOICE_INPUT_ACTION_ID]: ({ ctx: actionCtx }) => {
      return actionCtx.react.createElement(VoiceInputComposerAction, { ctx: actionCtx });
    },
  },
}));
