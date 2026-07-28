import {
  HermesSettings,
  type HermesGatewayCompatibility,
  type ServerSettings,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { deriveProviderInstanceConfigMap } from "../provider/Layers/ProviderInstanceRegistryHydration.ts";
import {
  HERMES_REMOTE_PAIRING_TOKEN_ENV,
  HERMES_REMOTE_TLS_CERT_SHA256_ENV,
  assessHermesConnectionSecurity,
} from "./HermesConnectionSecurity.ts";
import { resolveHermesServeEndpoint } from "./HermesServeRuntime.ts";

export interface HermesProviderConnection {
  readonly providerInstanceId: string;
  readonly displayName: string;
  readonly profileKey: string;
  readonly endpoint: string;
  readonly token: string;
}

export interface UnavailableHermesProvider {
  readonly providerInstanceId: string;
  readonly displayName: string;
  readonly profileKey: string;
  readonly diagnostic: string;
}

export interface HermesProviderDirectory {
  readonly ready: ReadonlyArray<HermesProviderConnection>;
  readonly unavailable: ReadonlyArray<UnavailableHermesProvider>;
}

const decodeHermesSettings = Schema.decodeUnknownSync(HermesSettings);

type SensitiveEnvironment = ReadonlyArray<{
  readonly name: string;
  readonly value: string;
  readonly sensitive: boolean;
}>;

const sensitiveEnvironmentValue = (environment: SensitiveEnvironment, name: string) =>
  environment.find(
    (variable) => variable.name === name && variable.sensitive && variable.value.trim().length > 0,
  )?.value;

const gatewayTokenFromEnvironment = (environment: SensitiveEnvironment) =>
  sensitiveEnvironmentValue(environment, "HERMES_GATEWAY_TOKEN");

export function resolveHermesProviderConnections(
  settings: ServerSettings,
): HermesProviderDirectory {
  const instances = deriveProviderInstanceConfigMap(settings);
  const ready: HermesProviderConnection[] = [];
  const unavailable: UnavailableHermesProvider[] = [];
  for (const [providerInstanceId, instance] of Object.entries(instances)) {
    if (instance.driver !== "hermes") continue;
    let config: HermesSettings;
    try {
      config = decodeHermesSettings(instance.config ?? {});
    } catch {
      unavailable.push({
        providerInstanceId,
        displayName: instance.displayName ?? providerInstanceId,
        profileKey: "unknown",
        diagnostic: "Hermes provider settings are invalid.",
      });
      continue;
    }
    const displayName = instance.displayName ?? providerInstanceId;
    const environment = instance.environment ?? [];
    const token = gatewayTokenFromEnvironment(environment);
    if (instance.enabled !== true || !settings.enableHermes) {
      unavailable.push({
        providerInstanceId,
        displayName,
        profileKey: config.profileKey,
        diagnostic: "Hermes is disabled.",
      });
    } else if (!token) {
      unavailable.push({
        providerInstanceId,
        displayName,
        profileKey: config.profileKey,
        diagnostic: "Hermes gateway endpoint or sensitive token is not configured.",
      });
    } else {
      const security = assessHermesConnectionSecurity({
        endpoint: resolveHermesServeEndpoint(config.endpoint),
        gatewayToken: token,
        remoteGloballyEnabled: settings.enableRemoteHermes,
        remoteInstanceEnabled: config.remoteAccessEnabled,
        remotePairingToken: sensitiveEnvironmentValue(environment, HERMES_REMOTE_PAIRING_TOKEN_ENV),
        remoteTlsCertificateSha256: sensitiveEnvironmentValue(
          environment,
          HERMES_REMOTE_TLS_CERT_SHA256_ENV,
        ),
      });
      if (security.status === "ready") {
        ready.push({
          providerInstanceId,
          displayName,
          profileKey: config.profileKey,
          endpoint: security.endpoint,
          token: security.authToken,
        });
      } else {
        unavailable.push({
          providerInstanceId,
          displayName,
          profileKey: config.profileKey,
          diagnostic: security.message,
        });
      }
    }
  }
  return { ready, unavailable };
}

export function hermesManageActionInventory(
  compatibility: HermesGatewayCompatibility,
  capability: string,
): ReadonlySet<string> {
  const actions = new Set<string>();
  const inventory = compatibility.inventory;
  const manage =
    inventory !== null && typeof inventory === "object" && !Array.isArray(inventory)
      ? (inventory as Readonly<Record<string, unknown>>)[capability]
      : undefined;
  const manageRecord =
    manage !== null && typeof manage === "object" && !Array.isArray(manage)
      ? (manage as Readonly<Record<string, unknown>>)
      : undefined;
  for (const candidate of [manageRecord?.actions, manageRecord?.operations]) {
    if (!Array.isArray(candidate)) continue;
    for (const action of candidate) {
      if (typeof action === "string") actions.add(action.toLowerCase());
    }
  }
  return actions;
}
