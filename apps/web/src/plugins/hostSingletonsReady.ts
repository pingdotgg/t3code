import type { PluginHostSingletons } from "./hostSingletons";

// Lightweight readiness half of the plugin host singletons. This module only
// wires up the shared `__T3_PLUGIN_HOST_READY__` promise (mirroring the head
// bootstrap script in @t3tools/shared/pluginHostWeb) — it must NOT import any
// host runtime modules. The heavy module (./hostSingletons) pulls the full
// `effect` barrel, `@t3tools/contracts`, and the SDK surface, so it stays
// code-split out of the main bundle and is loaded lazily by PluginUiHost when
// the first web plugin needs it.

declare global {
  // Host ESM shims read this object synchronously after the host publishes it.
  var __T3_PLUGIN_HOST__: PluginHostSingletons | undefined;
  var __T3_PLUGIN_HOST_READY__: Promise<PluginHostSingletons> | undefined;
  var __T3_PLUGIN_HOST_READY_RESOLVE__: ((host: PluginHostSingletons) => void) | undefined;
}

let resolvePluginHostReady: (host: PluginHostSingletons) => void = () => {};

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

/**
 * Publish the host singletons and resolve the shared readiness promise. Called
 * exactly once, by ./hostSingletons as its final module-evaluation statement.
 */
export function publishPluginHostSingletons(host: PluginHostSingletons): void {
  globalThis.__T3_PLUGIN_HOST__ = host;
  globalThis.__T3_PLUGIN_HOST_READY_RESOLVE__?.(host);
  resolvePluginHostReady(host);
}
