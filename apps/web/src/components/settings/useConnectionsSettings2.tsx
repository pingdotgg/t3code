import type { ConnectionsSettingsProps } from "./connectionsSettingsTypes";
import { useConnectionsSettings1 } from "./useConnectionsSettings1";

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
import { readEnvironmentScope, useEnvironmentScope } from "~/state/session";
import {
  isAtomCommandInterrupted,
  settlePromise,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  revokeOtherServerClientSessions,
  revokeServerClientSession,
  revokeServerPairingLink,
  usePrimarySessionState,
  type ServerClientSessionRecord,
} from "~/environments/primary";
import * as Cause from "effect/Cause";
import { stackedThreadToast, toastManager } from "../ui/toast";
import {
  type EnvironmentPresentation,
  useEnvironments,
  usePrimaryEnvironment,
} from "~/state/environments";
import { useState } from "react";
import { hasCloudPublicConfig } from "~/cloud/publicConfig";
import { requestConfirmDialog } from "~/confirmDialog";
import { Switch } from "../ui/switch";
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
  AdvertisedEndpointListRow,
  AuthorizedClientsHeaderAction,
  NetworkAccessDescription,
  PairingClientsList,
} from "./AuthorizedClientsSettings";
import { desktopWslStateAtom, refreshDesktopWslState } from "~/state/desktopWslState";
import { isDesktopLocalConnectionTarget } from "~/connection/desktopLocal";
import {
  applyWslEnableSelection,
  isWslSettingsRowVisible,
  missingTailscaleEndpointDescription,
  resolveLocalVersionStatusLabel,
  resolveTailscaleServeBaseUrl,
} from "./ConnectionsSettings.logic";


// Colons are invalid in distro names, keeping picker sentinels collision-free.
const BACKEND_VALUE_DEFAULT_WSL = "backend:default-wsl";

const BACKEND_VALUE_WSL_OFF = "backend:wsl-off";

export function useConnectionsSettings2(props: ConnectionsSettingsProps, params: {
  s1: ReturnType<typeof useConnectionsSettings1>,
  }) {
  const { s1 } = params;
  const { setDisableTailscaleServeDialogOpen, primaryEnvironmentId, setRevokingDesktopPairingLinkId, setDesktopAccessManagementMutationError, setRevokingDesktopClientSessionId, setIsRevokingOtherDesktopClients, setSavedBackendError, setEnvironmentEnabled, setRemovingSavedEnvironmentId, removeEnvironment, desktopPairingLinks, desktopAdvertisedEndpoints, isLocalBackendNetworkAccessible, defaultAdvertisedEndpointKey, setDefaultAdvertisedEndpointKey, desktopServerExposureState, isUpdatingDesktopServerExposure, setPendingDesktopServerExposureMode, isAdvertisedEndpointListExpanded, handleStartTailscaleServeSetup, isUpdatingTailscaleServe, desktopBridge, setIsUpdatingWslBackend, setDesktopWslMutationError, environments, desktopWslState, setPendingWslChange, pendingWslChange } = s1;
    const handleStartTailscaleServeDisable = (_endpoint: AdvertisedEndpoint) => {
      setDisableTailscaleServeDialogOpen(true);
    };

    const handleRevokeDesktopPairingLink = async (id: string) => {
      if (
        primaryEnvironmentId === null ||
        !readEnvironmentScope(primaryEnvironmentId, AuthAccessWriteScope)
      )
        return;
      setRevokingDesktopPairingLinkId(id);
      setDesktopAccessManagementMutationError(null);
      const settled = await settlePromise(async () => {
        await revokeServerPairingLink(id);
      });
      if (settled._tag === "Failure") {
        const error = Cause.squash(settled.cause);
        const message = error instanceof Error ? error.message : "Failed to revoke pairing link.";
        setDesktopAccessManagementMutationError(message);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Could not revoke pairing link",
            description: message,
          }),
        );
      }
      setRevokingDesktopPairingLinkId(null);
    };

    const handleRevokeDesktopClientSession = async (
      sessionId: ServerClientSessionRecord["sessionId"],
    ) => {
      if (
        primaryEnvironmentId === null ||
        !readEnvironmentScope(primaryEnvironmentId, AuthAccessWriteScope)
      )
        return;
      setRevokingDesktopClientSessionId(sessionId);
      setDesktopAccessManagementMutationError(null);
      const settled = await settlePromise(async () => {
        await revokeServerClientSession(sessionId);
      });
      if (settled._tag === "Failure") {
        const error = Cause.squash(settled.cause);
        const message = error instanceof Error ? error.message : "Failed to revoke client access.";
        setDesktopAccessManagementMutationError(message);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Could not revoke client access",
            description: message,
          }),
        );
      }
      setRevokingDesktopClientSessionId(null);
    };

    const handleRevokeOtherDesktopClients = async () => {
      if (
        primaryEnvironmentId === null ||
        !readEnvironmentScope(primaryEnvironmentId, AuthAccessWriteScope)
      )
        return;
      setIsRevokingOtherDesktopClients(true);
      setDesktopAccessManagementMutationError(null);
      const settled = await settlePromise(async () => {
        const revokedCount = await revokeOtherServerClientSessions();
        toastManager.add({
          type: "success",
          title: revokedCount === 1 ? "Revoked 1 other client" : `Revoked ${revokedCount} clients`,
          description: "Other paired clients will need a new pairing link before reconnecting.",
        });
      });
      if (settled._tag === "Failure") {
        const error = Cause.squash(settled.cause);
        const message = error instanceof Error ? error.message : "Failed to revoke other clients.";
        setDesktopAccessManagementMutationError(message);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Could not revoke other clients",
            description: message,
          }),
        );
      }
      setIsRevokingOtherDesktopClients(false);
    };

    const handleSetSavedBackendEnabled = async (environmentId: EnvironmentId, enabled: boolean) => {
      setSavedBackendError(null);
      const result = await setEnvironmentEnabled({ environmentId, enabled });
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        const message =
          error instanceof Error
            ? error.message
            : `Failed to switch the backend ${enabled ? "on" : "off"}.`;
        setSavedBackendError(message);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: `Could not switch backend ${enabled ? "on" : "off"}`,
            description: message,
          }),
        );
      }
    };

    const removeSavedBackend = async (environment: EnvironmentPresentation) => {
      const environmentId = environment.environmentId;
      setRemovingSavedEnvironmentId(environmentId);
      setSavedBackendError(null);
      const result = await removeEnvironment(environmentId);
      setRemovingSavedEnvironmentId(null);
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        const message = error instanceof Error ? error.message : "Failed to remove backend.";
        setSavedBackendError(message);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Could not remove backend",
            description: message,
          }),
        );
      }
    };

    // Removing a T3 Connect route preserves account registration; use a separate dialog pointing to
    // deregistration.
    const [pendingT3ConnectRemoval, setPendingT3ConnectRemoval] =
      useState<EnvironmentPresentation | null>(null);
    const handleRemoveSavedBackend = async (environment: EnvironmentPresentation) => {
      if (environment.relayManaged && hasCloudPublicConfig()) {
        setPendingT3ConnectRemoval(environment);
        return;
      }
      const confirmed = await requestConfirmDialog(
        `Remove ${environment.label} from this device?\nThis forgets its pairing, credentials, and cached threads here. Switch it off instead to keep it saved.`,
        { variant: "destructive" },
      );
      if (confirmed === true) await removeSavedBackend(environment);
    };

    const visibleDesktopPairingLinks = desktopPairingLinks;
    const tailscaleHttpsEndpoint = desktopAdvertisedEndpoints.find(isTailscaleHttpsEndpoint) ?? null;
    const visibleDesktopNetworkAdvertisedEndpoints = isLocalBackendNetworkAccessible
      ? desktopAdvertisedEndpoints.filter((endpoint) => !isTailscaleHttpsEndpoint(endpoint))
      : [];
    const visibleDesktopAdvertisedEndpoints = tailscaleHttpsEndpoint
      ? [...visibleDesktopNetworkAdvertisedEndpoints, tailscaleHttpsEndpoint]
      : visibleDesktopNetworkAdvertisedEndpoints;
    const defaultDesktopNetworkAdvertisedEndpoint = selectPairingEndpoint(
      visibleDesktopNetworkAdvertisedEndpoints,
      defaultAdvertisedEndpointKey,
    );
    const defaultDesktopAdvertisedEndpoint =
      defaultDesktopNetworkAdvertisedEndpoint ??
      selectPairingEndpoint(
        tailscaleHttpsEndpoint ? [tailscaleHttpsEndpoint] : [],
        defaultAdvertisedEndpointKey,
      );
    const defaultDesktopAdvertisedEndpointKey = defaultDesktopAdvertisedEndpoint
      ? endpointDefaultPreferenceKey(defaultDesktopAdvertisedEndpoint)
      : null;
    const handleSetDefaultAdvertisedEndpoint = (endpoint: AdvertisedEndpoint) => {
      setDefaultAdvertisedEndpointKey(endpointDefaultPreferenceKey(endpoint));
    };

    const renderNetworkAccessToggle = () => (
      <Switch
        checked={desktopServerExposureState?.mode === "network-accessible"}
        disabled={!desktopServerExposureState || isUpdatingDesktopServerExposure}
        onCheckedChange={(checked) => {
          setPendingDesktopServerExposureMode(checked ? "network-accessible" : "local-only");
        }}
        aria-label="Enable network access"
      />
    );
    const renderEndpointRows = () =>
      isAdvertisedEndpointListExpanded
        ? visibleDesktopNetworkAdvertisedEndpoints.map((endpoint) => {
            const endpointKey = endpointDefaultPreferenceKey(endpoint);
            return (
              <AdvertisedEndpointListRow
                key={endpoint.id}
                endpoint={endpoint}
                isDefault={endpointKey === defaultDesktopAdvertisedEndpointKey}
                onSetDefault={handleSetDefaultAdvertisedEndpoint}
                onSetupTailscaleServe={handleStartTailscaleServeSetup}
                onDisableTailscaleServe={handleStartTailscaleServeDisable}
                isUpdatingTailscaleServe={isUpdatingTailscaleServe}
              />
            );
          })
        : null;
    const applyWslSettingChange = async (apply: () => Promise<DesktopWslState>) => {
      if (
        !desktopBridge ||
        primaryEnvironmentId === null ||
        !readEnvironmentScope(primaryEnvironmentId, AuthEnvironmentMaintainScope)
      )
        return;
      setIsUpdatingWslBackend(true);
      setDesktopWslMutationError(null);
      const settled = await settlePromise(async () => {
        await apply();
        refreshDesktopWslState();
      });
      if (settled._tag === "Failure") {
        const error = Cause.squash(settled.cause);
        const message = error instanceof Error ? error.message : "Failed to update WSL backend.";
        setDesktopWslMutationError(message);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Could not change WSL backend",
            description: message,
          }),
        );
        refreshDesktopWslState();
      }
      setIsUpdatingWslBackend(false);
    };

    const loadWslState = () => {
      setDesktopWslMutationError(null);
      refreshDesktopWslState();
    };

    const hasWslRegistrationToLose = environments.some((environment) =>
      isDesktopLocalConnectionTarget(environment.entry.target),
    );

    const handleSelectWslMode = (value: string) => {
      if (!desktopBridge || !desktopWslState) return;
      const defaultDistroName =
        desktopWslState.distros.find((distro) => distro.isDefault)?.name ?? null;
      if (value === BACKEND_VALUE_WSL_OFF) {
        // Unavailable WSL can remain wslOnly while disabled; switching to Windows must clear both.
        if (!desktopWslState.enabled && !desktopWslState.wslOnly) return;
        const wasWslOnly = desktopWslState.wslOnly;
        if (hasWslRegistrationToLose || wasWslOnly) {
          setPendingWslChange({ kind: "disable", wasWslOnly });
          return;
        }
        void applyWslSettingChange(() => desktopBridge.setWslBackendEnabled(false));
        return;
      }
      const nextDistro = value === BACKEND_VALUE_DEFAULT_WSL ? null : value;
      const resolvedNext = nextDistro ?? defaultDistroName;
      if (!desktopWslState.enabled) {
        setPendingWslChange({ kind: "enable", nextDistro });
        return;
      }
      const resolvedCurrent = desktopWslState.distro ?? defaultDistroName;
      if (resolvedCurrent === resolvedNext) return;
      if (hasWslRegistrationToLose || desktopWslState.wslOnly) {
        setPendingWslChange({ kind: "distro", nextDistro });
        return;
      }
      void applyWslSettingChange(() => desktopBridge.setWslDistro(nextDistro));
    };

    const handleConfirmEnableWsl = (mode: "both" | "wsl-only") => {
      if (!desktopBridge || !pendingWslChange || pendingWslChange.kind !== "enable") return;
      const nextDistro = pendingWslChange.nextDistro;
      setPendingWslChange(null);
      const persistedDistro = desktopWslState?.distro ?? null;
      void applyWslSettingChange(() =>
        applyWslEnableSelection({
          bridge: desktopBridge,
          mode,
          nextDistro,
          persistedDistro,
        }),
      );
    };

    const handleToggleWslOnly = (enabled: boolean) => {
      if (!desktopBridge || !desktopWslState || desktopWslState.wslOnly === enabled) return;
      setPendingWslChange({ kind: "wsl-only", nextValue: enabled });
    };

    const handleConfirmWslChange = () => {
      if (!desktopBridge || !pendingWslChange) return;
      const change = pendingWslChange;
      if (change.kind === "enable") return;
      setPendingWslChange(null);
      if (change.kind === "disable") {
        void applyWslSettingChange(async () => {
          const next = await desktopBridge.setWslBackendEnabled(false);
          if (change.wasWslOnly) {
            return await desktopBridge.setWslOnly(false);
          }
          return next;
        });
        return;
      }
      if (change.kind === "distro") {
        void applyWslSettingChange(() => desktopBridge.setWslDistro(change.nextDistro));
        return;
      }
      void applyWslSettingChange(() => desktopBridge.setWslOnly(change.nextValue));
    };

  return { handleStartTailscaleServeDisable, handleRevokeDesktopPairingLink, handleRevokeDesktopClientSession, handleRevokeOtherDesktopClients, handleSetSavedBackendEnabled, removeSavedBackend, pendingT3ConnectRemoval, setPendingT3ConnectRemoval, handleRemoveSavedBackend, visibleDesktopPairingLinks, tailscaleHttpsEndpoint, visibleDesktopNetworkAdvertisedEndpoints, visibleDesktopAdvertisedEndpoints, defaultDesktopNetworkAdvertisedEndpoint, defaultDesktopAdvertisedEndpointKey, renderNetworkAccessToggle, renderEndpointRows, loadWslState, handleSelectWslMode, handleConfirmEnableWsl, handleToggleWslOnly, handleConfirmWslChange };
}
