import * as Effect from "effect/Effect";

import type { PluginMarketplaceHarnessId, PluginMarketplaceSetupAction } from "@t3tools/contracts";
import { PrimaryEnvironmentHttpClient } from "~/environments/primary/httpClient";
import { runPrimaryHttp } from "~/lib/runtime";

export function fetchPluginMarketplaceCatalog(query?: string) {
  return runPrimaryHttp(
    PrimaryEnvironmentHttpClient.pipe(
      Effect.flatMap((client) =>
        client.plugins.catalog({
          headers: {},
          payload: query?.trim() ? { q: query } : {},
        }),
      ),
    ),
  );
}

export function fetchPluginMarketplaceDetail(pluginId: string) {
  return runPrimaryHttp(
    PrimaryEnvironmentHttpClient.pipe(
      Effect.flatMap((client) => client.plugins.detail({ headers: {}, params: { pluginId } })),
    ),
  );
}

export function fetchPluginMarketplaceLogo(pluginId: string) {
  return runPrimaryHttp(
    PrimaryEnvironmentHttpClient.pipe(
      Effect.flatMap((client) => client.plugins.logo({ headers: {}, params: { pluginId } })),
    ),
  );
}

export function fetchPluginMcpAuth(pluginId: string) {
  return runPrimaryHttp(
    PrimaryEnvironmentHttpClient.pipe(
      Effect.flatMap((client) => client.plugins.mcpAuth({ headers: {}, params: { pluginId } })),
    ),
  );
}

export function startPluginMcpAuth(
  pluginId: string,
  harness: PluginMarketplaceHarnessId,
  serverId: string,
) {
  return runPrimaryHttp(
    PrimaryEnvironmentHttpClient.pipe(
      Effect.flatMap((client) =>
        client.plugins.startMcpAuth({
          headers: {},
          params: { pluginId },
          payload: { harness, serverId },
        }),
      ),
    ),
  );
}

export function completePluginMcpAuth(
  pluginId: string,
  harness: PluginMarketplaceHarnessId,
  serverId: string,
  callbackUrl: string,
) {
  return runPrimaryHttp(
    PrimaryEnvironmentHttpClient.pipe(
      Effect.flatMap((client) =>
        client.plugins.completeMcpAuth({
          headers: {},
          params: { pluginId },
          payload: { harness, serverId, callbackUrl },
        }),
      ),
    ),
  );
}

export function disconnectPluginMcpAuth(
  pluginId: string,
  harness: PluginMarketplaceHarnessId,
  serverId: string,
) {
  return runPrimaryHttp(
    PrimaryEnvironmentHttpClient.pipe(
      Effect.flatMap((client) =>
        client.plugins.disconnectMcpAuth({
          headers: {},
          params: { pluginId },
          payload: { harness, serverId },
        }),
      ),
    ),
  );
}

export function installPlugin(pluginId: string) {
  return runPrimaryHttp(
    PrimaryEnvironmentHttpClient.pipe(
      Effect.flatMap((client) => client.plugins.install({ headers: {}, params: { pluginId } })),
    ),
  );
}

export function openPluginSetup(pluginId: string, action: PluginMarketplaceSetupAction) {
  return runPrimaryHttp(
    PrimaryEnvironmentHttpClient.pipe(
      Effect.flatMap((client) =>
        client.plugins.setup({ headers: {}, params: { pluginId }, payload: { action } }),
      ),
    ),
  );
}

export function removePlugin(pluginId: string) {
  return runPrimaryHttp(
    PrimaryEnvironmentHttpClient.pipe(
      Effect.flatMap((client) => client.plugins.remove({ headers: {}, params: { pluginId } })),
    ),
  );
}
