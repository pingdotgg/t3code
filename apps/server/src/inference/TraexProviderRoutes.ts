import {
  isStockTraexBridge,
  isInferenceRoutingEnabled,
  isManagedDriverAllowed,
  isManagedSettingPath,
  type ManagedPolicySummary,
  ProviderDriverKind,
  TRAEX_BRIDGE_INSTANCE_ID,
  resolveProviderInstanceEnabled,
  TRAEX_BRIDGE_CODEX_LAUNCH_ARGS,
  type ProviderInstanceConfig,
  type ProviderInstanceConfigMap,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Layer from "effect/Layer";

import { TRAEX_CONSUMER_PATH } from "./traex.ts";

const id = TRAEX_BRIDGE_INSTANCE_ID;
const driver = ProviderDriverKind.make("codex");
const envKey = "T3_TRAEX_ROUTE_KEY";
const launchArgsEnv = "T3CODE_CODEX_LAUNCH_ARGS";

export class TraexProviderRoutes extends Context.Service<
  TraexProviderRoutes,
  {
    readonly bind: (port: number, key: string, discovered: boolean) => void;
    readonly setDiscovered: (available: boolean) => boolean;
    readonly apply: (
      instances: ProviderInstanceConfigMap,
      policy?: ManagedPolicySummary,
    ) => ProviderInstanceConfigMap;
  }
>()("t3/inference/TraexProviderRoutes") {}

export const layer = Layer.sync(TraexProviderRoutes, () => {
  let route: { launchArgs: string; key: string } | undefined;
  let discovered = false;
  return {
    bind(port, key, hasBridge) {
      const baseUrl = `http://127.0.0.1:${port}${TRAEX_CONSUMER_PATH}/v1`;
      const provider = `model_providers.traex={name="traex-bridge",base_url="${baseUrl}",env_key="${envKey}",wire_api="responses",supports_websockets=false,requires_openai_auth=false}`;
      route = { launchArgs: `-c 'model_provider="traex"' -c '${provider}'`, key };
      discovered = hasBridge;
    },
    setDiscovered(available) {
      if (discovered === available) return false;
      discovered = available;
      return true;
    },
    apply(instances, policy) {
      if (!route || !isManagedDriverAllowed(policy, driver)) return instances;
      const locked = policy?.limits?.providers?.lockedInstanceFields?.[driver] ?? [];
      if (
        locked.some((field) =>
          [
            "config.launchArgs",
            "environment",
            `environment.${envKey}`,
            `environment.${launchArgsEnv}`,
          ].includes(field),
        )
      )
        return instances;
      const entries = Object.entries(instances).filter(
        ([, entry]) => entry.driver === "codex" && isStockTraexBridge(entry.config),
      );
      if (
        !entries.length &&
        discovered &&
        !instances[id] &&
        !locked.length &&
        !isManagedSettingPath(policy, `providerInstances.${id}`)
      ) {
        entries.push([
          id,
          {
            driver,
            displayName: "Traex",
            config: {
              launchArgs: TRAEX_BRIDGE_CODEX_LAUNCH_ARGS,
              homePath: `~/.codex-t3/traex/${id}`,
            },
          },
        ]);
      }
      if (!entries.length) return instances;
      const next: Record<string, ProviderInstanceConfig> = { ...instances };
      for (const [instanceId, entry] of entries) {
        const config = entry.config as Record<string, unknown>;
        const override = entry.environment?.find(
          (variable) => variable.name.toUpperCase() === launchArgsEnv,
        )?.value;
        if (
          (config.setupMode !== undefined && config.setupMode !== "existing") ||
          isInferenceRoutingEnabled(config) ||
          (override &&
            (typeof override !== "string" ||
              (override.trim() && override.trim() !== TRAEX_BRIDGE_CODEX_LAUNCH_ARGS))) ||
          entry.environment?.some((variable) => variable.name.toUpperCase() === envKey) ||
          !resolveProviderInstanceEnabled(entry) ||
          isManagedSettingPath(policy, `providerInstances.${instanceId}.config.launchArgs`) ||
          isManagedSettingPath(policy, `providerInstances.${instanceId}.environment`)
        )
          continue;
        next[instanceId] = {
          ...entry,
          config: { ...config, launchArgs: route.launchArgs },
          environment: [
            ...(entry.environment ?? []).filter(
              (variable) => variable.name.toUpperCase() !== launchArgsEnv,
            ),
            { name: envKey, value: route.key, sensitive: true },
            { name: launchArgsEnv, value: route.launchArgs, sensitive: false },
          ],
        };
      }
      return next as ProviderInstanceConfigMap;
    },
  };
});
