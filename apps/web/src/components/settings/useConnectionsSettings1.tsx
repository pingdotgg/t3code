import type { ConnectionsSettingsProps } from "./connectionsSettingsTypes";

import {
  type EnvironmentPresentation,
  useEnvironments,
  usePrimaryEnvironment,
} from "~/state/environments";
import { usePeerLinkHosts } from "~/state/peerLinks";
import { useAtomCommand } from "../../state/use-atom-command";
import { environmentCatalog } from "~/connection/catalog";
import {
  revokeOtherServerClientSessions,
  revokeServerClientSession,
  revokeServerPairingLink,
  usePrimarySessionState,
  type ServerClientSessionRecord,
} from "~/environments/primary";
import { isDesktopLocalConnectionTarget } from "~/connection/desktopLocal";
import { useAtomValue } from "@effect/atom-react";
import { environmentUpdateStatesAtom, serverEnvironment } from "~/state/server";
import { environmentIdsKey } from "~/state/environmentAtomList";
import {
  ServerUpdateAction,
  ServerUpdateProgress,
  ServerUpdatesAction,
  type ServerUpdateTarget,
} from "../ServerUpdateAction";
import {
  resolveServerConfigVersionMismatch,
  resolveServerSelfUpdateCapability,
  supportsDesktopAppUpdate,
} from "~/versionSkew";
import { useState } from "react";
import {
  AuthAccessReadScope,
  AuthAccessWriteScope,
  AuthEnvironmentMaintainScope,
  AuthRelayReadScope,
  AuthRelayWriteScope,
  type AuthClientSession,
  type AuthPairingLink,
  type AuthPairingCredentialResult,
  type AdvertisedEndpoint,
  type DesktopServerExposureState,
  type DesktopWslState,
  type EnvironmentId,
  managedCapabilityDenial,
  resolveEnvironmentMachineKind,
} from "@t3tools/contracts";
import { useUiStateStore } from "~/uiStateStore";
import { readEnvironmentScope, useEnvironmentScope } from "~/state/session";

import { isLocalEnvironmentDisabled } from "../../localEnvironment";
import { useEnvironmentQuery } from "~/state/query";
import { authEnvironment } from "~/state/auth";
import {
  desktopNetworkAccessStateAtom,
  refreshDesktopNetworkAccessState,
} from "~/state/desktopNetworkAccess";
import { desktopWslStateAtom, refreshDesktopWslState } from "~/state/desktopWslState";
import {
  sortDesktopPairingLinks,
  summarizeAuthorizedClients,
  sortDesktopClientSessions,
  toDesktopPairingLinkRecord,
  toDesktopClientSessionRecord,
  selectPairingEndpoint,
  isTailscaleHttpsEndpoint,
  endpointDefaultPreferenceKey,
} from "./ConnectionsSettings.logic";
import {
  applyWslEnableSelection,
  isWslSettingsRowVisible,
  missingTailscaleEndpointDescription,
  resolveLocalVersionStatusLabel,
  resolveTailscaleServeBaseUrl,
} from "./ConnectionsSettings.logic";
import { stackedThreadToast, toastManager } from "../ui/toast";
import {
  isAtomCommandInterrupted,
  settlePromise,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import * as Cause from "effect/Cause";


const DEFAULT_TAILSCALE_SERVE_PORT = 443;

const EMPTY_ADVERTISED_ENDPOINTS: ReadonlyArray<AdvertisedEndpoint> = [];

export function useConnectionsSettings1(props: ConnectionsSettingsProps) {
  const { view } = props;
    const desktopBridge = window.desktopBridge;
    const { environments } = useEnvironments();
    const primaryEnvironment = usePrimaryEnvironment();
    const peerLinkHosts = usePeerLinkHosts();
    const removeEnvironment = useAtomCommand(environmentCatalog.remove, { reportFailure: false });
    const setEnvironmentEnabled = useAtomCommand(environmentCatalog.setEnabled, {
      reportFailure: false,
    });
    const primaryEnvironmentId = primaryEnvironment?.environmentId ?? null;
    const primarySessionState = usePrimarySessionState();
    const currentSessionScopes = primarySessionState.data?.authenticated
      ? (primarySessionState.data.permissions ?? primarySessionState.data.scopes ?? null)
      : null;
    const currentAuthPolicy = desktopBridge ? null : (primarySessionState.data?.auth.policy ?? null);
    const savedEnvironments = environments.filter(
      (environment) => environment.entry.target._tag !== "PrimaryConnectionTarget",
    );
    const listedEnvironments = savedEnvironments.filter(
      (environment) => !isDesktopLocalConnectionTarget(environment.entry.target),
    );
    const savedUpdateStates = useAtomValue(
      environmentUpdateStatesAtom(
        environmentIdsKey(savedEnvironments.map(({ environmentId }) => environmentId)),
      ),
    );
    const savedServerUpdateStates = savedEnvironments.map((environment, index) => ({
      environment,
      updateStatus: savedUpdateStates[index]!.status,
    }));
    const savedServerUpdateTargets = savedServerUpdateStates.flatMap(
      ({ environment, updateStatus }): ServerUpdateTarget[] => {
        const mismatch = resolveServerConfigVersionMismatch(environment.serverConfig);
        const selfUpdate = resolveServerSelfUpdateCapability(environment.serverConfig);
        const desktopAppUpdate = supportsDesktopAppUpdate(environment.serverConfig);
        if (
          !mismatch ||
          updateStatus === "running" ||
          !environment.entry.enabled ||
          environment.connection.phase !== "connected" ||
          isDesktopLocalConnectionTarget(environment.entry.target) ||
          selfUpdate === null ||
          (selfUpdate === "desktop-managed" && !desktopAppUpdate)
        ) {
          return [];
        }
        return [
          {
            environmentId: environment.environmentId,
            serverLabel: environment.label,
            selfUpdate,
            installation: environment.serverConfig?.environment.capabilities.serverInstallation,
            desktopAppUpdate,
            targetVersion: mismatch.clientVersion,
          },
        ];
      },
    );
    const loadBalancingEnvironments = [
      ...(primaryEnvironment ? [primaryEnvironment] : []),
      ...savedEnvironments.filter((environment) => environment.entry.enabled),
    ].filter((environment) => environment.connection.phase !== "unsupported");
    const [desktopServerExposureMutationError, setDesktopServerExposureMutationError] = useState<
      string | null
    >(null);
    const [desktopAccessManagementMutationError, setDesktopAccessManagementMutationError] = useState<
      string | null
    >(null);
    const [createdPairingCredentials, setCreatedPairingCredentials] = useState<
      ReadonlyMap<string, string>
    >(() => new Map());
    const [newestPairingLinkId, setNewestPairingLinkId] = useState<string | null>(null);
    const handlePairingLinkCreated = (created: AuthPairingCredentialResult) => {
      setCreatedPairingCredentials((current) => new Map(current).set(created.id, created.credential));
      setNewestPairingLinkId(created.id);
    };
    const [revokingDesktopPairingLinkId, setRevokingDesktopPairingLinkId] = useState<string | null>(
      null,
    );
    const [revokingDesktopClientSessionId, setRevokingDesktopClientSessionId] = useState<
      string | null
    >(null);
    const [isRevokingOtherDesktopClients, setIsRevokingOtherDesktopClients] = useState(false);
    const [addBackendDialogOpen, setAddBackendDialogOpen] = useState(false);
    const [routeTarget, setRouteTarget] = useState<EnvironmentPresentation | null>(null);
    const [savedBackendError, setSavedBackendError] = useState<string | null>(null);
    const handleAddBackendDialogOpenChange = (open: boolean) => {
      setAddBackendDialogOpen(open);
      if (open) {
        setRouteTarget(null);
      } else {
        setSavedBackendError(null);
      }
    };
    const [removingSavedEnvironmentId, setRemovingSavedEnvironmentId] =
      useState<EnvironmentId | null>(null);
    const [isUpdatingDesktopServerExposure, setIsUpdatingDesktopServerExposure] = useState(false);
    const [isUpdatingTailscaleServe, setIsUpdatingTailscaleServe] = useState(false);
    const [isUpdatingWslBackend, setIsUpdatingWslBackend] = useState(false);
    const [desktopWslMutationError, setDesktopWslMutationError] = useState<string | null>(null);
    type PendingWslChange =
      | { readonly kind: "disable"; readonly wasWslOnly: boolean }
      | { readonly kind: "distro"; readonly nextDistro: string | null }
      | { readonly kind: "enable"; readonly nextDistro: string | null }
      | { readonly kind: "wsl-only"; readonly nextValue: boolean };
    const [pendingWslChange, setPendingWslChange] = useState<PendingWslChange | null>(null);
    const isWslConfirmDialogOpen = pendingWslChange !== null;
    const [pendingTailscaleServeEndpoint, setPendingTailscaleServeEndpoint] =
      useState<AdvertisedEndpoint | null>(null);
    const [disableTailscaleServeDialogOpen, setDisableTailscaleServeDialogOpen] = useState(false);
    const [tailscaleServePortInput, setTailscaleServePortInput] = useState(
      String(DEFAULT_TAILSCALE_SERVE_PORT),
    );
    const [pendingDesktopServerExposureMode, setPendingDesktopServerExposureMode] = useState<
      DesktopServerExposureState["mode"] | null
    >(null);
    const primaryServerConfig = primaryEnvironment?.serverConfig ?? null;
    const primaryManagedPolicy = primaryServerConfig?.managedPolicy;
    // Turning remote access off stays possible; only the way in is managed.
    const remoteClientsDenial = managedCapabilityDenial(primaryManagedPolicy, "remoteClients");
    const primaryVersionMismatch = resolveServerConfigVersionMismatch(primaryServerConfig);
    const primaryServerUpdateState = useAtomValue(
      serverEnvironment.updateStateAtom(primaryEnvironmentId),
    );
    const [isAdvertisedEndpointListExpanded, setIsAdvertisedEndpointListExpanded] = useState(false);
    const defaultAdvertisedEndpointKey = useUiStateStore(
      (state) => state.defaultAdvertisedEndpointKey,
    );
    const setDefaultAdvertisedEndpointKey = useUiStateStore(
      (state) => state.setDefaultAdvertisedEndpointKey,
    );
    const canReadAccess = useEnvironmentScope(primaryEnvironmentId, AuthAccessReadScope);
    const canWriteAccess = useEnvironmentScope(primaryEnvironmentId, AuthAccessWriteScope);
    const canReadRelay = useEnvironmentScope(primaryEnvironmentId, AuthRelayReadScope);
    const canMaintain = useEnvironmentScope(primaryEnvironmentId, AuthEnvironmentMaintainScope);
    const canManageRelay = useEnvironmentScope(primaryEnvironmentId, AuthRelayWriteScope);
    const canManageLocalBackend = !isLocalEnvironmentDisabled() && canMaintain;
    const showsAccess = view === "access";
    const authAccessChanges = useEnvironmentQuery(
      showsAccess && canReadAccess && primaryEnvironmentId !== null
        ? authEnvironment.accessChanges({
            environmentId: primaryEnvironmentId,
            input: null,
          })
        : null,
    );
    const desktopNetworkAccess = useEnvironmentQuery(
      showsAccess && canManageLocalBackend && desktopBridge ? desktopNetworkAccessStateAtom : null,
    );
    const desktopWsl = useEnvironmentQuery(
      showsAccess && canManageLocalBackend && desktopBridge ? desktopWslStateAtom : null,
    );
    const desktopWslState = desktopWsl.data;
    const desktopWslError = desktopWslMutationError ?? desktopWsl.error;
    const isLoadingWslState = desktopWsl.isPending && desktopWsl.data === null;
    const desktopServerExposureState = desktopNetworkAccess.data?.serverExposureState ?? null;
    const desktopAdvertisedEndpoints =
      desktopNetworkAccess.data?.advertisedEndpoints ?? EMPTY_ADVERTISED_ENDPOINTS;
    const desktopServerExposureError =
      desktopServerExposureMutationError ?? desktopNetworkAccess.error;
    const desktopAccessManagementError =
      desktopAccessManagementMutationError ?? authAccessChanges.error;
    const isLoadingDesktopAccessManagement =
      authAccessChanges.isPending && authAccessChanges.data === null;
    const desktopPairingLinks = (() => {
      const event = authAccessChanges.data;
      if (event?.type !== "snapshot") return [];
      return sortDesktopPairingLinks(
        event.payload.pairingLinks.map((pairingLink: AuthPairingLink) =>
          toDesktopPairingLinkRecord(pairingLink),
        ),
      );
    })();
    const desktopClientSessions = (() => {
      const event = authAccessChanges.data;
      if (event?.type !== "snapshot") return [];
      return sortDesktopClientSessions(
        event.payload.clientSessions.map((clientSession: AuthClientSession) =>
          toDesktopClientSessionRecord(clientSession),
        ),
      );
    })();
    const isLocalBackendNetworkAccessible = desktopBridge
      ? desktopServerExposureState?.mode === "network-accessible"
      : currentAuthPolicy === "remote-reachable";
    const trimmedTailscaleServePortInput = tailscaleServePortInput.trim();
    const parsedTailscaleServePort = Number(trimmedTailscaleServePortInput);
    const isTailscaleServePortValid =
      /^\d+$/u.test(trimmedTailscaleServePortInput) &&
      Number.isInteger(parsedTailscaleServePort) &&
      parsedTailscaleServePort >= 1 &&
      parsedTailscaleServePort <= 65_535;

    const pendingTailscaleServeBaseUrl = resolveTailscaleServeBaseUrl(
      pendingTailscaleServeEndpoint,
      parsedTailscaleServePort,
      isTailscaleServePortValid,
    );

    const handleDesktopServerExposureChange = async (checked: boolean) => {
      if (
        !desktopBridge ||
        primaryEnvironmentId === null ||
        !readEnvironmentScope(primaryEnvironmentId, AuthEnvironmentMaintainScope)
      )
        return;
      setIsUpdatingDesktopServerExposure(true);
      setDesktopServerExposureMutationError(null);
      try {
        await desktopBridge.setServerExposureMode(checked ? "network-accessible" : "local-only");
        refreshDesktopNetworkAccessState();
        setPendingDesktopServerExposureMode(null);
        setIsUpdatingDesktopServerExposure(false);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Failed to update network exposure.";
        setPendingDesktopServerExposureMode(null);
        setDesktopServerExposureMutationError(message);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Could not update network access",
            description: message,
          }),
        );
        setIsUpdatingDesktopServerExposure(false);
      }
    };

    const handleConfirmDesktopServerExposureChange = () => {
      if (pendingDesktopServerExposureMode === null) return;
      const checked = pendingDesktopServerExposureMode === "network-accessible";
      void handleDesktopServerExposureChange(checked);
    };

    const handleConfirmTailscaleServeSetup = async () => {
      if (
        !desktopBridge ||
        primaryEnvironmentId === null ||
        !readEnvironmentScope(primaryEnvironmentId, AuthEnvironmentMaintainScope)
      )
        return;
      if (!isTailscaleServePortValid) return;
      setIsUpdatingTailscaleServe(true);
      setDesktopServerExposureMutationError(null);
      const settled = await settlePromise(async () => {
        await desktopBridge.setTailscaleServeEnabled({
          enabled: true,
          port: parsedTailscaleServePort,
        });
        refreshDesktopNetworkAccessState();
        setPendingTailscaleServeEndpoint(null);
      });
      if (settled._tag === "Failure") {
        const error = Cause.squash(settled.cause);
        const message =
          error instanceof Error ? error.message : "Failed to configure Tailscale HTTPS.";
        setDesktopServerExposureMutationError(message);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Could not set up Tailscale HTTPS",
            description: message,
          }),
        );
      }
      setIsUpdatingTailscaleServe(false);
    };

    const handleStartTailscaleServeSetup = (endpoint: AdvertisedEndpoint) => {
      setTailscaleServePortInput(
        String(desktopServerExposureState?.tailscaleServePort ?? DEFAULT_TAILSCALE_SERVE_PORT),
      );
      setPendingTailscaleServeEndpoint(endpoint);
    };

    const handleConfirmTailscaleServeDisable = async () => {
      if (
        !desktopBridge ||
        primaryEnvironmentId === null ||
        !readEnvironmentScope(primaryEnvironmentId, AuthEnvironmentMaintainScope)
      )
        return;
      setIsUpdatingTailscaleServe(true);
      setDesktopServerExposureMutationError(null);
      const settled = await settlePromise(async () => {
        await desktopBridge.setTailscaleServeEnabled({
          enabled: false,
          port: desktopServerExposureState?.tailscaleServePort ?? DEFAULT_TAILSCALE_SERVE_PORT,
        });
        refreshDesktopNetworkAccessState();
        setDisableTailscaleServeDialogOpen(false);
      });
      if (settled._tag === "Failure") {
        const error = Cause.squash(settled.cause);
        const message = error instanceof Error ? error.message : "Failed to disable Tailscale HTTPS.";
        setDesktopServerExposureMutationError(message);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Could not disable Tailscale HTTPS",
            description: message,
          }),
        );
      }
      setIsUpdatingTailscaleServe(false);
    };

  return { desktopBridge, environments, primaryEnvironment, peerLinkHosts, removeEnvironment, setEnvironmentEnabled, primaryEnvironmentId, currentSessionScopes, currentAuthPolicy, savedEnvironments, listedEnvironments, savedServerUpdateTargets, loadBalancingEnvironments, setDesktopAccessManagementMutationError, createdPairingCredentials, newestPairingLinkId, handlePairingLinkCreated, revokingDesktopPairingLinkId, setRevokingDesktopPairingLinkId, revokingDesktopClientSessionId, setRevokingDesktopClientSessionId, isRevokingOtherDesktopClients, setIsRevokingOtherDesktopClients, addBackendDialogOpen, setAddBackendDialogOpen, routeTarget, setRouteTarget, savedBackendError, setSavedBackendError, handleAddBackendDialogOpenChange, removingSavedEnvironmentId, setRemovingSavedEnvironmentId, isUpdatingDesktopServerExposure, isUpdatingTailscaleServe, isUpdatingWslBackend, setIsUpdatingWslBackend, setDesktopWslMutationError, pendingWslChange, setPendingWslChange, isWslConfirmDialogOpen, pendingTailscaleServeEndpoint, setPendingTailscaleServeEndpoint, disableTailscaleServeDialogOpen, setDisableTailscaleServeDialogOpen, tailscaleServePortInput, setTailscaleServePortInput, pendingDesktopServerExposureMode, setPendingDesktopServerExposureMode, primaryServerConfig, primaryManagedPolicy, remoteClientsDenial, primaryVersionMismatch, primaryServerUpdateState, isAdvertisedEndpointListExpanded, setIsAdvertisedEndpointListExpanded, defaultAdvertisedEndpointKey, setDefaultAdvertisedEndpointKey, canReadAccess, canWriteAccess, canReadRelay, canManageRelay, canManageLocalBackend, showsAccess, authAccessChanges, desktopWslState, desktopWslError, isLoadingWslState, desktopServerExposureState, desktopAdvertisedEndpoints, desktopServerExposureError, desktopAccessManagementError, isLoadingDesktopAccessManagement, desktopPairingLinks, desktopClientSessions, isLocalBackendNetworkAccessible, isTailscaleServePortValid, pendingTailscaleServeBaseUrl, handleConfirmDesktopServerExposureChange, handleConfirmTailscaleServeSetup, handleStartTailscaleServeSetup, handleConfirmTailscaleServeDisable };
}
