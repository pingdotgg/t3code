import type { WsRpcClient } from "@t3tools/client-runtime";
import {
  PLUGIN_CATALOG_INVALIDATED_EVENT_TYPE,
  type PluginSubscriptionEvent,
} from "@t3tools/contracts";

import { toastManager } from "../components/ui/toast";
import {
  installGlobalPluginHost,
  loadActivePluginScripts,
  removePluginScriptsForAssetKeys,
  removePluginScriptsForScope,
} from "./pluginClientAssetLoader";
import {
  clearPluginHostState,
  readPluginHostState,
  resetPluginHostState,
  setPluginCatalogFailed,
  setPluginCatalogReady,
} from "./pluginHostStore";
import { pluginAssetFactoryKeysForCatalog } from "./pluginNavigation";
import {
  removePluginUiRegistrationsForAssetKeys,
  removePluginUiRegistrationsForScope,
} from "./pluginUiRuntime";

const CATALOG_REFRESH_DEBOUNCE_MS = 100;
const CATALOG_REFRESH_EVENT_TYPES = new Set([PLUGIN_CATALOG_INVALIDATED_EVENT_TYPE]);

function shouldRefreshCatalogForEvent(event: PluginSubscriptionEvent): boolean {
  return CATALOG_REFRESH_EVENT_TYPES.has(event.type);
}

async function refreshCatalog(input: {
  readonly client: WsRpcClient;
  readonly hostScope: string;
  readonly generation: number;
  readonly requestId: number;
  readonly isCurrentRequest: (requestId: number) => boolean;
}) {
  const { client, hostScope, generation, requestId, isCurrentRequest } = input;
  const result = await client.plugins.list();
  const current = readPluginHostState();
  if (
    !isCurrentRequest(requestId) ||
    current.hostScope !== hostScope ||
    current.client !== client ||
    current.generation !== generation
  ) {
    return;
  }
  setPluginCatalogReady({
    client,
    hostScope,
    generation,
    catalog: result.plugins,
  });
  const activeAssetKeys = pluginAssetFactoryKeysForCatalog({
    hostScope,
    generation,
    catalog: result.plugins,
  });
  const staleAssetKeys = [...current.assets.keys()].filter(
    (assetKey) => !activeAssetKeys.has(assetKey),
  );
  removePluginScriptsForAssetKeys(staleAssetKeys);
  removePluginUiRegistrationsForAssetKeys(staleAssetKeys);
  loadActivePluginScripts(hostScope, generation, result.plugins);
}

function refreshCatalogWithToast(input: {
  readonly client: WsRpcClient;
  readonly hostScope: string;
  readonly generation: number;
  readonly requestId: number;
  readonly isCurrentRequest: (requestId: number) => boolean;
}) {
  const { client, hostScope, generation, requestId, isCurrentRequest } = input;
  void refreshCatalog(input).catch((error) => {
    const current = readPluginHostState();
    if (
      !isCurrentRequest(requestId) ||
      current.hostScope !== hostScope ||
      current.client !== client ||
      current.generation !== generation
    ) {
      return;
    }
    setPluginCatalogFailed({ client, hostScope, generation });
    toastManager.add({
      type: "error",
      title: "Could not load plugins",
      description: error instanceof Error ? error.message : "Plugin catalog request failed.",
    });
  });
}

function resetHostScope(hostScope: string, client: WsRpcClient): number {
  removePluginScriptsForScope(hostScope);
  removePluginUiRegistrationsForScope(hostScope);
  return resetPluginHostState(hostScope, client);
}

function clearHostScope(hostScope: string, client: WsRpcClient) {
  removePluginScriptsForScope(hostScope);
  removePluginUiRegistrationsForScope(hostScope);
  clearPluginHostState(hostScope, client);
}

export function startPluginHost(client: WsRpcClient, hostScope: string) {
  installGlobalPluginHost();
  let generation = resetHostScope(hostScope, client);
  let refreshTimer: number | null = null;
  let refreshRequestSequence = 0;
  const isCurrentRequest = (requestId: number) => requestId === refreshRequestSequence;
  const refreshCurrentCatalog = () => {
    refreshRequestSequence += 1;
    refreshCatalogWithToast({
      client,
      hostScope,
      generation,
      requestId: refreshRequestSequence,
      isCurrentRequest,
    });
  };
  refreshCurrentCatalog();
  const scheduleRefresh = () => {
    if (refreshTimer !== null) {
      window.clearTimeout(refreshTimer);
    }
    refreshTimer = window.setTimeout(() => {
      refreshTimer = null;
      refreshCurrentCatalog();
    }, CATALOG_REFRESH_DEBOUNCE_MS);
  };

  const unsubscribe = client.plugins.subscribe(
    {},
    (event) => {
      if (shouldRefreshCatalogForEvent(event)) {
        scheduleRefresh();
      }
    },
    {
      onResubscribe: () => {
        generation = resetHostScope(hostScope, client);
        refreshCurrentCatalog();
      },
    },
  );

  return () => {
    if (refreshTimer !== null) {
      window.clearTimeout(refreshTimer);
    }
    refreshRequestSequence += 1;
    unsubscribe();
    clearHostScope(hostScope, client);
  };
}
