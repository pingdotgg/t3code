import {
  type AuthEnvironmentScope,
  PluginError,
  type PluginCreateUploadUrlInput,
  type PluginId,
  type PluginInvokeInput,
  type PluginLinkInput,
  type PluginListInput,
  type PluginReloadInput,
  type PluginRescanInput,
  type PluginSetEnabledInput,
  type PluginSettingsGetInput,
  type PluginSettingsUpdateInput,
  type PluginSubscribeInput,
  type PluginUninstallInput,
  WS_METHODS,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import { rpcAuthorizationError } from "../auth/RpcAuthorization.ts";
import * as PluginHost from "./PluginHost.ts";
import type * as PluginInstaller from "./PluginInstaller.ts";
import type * as PluginUploads from "./PluginUploads.ts";

const toRpcError = (pluginId: PluginId) => (error: { readonly message: string }) =>
  PluginHost.isPluginAccessDeniedError(error)
    ? rpcAuthorizationError(error.requiredScope)
    : new PluginError({ message: error.message, pluginId });

export const makePluginRpcHandlers = (
  pluginHost: PluginHost.PluginHost["Service"],
  installer: PluginInstaller.PluginInstaller["Service"],
  uploads: PluginUploads.PluginUploads["Service"],
  scopes: ReadonlyArray<AuthEnvironmentScope>,
) => ({
  [WS_METHODS.pluginsSubscribeStates]: (_input: PluginListInput) =>
    pluginHost.streamForClient(scopes),
  [WS_METHODS.pluginsSetEnabled]: (input: PluginSetEnabledInput) =>
    pluginHost.setEnabled(input.pluginId, input.enabled).pipe(
      Effect.map((plugin) => ({ plugin })),
      Effect.mapError(toRpcError(input.pluginId)),
    ),
  [WS_METHODS.pluginsReload]: (input: PluginReloadInput) =>
    pluginHost.reload(input.pluginId).pipe(
      Effect.map((plugin) => ({ plugin })),
      Effect.mapError(toRpcError(input.pluginId)),
    ),
  [WS_METHODS.pluginsCreateUploadUrl]: (_input: PluginCreateUploadUrlInput) =>
    uploads.issueUrl.pipe(Effect.mapError((error) => new PluginError({ message: error.message }))),
  [WS_METHODS.pluginsRescan]: (_input: PluginRescanInput) =>
    pluginHost.rescan.pipe(Effect.mapError((error) => new PluginError({ message: error.message }))),
  [WS_METHODS.pluginsLink]: (input: PluginLinkInput) =>
    installer.link(input.folder).pipe(
      Effect.map((plugin) => ({ plugin })),
      Effect.mapError((error) => new PluginError({ message: error.message })),
    ),
  [WS_METHODS.pluginsUninstall]: (input: PluginUninstallInput) =>
    installer
      .uninstall(input.pluginId)
      .pipe(Effect.as({ pluginId: input.pluginId }), Effect.mapError(toRpcError(input.pluginId))),
  [WS_METHODS.pluginsSettingsGet]: (input: PluginSettingsGetInput) =>
    pluginHost.getSettings(input.pluginId).pipe(
      Effect.map((result) => ({ pluginId: input.pluginId, ...result })),
      Effect.mapError(toRpcError(input.pluginId)),
    ),
  [WS_METHODS.pluginsSettingsUpdate]: (input: PluginSettingsUpdateInput) =>
    pluginHost.updateSettings(input.pluginId, input.patch).pipe(
      Effect.map((settings) => ({ pluginId: input.pluginId, settings })),
      Effect.mapError(toRpcError(input.pluginId)),
    ),
  [WS_METHODS.pluginsInvoke]: (input: PluginInvokeInput) =>
    pluginHost
      .invoke({ pluginId: input.pluginId, method: input.method, input: input.input, scopes })
      .pipe(
        Effect.map((output) => ({ output })),
        Effect.mapError(toRpcError(input.pluginId)),
      ),
  [WS_METHODS.pluginsSubscribe]: (input: PluginSubscribeInput) =>
    pluginHost.subscribe(input).pipe(
      Stream.map((value) => ({ value })),
      Stream.mapError(toRpcError(input.pluginId)),
    ),
});
