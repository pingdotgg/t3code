import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import { useCallback, useMemo } from "react";
import { Alert } from "react-native";

import { useConnectionController } from "../features/connection/useConnectionController";
import { environmentPresentations } from "./presentation";
import { useWorkspaceState } from "../state/workspace";
import type { SavedRemoteConnection } from "../lib/connection";
import { appAtomRegistry } from "./atom-registry";
import type { ConnectedEnvironmentSummary, EnvironmentRuntimeState } from "./remote-runtime-types";
import { environmentSession } from "./session";
import { environmentCatalog } from "../connection/catalog";
import { createRemoteEnvironmentProjectionAtoms } from "./remote-environment-projections";
import { serverEnvironment } from "./server";

const connectionPairingUrlAtom = Atom.make("").pipe(
  Atom.keepAlive,
  Atom.withLabel("mobile:connection-pairing-url"),
);

const pendingConnectionErrorAtom = Atom.make<string | null>(null).pipe(
  Atom.keepAlive,
  Atom.withLabel("mobile:pending-connection-error"),
);

export function setPendingConnectionError(message: string | null): void {
  appAtomRegistry.set(pendingConnectionErrorAtom, message);
}

const remoteEnvironmentProjections = createRemoteEnvironmentProjectionAtoms({
  presentationAtom: environmentPresentations.presentationAtom,
  preparedConnectionAtom: environmentSession.preparedConnectionValueAtom,
  serverConfigAtom: serverEnvironment.configValueAtom,
});

const EMPTY_SAVED_CONNECTION_ATOM = Atom.make<SavedRemoteConnection | null>(null).pipe(
  Atom.withLabel("mobile:saved-connection:empty"),
);

const EMPTY_RUNTIME_STATE_ATOM = Atom.make<EnvironmentRuntimeState | null>(null).pipe(
  Atom.withLabel("mobile:environment-runtime-state:empty"),
);

const savedConnectionsByIdAtom = Atom.make((get) => {
  const presentationById = get(environmentPresentations.presentationsAtom);
  return Object.fromEntries(
    [...presentationById.keys()].flatMap((environmentId) => {
      const connection = get(remoteEnvironmentProjections.savedConnectionAtom(environmentId));
      return connection === null ? [] : [[environmentId, connection]];
    }),
  ) as Record<EnvironmentId, SavedRemoteConnection>;
}).pipe(Atom.withLabel("mobile:saved-connections-by-id"));

export function useSavedRemoteConnections() {
  const catalog = useAtomValue(environmentCatalog.catalogValueAtom);
  const savedConnectionsById = useAtomValue(savedConnectionsByIdAtom);

  return {
    isLoadingSavedConnection: !catalog.isReady,
    savedConnectionsById,
  };
}

export function useSavedRemoteConnection(
  environmentId: EnvironmentId | null,
): SavedRemoteConnection | null {
  return useAtomValue(
    environmentId === null
      ? EMPTY_SAVED_CONNECTION_ATOM
      : remoteEnvironmentProjections.savedConnectionAtom(environmentId),
  );
}

export function useRemoteEnvironmentRuntime(
  environmentId: EnvironmentId | null,
): EnvironmentRuntimeState | null {
  return useAtomValue(
    environmentId === null
      ? EMPTY_RUNTIME_STATE_ATOM
      : remoteEnvironmentProjections.runtimeStateAtom(environmentId),
  );
}

export function useRemoteConnectionStatus() {
  const workspace = useWorkspaceState();
  const pendingConnectionError = useAtomValue(pendingConnectionErrorAtom);
  const connectedEnvironments = useMemo<ReadonlyArray<ConnectedEnvironmentSummary>>(
    () =>
      workspace.environments.map((environment) => ({
        environmentId: environment.environmentId,
        environmentLabel: environment.environmentLabel,
        displayUrl: environment.displayUrl,
        isRelayManaged: environment.isRelayManaged,
        connectionState: environment.connectionState,
        connectionError: environment.connectionError,
        connectionErrorTraceId: environment.connectionErrorTraceId,
      })),
    [workspace.environments],
  );

  return {
    connectedEnvironments,
    connectionState: workspace.state.connectionState,
    connectionError: pendingConnectionError ?? workspace.state.connectionError,
  };
}

export function useRemoteConnections() {
  const controller = useConnectionController();
  const connectionPairingUrl = useAtomValue(connectionPairingUrlAtom);
  const pendingConnectionError = useAtomValue(pendingConnectionErrorAtom);
  const { connectedEnvironments, connectionError, connectionState } = useRemoteConnectionStatus();

  const onChangeConnectionPairingUrl = useCallback((pairingUrl: string) => {
    appAtomRegistry.set(connectionPairingUrlAtom, pairingUrl);
  }, []);

  const onConnectPress = useCallback(
    async (pairingUrl?: string) => {
      const nextPairingUrl = pairingUrl ?? connectionPairingUrl;
      setPendingConnectionError(null);
      const result = await controller.connectPairingUrl(nextPairingUrl);
      if (AsyncResult.isFailure(result)) {
        const error = Cause.squash(result.cause);
        const message =
          error instanceof Error ? error.message : "Failed to pair with the environment.";
        setPendingConnectionError(message);
      } else {
        appAtomRegistry.set(connectionPairingUrlAtom, "");
      }
      return result;
    },
    [connectionPairingUrl, controller],
  );

  const onReconnectEnvironment = useCallback(
    (environmentId: EnvironmentId) => controller.retryEnvironment(environmentId),
    [controller],
  );
  const onUpdateEnvironment = useCallback(
    (
      environmentId: EnvironmentId,
      updates: { readonly label: string; readonly displayUrl: string },
    ) => controller.updateEnvironment(environmentId, updates),
    [controller],
  );

  const onRemoveEnvironmentPress = useCallback(
    (environmentId: EnvironmentId) => {
      const environment = connectedEnvironments.find(
        (candidate) => candidate.environmentId === environmentId,
      );
      if (!environment) {
        return;
      }
      Alert.alert(
        "Remove environment?",
        `Disconnect and forget ${environment.environmentLabel} on this device.`,
        [
          { text: "Cancel", style: "cancel" },
          {
            text: "Remove",
            style: "destructive",
            onPress: () => {
              void controller.removeEnvironment(environmentId);
            },
          },
        ],
      );
    },
    [connectedEnvironments, controller],
  );

  return {
    connectionPairingUrl,
    connectionState,
    connectionError,
    pairingConnectionError: pendingConnectionError,
    connectedEnvironments,
    connectedEnvironmentCount: connectedEnvironments.length,
    onChangeConnectionPairingUrl,
    onConnectPress,
    onReconnectEnvironment,
    onUpdateEnvironment,
    onRemoveEnvironmentPress,
  };
}
