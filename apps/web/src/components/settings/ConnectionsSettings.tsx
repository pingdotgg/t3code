
import { useConnectionsSettings1 } from "./useConnectionsSettings1";
import type { ConnectionsSettingsProps } from "./connectionsSettingsTypes";
import { useConnectionsSettings2 } from "./useConnectionsSettings2";
import { useConnectionsSettings3 } from "./useConnectionsSettings3";
import { useConnectionsSettings4 } from "./useConnectionsSettings4";

import { type AdvertisedEndpoint } from "@t3tools/contracts";

import { resolveLocalVersionStatusLabel } from "./ConnectionsSettings.logic";
import { SettingsPageContainer, SettingsSection } from "./settingsLayout";

import { LocalEnvironmentSetting } from "./LocalEnvironmentSetting";
import { searchableSetting } from "./settingsSearch";

import { LinkedEnvironmentsSettings } from "./LinkedEnvironmentsSettings";

import { LoadBalancingSettings } from "./LoadBalancingSettings";
import { PullRequestRoutingSettings } from "./PullRequestRoutingSettings";

import { hasCloudPublicConfig } from "~/cloud/publicConfig";
import { RemoveT3ConnectEnvironmentDialog } from "../clerk/RemoveT3ConnectEnvironmentDialog";

import { useDesktopUpdateState } from "~/state/desktopUpdate";

import { ServerUpdatesAction } from "../ServerUpdateAction";

import { CloudRemoteEnvironmentRows, SavedBackendListRow } from "./SavedEnvironmentRows";
import { AddEnvironmentDialog } from "./AddEnvironmentDialog";

/** Environments lists the machines this app connects to; access covers who may reach this one. */
export function ConnectionsSettings(props: ConnectionsSettingsProps) {
  const { view } = props;
const s1 = useConnectionsSettings1(props);
const { desktopBridge, environments, primaryEnvironment, peerLinkHosts, removeEnvironment, setEnvironmentEnabled, primaryEnvironmentId, currentSessionScopes, currentAuthPolicy, savedEnvironments, listedEnvironments, savedServerUpdateTargets, loadBalancingEnvironments, setDesktopAccessManagementMutationError, createdPairingCredentials, newestPairingLinkId, handlePairingLinkCreated, revokingDesktopPairingLinkId, setRevokingDesktopPairingLinkId, revokingDesktopClientSessionId, setRevokingDesktopClientSessionId, isRevokingOtherDesktopClients, setIsRevokingOtherDesktopClients, addBackendDialogOpen, setAddBackendDialogOpen, routeTarget, setRouteTarget, savedBackendError, setSavedBackendError, handleAddBackendDialogOpenChange, removingSavedEnvironmentId, setRemovingSavedEnvironmentId, isUpdatingDesktopServerExposure, isUpdatingTailscaleServe, isUpdatingWslBackend, setIsUpdatingWslBackend, setDesktopWslMutationError, pendingWslChange, setPendingWslChange, isWslConfirmDialogOpen, pendingTailscaleServeEndpoint, setPendingTailscaleServeEndpoint, disableTailscaleServeDialogOpen, setDisableTailscaleServeDialogOpen, tailscaleServePortInput, setTailscaleServePortInput, pendingDesktopServerExposureMode, setPendingDesktopServerExposureMode, primaryServerConfig, primaryManagedPolicy, remoteClientsDenial, primaryVersionMismatch, primaryServerUpdateState, isAdvertisedEndpointListExpanded, setIsAdvertisedEndpointListExpanded, defaultAdvertisedEndpointKey, setDefaultAdvertisedEndpointKey, canReadAccess, canWriteAccess, canReadRelay, canManageRelay, canManageLocalBackend, showsAccess, authAccessChanges, desktopWslState, desktopWslError, isLoadingWslState, desktopServerExposureState, desktopAdvertisedEndpoints, desktopServerExposureError, desktopAccessManagementError, isLoadingDesktopAccessManagement, desktopPairingLinks, desktopClientSessions, isLocalBackendNetworkAccessible, isTailscaleServePortValid, pendingTailscaleServeBaseUrl, handleConfirmDesktopServerExposureChange, handleConfirmTailscaleServeSetup, handleStartTailscaleServeSetup, handleConfirmTailscaleServeDisable } = s1;

const s2 = useConnectionsSettings2(props, { s1 });
const { handleStartTailscaleServeDisable, handleRevokeDesktopPairingLink, handleRevokeDesktopClientSession, handleRevokeOtherDesktopClients, handleSetSavedBackendEnabled, removeSavedBackend, pendingT3ConnectRemoval, setPendingT3ConnectRemoval, handleRemoveSavedBackend, visibleDesktopPairingLinks, tailscaleHttpsEndpoint, visibleDesktopNetworkAdvertisedEndpoints, visibleDesktopAdvertisedEndpoints, defaultDesktopNetworkAdvertisedEndpoint, defaultDesktopAdvertisedEndpointKey, renderNetworkAccessToggle, renderEndpointRows, loadWslState, handleSelectWslMode, handleConfirmEnableWsl, handleToggleWslOnly, handleConfirmWslChange } = s2;

const s3 = useConnectionsSettings3(props, { s1, s2 });
const { renderWslRow } = s3;

const s4 = useConnectionsSettings4(props, { s1, s2, s3 });
const { primarySettings } = s4;

  if (showsAccess) return <SettingsPageContainer>{primarySettings}</SettingsPageContainer>;

  return (
    <SettingsPageContainer>
      {desktopBridge ? (
        <SettingsSection id="this-app" title="This app">
          <LocalEnvironmentSetting />
        </SettingsSection>
      ) : null}
      <SettingsSection
        {...searchableSetting("remote-environments")}
        title="Environments"
        headerAction={
          <div className="flex items-center gap-1">
            {savedServerUpdateTargets.length > 0 ? (
              <ServerUpdatesAction targets={savedServerUpdateTargets} variant="ghost-muted" />
            ) : null}
            <AddEnvironmentDialog
              open={addBackendDialogOpen}
              routeTarget={routeTarget}
              error={savedBackendError}
              savedEnvironments={savedEnvironments}
              onOpenChange={handleAddBackendDialogOpenChange}
              onErrorChange={setSavedBackendError}
            />
          </div>
        }
      >
        {listedEnvironments.map((environment) => (
          <SavedBackendListRow
            key={environment.environmentId}
            environment={environment}
            removingEnvironmentId={removingSavedEnvironmentId}
            onSetEnabled={handleSetSavedBackendEnabled}
            onRemove={handleRemoveSavedBackend}
            onAddRoute={(target) => {
              setRouteTarget(target);
              setSavedBackendError(null);
              setAddBackendDialogOpen(true);
            }}
          />
        ))}
        <CloudRemoteEnvironmentRows
          primaryEnvironmentId={primaryEnvironmentId}
          savedEnvironments={savedEnvironments}
        />
      </SettingsSection>
      {hasCloudPublicConfig() ? (
        <RemoveT3ConnectEnvironmentDialog
          environmentLabel={pendingT3ConnectRemoval?.label ?? null}
          environmentId={pendingT3ConnectRemoval?.environmentId ?? null}
          onCancel={() => setPendingT3ConnectRemoval(null)}
          onConfirm={() => {
            if (!pendingT3ConnectRemoval) return;
            setPendingT3ConnectRemoval(null);
            void removeSavedBackend(pendingT3ConnectRemoval);
          }}
        />
      ) : null}
      {peerLinkHosts.map((environment, index) => (
        <LinkedEnvironmentsSettings
          key={environment.environmentId}
          environmentId={environment.environmentId}
          environmentLabel={peerLinkHosts.length > 1 ? environment.label : null}
          isSearchTarget={index === 0}
        />
      ))}
      <LoadBalancingSettings environments={loadBalancingEnvironments} />
      <PullRequestRoutingSettings environments={loadBalancingEnvironments} />
    </SettingsPageContainer>
  );
}
