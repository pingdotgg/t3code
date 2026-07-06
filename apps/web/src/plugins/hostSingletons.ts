import * as atomReact from "@effect/atom-react";
import * as contracts from "@t3tools/contracts";
import * as pluginSdkWeb from "@t3tools/plugin-sdk-web";
import * as effect from "effect";
import * as React from "react";
import * as ReactDOM from "react-dom";
import * as ReactDOMClient from "react-dom/client";
import * as jsxDevRuntime from "react/jsx-dev-runtime";
import * as jsxRuntime from "react/jsx-runtime";

import { publishPluginHostSingletons, whenPluginHostReady } from "./hostSingletonsReady";

// Heavy half of the plugin host singletons: importing this module pulls the
// full `effect` barrel, the whole `@t3tools/contracts` surface, and the SDK's
// host re-exports. It is only imported dynamically (PluginUiHost, when the
// first active web plugin needs the host), so all of that stays out of the
// main web bundle. The readiness promise lives in ./hostSingletonsReady.

export interface PluginHostSingletons {
  readonly react: typeof React;
  readonly "react-dom": typeof ReactDOM;
  readonly "react-dom/client": typeof ReactDOMClient;
  readonly "react/jsx-runtime": typeof jsxRuntime;
  readonly "react/jsx-dev-runtime": typeof jsxDevRuntime;
  readonly "@effect/atom-react": typeof atomReact;
  readonly effect: typeof effect;
  readonly "@t3tools/contracts": typeof contracts;
  readonly "@t3tools/plugin-sdk-web": typeof pluginSdkWeb;
}

const pluginHost: PluginHostSingletons = {
  react: React,
  "react-dom": ReactDOM,
  "react-dom/client": ReactDOMClient,
  "react/jsx-runtime": jsxRuntime,
  "react/jsx-dev-runtime": jsxDevRuntime,
  "@effect/atom-react": atomReact,
  effect,
  "@t3tools/contracts": contracts,
  "@t3tools/plugin-sdk-web": pluginSdkWeb,
};

publishPluginHostSingletons(pluginHost);

export { whenPluginHostReady };

export function getPluginHost(): PluginHostSingletons {
  if (!globalThis.__T3_PLUGIN_HOST__) {
    throw new Error("T3 plugin host singletons have not been published.");
  }
  return globalThis.__T3_PLUGIN_HOST__;
}
