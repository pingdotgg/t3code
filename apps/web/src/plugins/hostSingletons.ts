import * as atomReact from "@effect/atom-react";
import * as pluginSdkWeb from "@t3tools/plugin-sdk-web";
import * as effect from "effect";
import * as React from "react";
import * as ReactDOM from "react-dom";
import * as ReactDOMClient from "react-dom/client";
import * as jsxDevRuntime from "react/jsx-dev-runtime";
import * as jsxRuntime from "react/jsx-runtime";

export interface PluginHostSingletons {
  readonly react: typeof React;
  readonly "react-dom": typeof ReactDOM;
  readonly "react-dom/client": typeof ReactDOMClient;
  readonly "react/jsx-runtime": typeof jsxRuntime;
  readonly "react/jsx-dev-runtime": typeof jsxDevRuntime;
  readonly "@effect/atom-react": typeof atomReact;
  readonly effect: typeof effect;
  readonly "@t3tools/plugin-sdk-web": typeof pluginSdkWeb;
}

declare global {
  // Host ESM shims read this object synchronously after the SPA boot module publishes it.
  // eslint-disable-next-line no-var
  var __T3_PLUGIN_HOST__: PluginHostSingletons | undefined;
  // eslint-disable-next-line no-var
  var __T3_PLUGIN_HOST_READY__: Promise<PluginHostSingletons> | undefined;
  // eslint-disable-next-line no-var
  var __T3_PLUGIN_HOST_READY_RESOLVE__: ((host: PluginHostSingletons) => void) | undefined;
}

let resolvePluginHostReady: (host: PluginHostSingletons) => void;

export const whenPluginHostReady =
  globalThis.__T3_PLUGIN_HOST_READY__ ??
  new Promise<PluginHostSingletons>((resolve) => {
    resolvePluginHostReady = resolve;
    globalThis.__T3_PLUGIN_HOST_READY_RESOLVE__ = resolve;
  });

if (!globalThis.__T3_PLUGIN_HOST_READY__) {
  globalThis.__T3_PLUGIN_HOST_READY__ = whenPluginHostReady;
} else {
  resolvePluginHostReady = globalThis.__T3_PLUGIN_HOST_READY_RESOLVE__ ?? (() => {});
}

const pluginHost: PluginHostSingletons = {
  react: React,
  "react-dom": ReactDOM,
  "react-dom/client": ReactDOMClient,
  "react/jsx-runtime": jsxRuntime,
  "react/jsx-dev-runtime": jsxDevRuntime,
  "@effect/atom-react": atomReact,
  effect,
  "@t3tools/plugin-sdk-web": pluginSdkWeb,
};

globalThis.__T3_PLUGIN_HOST__ = pluginHost;
globalThis.__T3_PLUGIN_HOST_READY_RESOLVE__?.(pluginHost);
resolvePluginHostReady!(pluginHost);

export function getPluginHost(): PluginHostSingletons {
  if (!globalThis.__T3_PLUGIN_HOST__) {
    throw new Error("T3 plugin host singletons have not been published.");
  }
  return globalThis.__T3_PLUGIN_HOST__;
}
