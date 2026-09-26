import { useAtomValue } from "@effect/atom-react";
import type {
  ConnectionCatalogEntry,
  EnvironmentConnectionPhase,
} from "@t3tools/client-runtime/connection";
import type { EnvironmentId, ServerConfig } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import { useMemo } from "react";

import { useEnvironments, usePrimaryEnvironmentId } from "~/state/environments";
import { environmentSession } from "~/state/session";
import { isDesktopLocalConnectionTarget } from "~/connection/desktopLocal";
import {
  buildEnvironmentUpdateGroups,
  deriveEnvironmentDisplayLabel,
  type EnvironmentProvidersInput,
  type EnvironmentUpdateConnectionState,
  type EnvironmentUpdateGroup,
} from "./ProviderUpdateLaunchNotification.logic";
import {
  type ProviderOperateAccess,
  resolveRemoteOperateAccess,
} from "./settings/ProviderSettingsPanel.logic";

/**
 * Keep the primary and desktop-local backends in the set while they start so
 * the existing settling grace still covers WSL. Remote environments join only
 * after they are connected, have loaded a live config, and this client's
 * session there may run updates: a read-only pairing would otherwise show an
 * Update button whose every request the server rejects. This also prevents an
 * offline remote's cached state from advertising an update it cannot run.
 */
export function shouldIncludeProviderUpdateEnvironment(input: {
  readonly target: ConnectionCatalogEntry["target"];
  readonly connectionPhase: EnvironmentConnectionPhase;
  readonly hasServerConfig: boolean;
  readonly operateAccess: ProviderOperateAccess;
}): boolean {
  return (
    input.target._tag === "PrimaryConnectionTarget" ||
    isDesktopLocalConnectionTarget(input.target) ||
    (input.connectionPhase === "connected" &&
      input.hasServerConfig &&
      input.operateAccess === "granted")
  );
}

function normalizeConnectionState(
  phase: EnvironmentConnectionPhase,
): EnvironmentUpdateConnectionState {
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
      // "available" (or anything not yet observed) — the backend has not
      // confirmed it is serving yet, so treat it as still settling so the
      // popover waits for it.
      return "connecting";
  }
}

/**
 * Operate access for each remote environment, from the scopes its
 * `/api/auth/session` reports for this client. Primary and desktop-local
 * backends are not looked up; they are always included.
 */
function useRemoteOperateAccess(
  remoteEnvironmentIds: ReadonlyArray<EnvironmentId>,
): ReadonlyMap<EnvironmentId, ProviderOperateAccess> {
  const key = remoteEnvironmentIds.join("\u0000");
  const accessAtom = useMemo(
    () =>
      Atom.make((get) => {
        const access = new Map<EnvironmentId, ProviderOperateAccess>();
        for (const environmentId of key === "" ? [] : (key.split("\u0000") as EnvironmentId[])) {
          const result = get(environmentSession.sessionStateAtom(environmentId));
          access.set(
            environmentId,
            resolveRemoteOperateAccess({
              session: Option.getOrNull(AsyncResult.value(result)),
              isPending: result.waiting,
              hasError: result._tag === "Failure",
            }),
          );
        }
        return access;
      }),
    [key],
  );
  return useAtomValue(accessAtom);
}

/**
 * Reactively enumerate the primary, desktop-local backends, and connected
 * remote environments with each one's provider list. Drives the launch
 * popover's gating and its per-environment update triggers.
 */
export function useEnvironmentUpdateGroups(): {
  readonly groups: EnvironmentUpdateGroup[];
  readonly isAnySettling: boolean;
} {
  const { environments } = useEnvironments();
  const primaryEnvironmentId = usePrimaryEnvironmentId();

  const remoteEnvironmentIds = useMemo(
    () =>
      environments
        .filter(
          (environment) =>
            environment.entry.target._tag !== "PrimaryConnectionTarget" &&
            !isDesktopLocalConnectionTarget(environment.entry.target),
        )
        .map((environment) => environment.environmentId),
    [environments],
  );
  const remoteOperateAccess = useRemoteOperateAccess(remoteEnvironmentIds);

  return useMemo(() => {
    const inputs: EnvironmentProvidersInput[] = [];

    for (const environment of environments) {
      if (
        !shouldIncludeProviderUpdateEnvironment({
          target: environment.entry.target,
          connectionPhase: environment.connection.phase,
          hasServerConfig: environment.serverConfig !== null,
          operateAccess: remoteOperateAccess.get(environment.environmentId) ?? "granted",
        })
      ) {
        continue;
      }

      const isPrimary = environment.environmentId === primaryEnvironmentId;
      const serverConfig: ServerConfig | null = environment.serverConfig;

      inputs.push({
        environmentId: environment.environmentId,
        // Secondaries carry a meaningful label straight from the connection
        // catalog. The primary's label can be the account name, so fall back to
        // its platform OS and keep the rows distinguishable.
        label: isPrimary
          ? deriveEnvironmentDisplayLabel({
              isWsl: false,
              wslDistro: null,
              platformOs: serverConfig?.environment.platform.os,
              fallbackLabel: environment.label,
            })
          : environment.label,
        isPrimary,
        // The primary serves this renderer, so it is ready whenever its
        // providers are available. Secondaries report their live phase.
        connectionState: isPrimary
          ? "ready"
          : normalizeConnectionState(environment.connection.phase),
        providers: serverConfig?.providers ?? [],
      });
    }

    // Primary first, then the rest in catalog order.
    inputs.sort((left, right) => Number(right.isPrimary) - Number(left.isPrimary));

    return buildEnvironmentUpdateGroups(inputs);
  }, [environments, primaryEnvironmentId, remoteOperateAccess]);
}
