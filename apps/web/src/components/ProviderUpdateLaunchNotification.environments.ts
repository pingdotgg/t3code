import type { ConnectionCatalogEntry } from "@t3tools/client-runtime/connection";
import type { ServerConfig } from "@t3tools/contracts";
import { useMemo } from "react";

import { useEnvironments, usePrimaryEnvironmentId } from "~/state/environments";
import { isDesktopLocalConnectionTarget } from "~/connection/desktopLocal";
import {
  buildLocalEnvironmentUpdateGroups,
  deriveEnvironmentDisplayLabel,
  type EnvironmentUpdateConnectionState,
  type LocalEnvironmentProvidersInput,
  type LocalEnvironmentUpdateGroup,
} from "./ProviderUpdateLaunchNotification.logic";

/**
 * A local environment is either the same-origin primary backend or a
 * desktop-local secondary (the parallel WSL backend), which connects over
 * loopback with a bearer token and carries a `local:<backendInstanceId>`
 * connection id. SSH, relay, and other remote targets are excluded.
 */
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
    case "error":
      return "error";
    case "offline":
      return "disconnected";
    default:
      // "available" (or anything not yet observed) — the backend has not
      // confirmed it is serving yet, so treat it as still settling so the
      // popover waits for it.
      return "connecting";
  }
}

/**
 * Reactively enumerate the enabled local environments (the primary plus any
 * desktop-local secondary such as WSL) with each one's full provider list and a
 * flag for whether any is still connecting. Drives the launch popover's gating
 * and its per-environment update triggers.
 */
export function useLocalEnvironmentUpdateGroups(): {
  readonly groups: LocalEnvironmentUpdateGroup[];
  readonly isAnySettling: boolean;
} {
  const { environments } = useEnvironments();
  const primaryEnvironmentId = usePrimaryEnvironmentId();

  return useMemo(() => {
    const inputs: LocalEnvironmentProvidersInput[] = [];

    for (const environment of environments) {
      if (!isLocalConnectionTarget(environment.entry.target)) {
        continue;
      }

      const isPrimary = environment.environmentId === primaryEnvironmentId;
      const serverConfig: ServerConfig | null = environment.serverConfig;

      inputs.push({
        environmentId: environment.environmentId,
        // Secondaries carry a meaningful label straight from the platform source
        // (e.g. "WSL (Ubuntu)"). The primary's catalog label can be the account
        // name, so fall back to its platform OS so the row reads "Windows"/"Linux".
        label: isPrimary
          ? deriveEnvironmentDisplayLabel({
              isWsl: false,
              wslDistro: null,
              platformOs: serverConfig?.environment.platform.os,
              fallbackLabel: environment.label,
            })
          : environment.label,
        isPrimary,
        // The primary is the backend serving this renderer, so it is ready
        // whenever its providers are available; secondaries report their live
        // connection phase.
        connectionState: isPrimary
          ? "ready"
          : normalizeConnectionState(environment.connection.phase),
        providers: serverConfig?.providers ?? [],
      });
    }

    // Primary first, then the rest in catalog order.
    inputs.sort((left, right) => Number(right.isPrimary) - Number(left.isPrimary));

    return buildLocalEnvironmentUpdateGroups(inputs);
  }, [environments, primaryEnvironmentId]);
}
