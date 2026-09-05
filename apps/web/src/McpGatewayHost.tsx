import {
  connectGatewayBridge,
  createGatewayRuntimePortFromContext,
} from "@t3tools/client-runtime/gateway";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/unstable/reactivity";
import { useEffect, useState } from "react";

import { connectionAtomRuntime } from "./connection/runtime";
import {
  getMcpGatewayGrants,
  getMcpGatewayProfiles,
  getMcpGatewayToken,
  isMcpGatewayEnabled,
  publishMcpGatewayStatus,
  subscribeMcpGatewayConfiguration,
} from "./mcpGatewayState";
import { appAtomRegistry } from "./rpc/atomRegistry";

const BRIDGE_URL = "ws://127.0.0.1:47631";

export function McpGatewayHost() {
  const [configuration, setConfiguration] = useState(() => ({
    available: (window.desktopBridge?.getMcpGatewayLaunchConfig() ?? null) !== null,
    enabled: isMcpGatewayEnabled(),
    grants: getMcpGatewayGrants(),
    profiles: getMcpGatewayProfiles(),
    token: getMcpGatewayToken(),
  }));

  useEffect(() => {
    const onChange = () =>
      setConfiguration({
        available: (window.desktopBridge?.getMcpGatewayLaunchConfig() ?? null) !== null,
        enabled: isMcpGatewayEnabled(),
        grants: getMcpGatewayGrants(),
        profiles: getMcpGatewayProfiles(),
        token: getMcpGatewayToken(),
      });
    return subscribeMcpGatewayConfiguration(onChange);
  }, []);

  useEffect(() => {
    if (!configuration.available || !configuration.enabled || configuration.token.length < 16) {
      publishMcpGatewayStatus(configuration.enabled ? "degraded" : "disabled");
      return;
    }

    const unmountRuntime = appAtomRegistry.mount(connectionAtomRuntime);
    let bridge: ReturnType<typeof connectGatewayBridge> | null = null;
    let unsubscribe: (() => void) | null = null;
    let stopped = false;
    const startWhenReady = () => {
      if (stopped || bridge !== null) return;
      const value = AsyncResult.value(appAtomRegistry.get(connectionAtomRuntime));
      if (Option.isNone(value)) return;
      bridge = connectGatewayBridge({
        port: createGatewayRuntimePortFromContext(value.value),
        grants: configuration.grants,
        profiles: configuration.profiles,
        token: configuration.token,
        url: BRIDGE_URL,
        onState: publishMcpGatewayStatus,
      });
      unsubscribe?.();
      unsubscribe = null;
    };
    startWhenReady();
    if (bridge === null)
      unsubscribe = appAtomRegistry.subscribe(connectionAtomRuntime, startWhenReady);

    return () => {
      stopped = true;
      unsubscribe?.();
      bridge?.stop();
      unmountRuntime();
    };
  }, [configuration]);

  return null;
}
