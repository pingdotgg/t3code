import type { ConnectionCatalogEntry } from "@t3tools/client-runtime/connection";

import {
  useEnvironmentProviders,
  useEnvironments,
  usePrimaryEnvironmentId,
} from "~/state/environments";
import { isDesktopLocalConnectionTarget } from "~/connection/desktopLocal";
import {
  buildLocalEnvironmentUpdateGroups,
  deriveEnvironmentDisplayLabel,
  type EnvironmentUpdateConnectionState,
  type LocalEnvironmentProvidersInput,
  type LocalEnvironmentUpdateGroup,
} from "./ProviderUpdateLaunchNotification.logic";

function isLocalConnectionTarget(target: ConnectionCatalogEntry["target"]): boolean {
  return target._tag === "PrimaryConnectionTarget" || isDesktopLocalConnectionTarget(target);
}

function normalizeConnectionState(phase: string | undefined): EnvironmentUpdateConnectionState {
  switch (phase) {
    case "connected":
      return "ready";
    case "connecting":
    case "reconnecting":
      return "connecting";
    case "unsupported":
    case "error":
      return "error";
    case "offline":
      return "disconnected";
    default:
      return "connecting";
  }
}

export function useLocalEnvironmentUpdateGroups(): {
  readonly groups: LocalEnvironmentUpdateGroup[];
  readonly isAnySettling: boolean;
} {
  const { environments } = useEnvironments();
  const providersByEnvironment = useEnvironmentProviders();
  const primaryEnvironmentId = usePrimaryEnvironmentId();

  const inputs: LocalEnvironmentProvidersInput[] = [];

  for (const environment of environments) {
    if (!isLocalConnectionTarget(environment.entry.target)) {
      continue;
    }

    const isPrimary = environment.environmentId === primaryEnvironmentId;
    const serverConfig = environment.serverConfig;

    inputs.push({
      environmentId: environment.environmentId,
      label: isPrimary
        ? deriveEnvironmentDisplayLabel({
            isWsl: false,
            wslDistro: null,
            platformOs: serverConfig?.environment.platform.os,
            fallbackLabel: environment.label,
          })
        : environment.label,
      isPrimary,
      connectionState: normalizeConnectionState(environment.connection.phase),
      providers: providersByEnvironment.get(environment.environmentId) ?? [],
    });
  }

  inputs.sort((left, right) => Number(right.isPrimary) - Number(left.isPrimary));

  return buildLocalEnvironmentUpdateGroups(inputs);
}
