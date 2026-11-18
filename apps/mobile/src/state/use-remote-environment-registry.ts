import * as Dialog from "../components/ui/Dialog";
import { errorDisplayMessage } from "@t3tools/client-runtime/errors";
import { useAtomValue } from "@effect/atom-react";
import { useNavigation } from "@react-navigation/native";
import { Discovery } from "@t3tools/client-runtime/relay";
import type { EnvironmentId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { msg } from "gt-react-native";
import { AsyncResult, Atom } from "effect/reactivity";
import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";

import { hasCloudPublicConfig } from "../features/cloud/publicConfig";
import { m } from "../i18n/messages";
import { useConnectionController } from "../features/connection/useConnectionController";
import { useRetryEnvironment } from "../features/connection/useRetryEnvironment";
import { environmentPresentations } from "./presentation";
import { useWorkspaceConnectionState, useWorkspaceEnvironments } from "./workspace";
import type { SavedRemoteConnection } from "../lib/connection";
import { appAtomRegistry } from "./atom-registry";
import type { ConnectedEnvironmentSummary, EnvironmentRuntimeState } from "./remote-runtime-types";
import { environmentSession } from "./session";
import { environmentCatalog } from "../connection/catalog";
import { createRemoteEnvironmentProjectionAtoms } from "./remote-environment-projections";
import { serverEnvironment } from "./server";
import { relayEnvironmentDiscovery } from "./relay";
import { connectPairingUrl as connectPairingUrlCommand } from "../connection/onboarding";

const RELAY_REMOVAL_ACCOUNT_NOTE: Record<Discovery.RelayEnvironmentRegistration, string> = {
  registered: msg(
    "It stays on your {connect} account and keeps its host space. Deregister it under {account} → {connect} to free it.",
    { connect: "T3 Connect", account: "T3 Account" },
  ),
  unregistered: msg("It's no longer on your {connect} account.", { connect: "T3 Connect" }),
  unknown: msg(
    "This doesn't change your {connect} account. To deregister it there, use {account} → {connect}.",
    { connect: "T3 Connect", account: "T3 Account" },
  ),
};

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

export interface PairingOutcome {
  readonly ok: boolean;
  /** Shown beside the pairing form; null when the failure got its own dialog. */
  readonly error: string | null;
}

/** Pairs with the environment behind a pairing link and saves it. */
export async function pairEnvironment(
  pairingUrl: string,
  expectedEnvironmentId?: EnvironmentId,
): Promise<PairingOutcome> {
  const result = await runAtomCommand(
    appAtomRegistry,
    connectPairingUrlCommand,
    { pairingUrl, ...(expectedEnvironmentId === undefined ? {} : { expectedEnvironmentId }) },
    { reportFailure: false },
  );
  if (AsyncResult.isSuccess(result)) {
    appAtomRegistry.set(connectionPairingUrlAtom, "");
    return { ok: true, error: null };
  }
  const error = Cause.squash(result.cause);
  const message = errorDisplayMessage(error, m) ?? m(msg("Failed to pair with the environment."));
  if (
    error !== null &&
    typeof error === "object" &&
    "reason" in error &&
    error.reason === "unsupported"
  ) {
    Dialog.alert(m(msg("Client not supported")), message);
    return { ok: false, error: null };
  }
  return { ok: false, error: message };
}

const remoteEnvironmentProjections = createRemoteEnvironmentProjectionAtoms({
  presentationAtom: environmentPresentations.presentationAtom,
  preparedConnectionAtom: environmentSession.preparedConnectionValueAtom,
  serverConfigAtom: serverEnvironment.configValueAtom,
});

export const environmentConnectedAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make(
    (get) =>
      get(remoteEnvironmentProjections.runtimeStateAtom(environmentId))?.connectionState ===
      "connected",
  ).pipe(Atom.withLabel(`mobile:environment-connected:${environmentId}`)),
);

const EMPTY_SAVED_CONNECTION_ATOM = Atom.make<SavedRemoteConnection | null>(null).pipe(
  Atom.withLabel("mobile:saved-connection:empty"),
);

const EMPTY_RUNTIME_STATE_ATOM = Atom.make<EnvironmentRuntimeState | null>(null).pipe(
  Atom.withLabel("mobile:environment-runtime-state:empty"),
);

export const savedConnectionsByIdAtom = Atom.make((get) => {
  const catalog = get(environmentCatalog.catalogValueAtom);
  return Object.fromEntries(
    [...catalog.entries.keys()].flatMap((environmentId) => {
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
  const state = useWorkspaceConnectionState();
  const connectedEnvironments: ReadonlyArray<ConnectedEnvironmentSummary> =
    useWorkspaceEnvironments();
  const pendingConnectionError = useAtomValue(pendingConnectionErrorAtom);

  return {
    connectedEnvironments,
    connectionState: state.connectionState,
    connectionError: pendingConnectionError ?? state.connectionError,
  };
}

export function useRemoteConnections() {
  const controller = useConnectionController();
  const navigation = useNavigation();
  const connectionPairingUrl = useAtomValue(connectionPairingUrlAtom);
  const { connectedEnvironments, connectionError, connectionState } = useRemoteConnectionStatus();

  const onChangeConnectionPairingUrl = (pairingUrl: string) => {
    appAtomRegistry.set(connectionPairingUrlAtom, pairingUrl);
  };

  const onConnectPress = (pairingUrl?: string, expectedEnvironmentId?: EnvironmentId) =>
    pairEnvironment(pairingUrl ?? connectionPairingUrl, expectedEnvironmentId);

  const onReconnectEnvironment = useRetryEnvironment();
  const onSetEnvironmentEnabled = (environmentId: EnvironmentId, enabled: boolean) =>
    controller.setEnvironmentEnabled(environmentId, enabled);
  const onUpdateEnvironment = (
    environmentId: EnvironmentId,
    updates: {
      readonly label: string;
      readonly displayUrl: string;
      readonly openedLabel?: string;
    },
  ) => controller.updateEnvironment(environmentId, updates);

  const onRemoveEnvironmentPress = (environmentId: EnvironmentId) => {
    const environment = connectedEnvironments.find(
      (candidate) => candidate.environmentId === environmentId,
    );
    if (!environment) {
      return;
    }
    const remove = {
      text: m(msg("Remove")),
      style: "destructive",
      onPress: () => {
        void controller.removeEnvironment(environmentId);
      },
    } as const;
    if (environment.isRelayManaged) {
      const registration = Discovery.relayEnvironmentRegistration(
        appAtomRegistry.get(relayEnvironmentDiscovery.stateValueAtom),
        environmentId,
      );
      const openAccount = {
        text: m(msg("Open {account}", { account: "T3 Account" })),
        onPress: () => navigation.navigate("SettingsAuth"),
      };
      const cancel = { text: m(msg("Cancel")), style: "cancel" } as const;
      Dialog.alert(
        m(msg("Remove from this device?")),
        `${m(
          msg("Forget {name} and its cached threads on this device.", {
            name: environment.environmentLabel,
          }),
        )}\n\n${m(RELAY_REMOVAL_ACCOUNT_NOTE[registration])}`,
        registration === "unregistered" || !hasCloudPublicConfig()
          ? [cancel, remove]
          : [cancel, openAccount, remove],
      );
      return;
    }
    Dialog.alert(
      m(msg("Remove from this device?")),
      m(
        msg(
          "Forget {name} and its cached threads on this device. Switch it off instead to keep it saved.",
          { name: environment.environmentLabel },
        ),
      ),
      [{ text: m(msg("Cancel")), style: "cancel" }, remove],
    );
  };

  return {
    connectionPairingUrl,
    connectionState,
    connectionError,
    connectedEnvironments,
    connectedEnvironmentCount: connectedEnvironments.length,
    onChangeConnectionPairingUrl,
    onConnectPress,
    onReconnectEnvironment,
    onSetEnvironmentEnabled,
    onUpdateEnvironment,
    onRemoveEnvironmentPress,
  };
}
