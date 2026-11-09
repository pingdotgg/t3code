import { WS_METHODS } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { Atom } from "effect/reactivity";

import type { PreparedHttpAuthorization } from "../connection/model.ts";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import { ManagedRelayDpopSigner } from "../relay/managedRelay.ts";
import { buildEnvironmentAuthHeaders } from "./environmentHttpAuth.ts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  createEnvironmentRpcSubscriptionAtomFamily,
  createRuntimeCommand,
} from "./runtime.ts";

/** Plugin management and calls into plugins. Nothing here runs until something reads it. */
export function createPluginEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    pluginsLive: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:plugins:live",
      tag: WS_METHODS.pluginsSubscribeStates,
    }),
    pluginSettings: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:plugins:settings",
      tag: WS_METHODS.pluginsSettingsGet,
      // Dropped when the editor closes, so reopening it shows the saved values.
      idleTtlMs: 0,
    }),
    setPluginEnabled: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:plugins:set-enabled",
      tag: WS_METHODS.pluginsSetEnabled,
    }),
    reloadPlugin: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:plugins:reload",
      tag: WS_METHODS.pluginsReload,
    }),
    // Signs the URL a dropped folder is uploaded to; see `PluginCreateUploadUrlResult`.
    createPluginUploadUrl: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:plugins:create-upload-url",
      tag: WS_METHODS.pluginsCreateUploadUrl,
    }),
    rescanPlugins: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:plugins:rescan",
      tag: WS_METHODS.pluginsRescan,
    }),
    linkPlugin: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:plugins:link",
      tag: WS_METHODS.pluginsLink,
    }),
    uninstallPlugin: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:plugins:uninstall",
      tag: WS_METHODS.pluginsUninstall,
    }),
    updatePluginSettings: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:plugins:update-settings",
      tag: WS_METHODS.pluginsSettingsUpdate,
    }),
    // Web plugins call their own server half through these.
    invokePlugin: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:plugins:invoke",
      tag: WS_METHODS.pluginsInvoke,
    }),
    pluginChannel: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:plugins:channel",
      tag: WS_METHODS.pluginsSubscribe,
      // A restart ends the server's stream, so the reloaded web half needs a new one, not this one.
      idleTtlMs: 0,
    }),
    // Plugin bundles and assets are plain GETs; over T3 Connect each needs its own DPoP proof.
    pluginFileHeaders: createRuntimeCommand(runtime, {
      label: "environment-data:plugins:file-headers",
      execute: (input: {
        readonly authorization: PreparedHttpAuthorization;
        readonly url: string;
      }) =>
        Effect.flatMap(Effect.serviceOption(ManagedRelayDpopSigner), (signer) =>
          buildEnvironmentAuthHeaders(input.authorization, "GET", input.url, signer),
        ).pipe(Effect.map((headers): Readonly<Record<string, string>> => ({ ...headers }))),
    }),
  };
}
