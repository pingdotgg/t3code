import { useAtomValue } from "@effect/atom-react";
import {
  RelayConnectionRegistration,
  RelayConnectionTarget,
} from "@t3tools/client-runtime/connection";
import type { EnvironmentId } from "@t3tools/contracts";
import type {
  RelayClientEnvironmentRecord,
  RelayEnvironmentStatusResponse,
} from "@t3tools/contracts/relay";
import * as Option from "effect/Option";
import { useCallback, useMemo } from "react";

import { environmentCatalog } from "../../connection/catalog";
import {
  connectPairingUrl as connectPairingUrlAtom,
  updateBearerConnection,
} from "../../connection/onboarding";
import { useEnvironments } from "../../state/environments";
import { relayEnvironmentDiscovery } from "../../state/relay";
import { useAtomCommand } from "../../state/use-atom-command";
import { projectWorkspaceEnvironment, type WorkspaceEnvironment } from "../../state/workspaceModel";

export interface RelayEnvironmentView {
  readonly environment: RelayClientEnvironmentRecord;
  readonly availability: "checking" | "online" | "offline" | "error";
  readonly status: RelayEnvironmentStatusResponse | null;
  readonly error: string | null;
  readonly traceId: string | null;
}

export function useConnectionController() {
  const { environments } = useEnvironments();
  const discovery = useAtomValue(relayEnvironmentDiscovery.stateValueAtom);
  const connectPairingUrlMutation = useAtomCommand(connectPairingUrlAtom, {
    reportFailure: false,
  });
  const updateBearer = useAtomCommand(updateBearerConnection, { reportFailure: false });
  const registerEnvironment = useAtomCommand(environmentCatalog.register, "environment register");
  const removeEnvironmentMutation = useAtomCommand(environmentCatalog.remove, "environment remove");
  const retryEnvironmentMutation = useAtomCommand(environmentCatalog.retryNow, "environment retry");
  const refreshRelayEnvironments = useAtomCommand(
    relayEnvironmentDiscovery.refresh,
    "relay environment refresh",
  );

  const connectedEnvironments = useMemo<ReadonlyArray<WorkspaceEnvironment>>(
    () => environments.map(projectWorkspaceEnvironment),
    [environments],
  );
  const registeredIds = useMemo(
    () => new Set(connectedEnvironments.map((environment) => environment.environmentId)),
    [connectedEnvironments],
  );
  const relayEnvironments = useMemo<ReadonlyArray<RelayEnvironmentView>>(
    () =>
      [...discovery.environments.values()].map((entry) => ({
        environment: entry.environment,
        availability: entry.availability,
        status: Option.getOrNull(entry.status),
        error: Option.getOrNull(entry.error)?.message ?? null,
        traceId: Option.getOrNull(entry.error)?.traceId ?? null,
      })),
    [discovery.environments],
  );
  const availableRelayEnvironments = useMemo(
    () => relayEnvironments.filter((entry) => !registeredIds.has(entry.environment.environmentId)),
    [registeredIds, relayEnvironments],
  );

  const connectPairingUrl = useCallback(
    (pairingUrl: string) => connectPairingUrlMutation(pairingUrl),
    [connectPairingUrlMutation],
  );
  const connectRelayEnvironment = useCallback(
    (environment: RelayClientEnvironmentRecord) =>
      registerEnvironment(
        new RelayConnectionRegistration({
          target: new RelayConnectionTarget({
            environmentId: environment.environmentId,
            label: environment.label,
          }),
        }),
      ),
    [registerEnvironment],
  );
  const removeEnvironment = useCallback(
    (environmentId: EnvironmentId) => removeEnvironmentMutation(environmentId),
    [removeEnvironmentMutation],
  );
  const retryEnvironment = useCallback(
    (environmentId: EnvironmentId) => retryEnvironmentMutation(environmentId),
    [retryEnvironmentMutation],
  );
  const updateEnvironment = useCallback(
    (
      environmentId: EnvironmentId,
      updates: { readonly label: string; readonly displayUrl: string },
    ) =>
      updateBearer({
        environmentId,
        label: updates.label,
        httpBaseUrl: updates.displayUrl,
      }),
    [updateBearer],
  );

  return {
    connectedEnvironments,
    relayEnvironments,
    availableRelayEnvironments,
    relayDiscovery: {
      isRefreshing: discovery.refreshing,
      isOffline: discovery.offline,
      error: Option.getOrNull(discovery.error)?.message ?? null,
      errorTraceId: Option.getOrNull(discovery.error)?.traceId ?? null,
    },
    connectPairingUrl,
    connectRelayEnvironment,
    removeEnvironment,
    retryEnvironment,
    updateEnvironment,
    refreshRelayEnvironments,
  };
}
