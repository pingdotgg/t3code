import type { ConnectionsSettingsProps } from "./connectionsSettingsTypes";
import { useConnectionsSettings1 } from "./useConnectionsSettings1";
import { useConnectionsSettings2 } from "./useConnectionsSettings2";
import { useConnectionsSettings3 } from "./useConnectionsSettings3";

import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import {
  applyWslEnableSelection,
  isWslSettingsRowVisible,
  missingTailscaleEndpointDescription,
  resolveLocalVersionStatusLabel,
  resolveTailscaleServeBaseUrl,
} from "./ConnectionsSettings.logic";
import { Switch } from "../ui/switch";
import {
  AdvertisedEndpointListRow,
  AuthorizedClientsHeaderAction,
  NetworkAccessDescription,
  PairingClientsList,
} from "./AuthorizedClientsSettings";
import { ITEM_ROW_CLASSNAME } from "./itemRows";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { EnvironmentMachineIcon } from "../EnvironmentMachineIcon";
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
import { Menu, MenuPopup, MenuTrigger } from "../ui/menu";
import { Button } from "../ui/button";
import { ChevronRightIcon, EllipsisIcon } from "lucide-react";
import { EnvironmentIconMenu } from "./EnvironmentIconPicker";
import { ManagedByOrganization } from "../ManagedPolicy";
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
import {
  CloudLinkRow,
  CloudRemoteEnvironmentRows,
  SavedBackendListRow,
} from "./SavedEnvironmentRows";import { SessionPermissions } from "./SessionPermissions";
import { FoldedSettingsSection } from "./FoldedSettingsSection";
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
import { ScrollArea } from "../ui/scroll-area";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Spinner } from "../ui/spinner";
import {
  Dialog,
  DialogClose,
  DialogFooter,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { useDesktopUpdateState } from "~/state/desktopUpdate";


// Subscribes on its own so desktop download progress does not re-render the page.
function LocalVersionStatusLabel() {
  const updateState = useDesktopUpdateState();
  return (
    <span className="text-xs text-muted-foreground">
      {resolveLocalVersionStatusLabel(updateState)}
    </span>
  );
}

export function useConnectionsSettings4(props: ConnectionsSettingsProps, params: {
  s1: ReturnType<typeof useConnectionsSettings1>,
  s2: ReturnType<typeof useConnectionsSettings2>,
  s3: ReturnType<typeof useConnectionsSettings3>,
  }) {
  const { s1, s2, s3 } = params;
  const { view } = props;
  const { tailscaleHttpsEndpoint, handleStartTailscaleServeDisable, visibleDesktopPairingLinks, visibleDesktopAdvertisedEndpoints, defaultDesktopAdvertisedEndpointKey, handleRevokeDesktopPairingLink, handleRevokeDesktopClientSession, defaultDesktopNetworkAdvertisedEndpoint, visibleDesktopNetworkAdvertisedEndpoints, renderNetworkAccessToggle, renderEndpointRows, handleRevokeOtherDesktopClients, handleConfirmEnableWsl, handleConfirmWslChange } = s2;
  const { desktopServerExposureState, isUpdatingTailscaleServe, handleStartTailscaleServeSetup, remoteClientsDenial, newestPairingLinkId, desktopClientSessions, isLoadingDesktopAccessManagement, createdPairingCredentials, revokingDesktopPairingLinkId, revokingDesktopClientSessionId, canWriteAccess, desktopAccessManagementError, isLocalBackendNetworkAccessible, isAdvertisedEndpointListExpanded, setIsAdvertisedEndpointListExpanded, desktopServerExposureError, desktopBridge, currentAuthPolicy, primaryEnvironmentId, primaryEnvironment, primaryServerConfig, primaryManagedPolicy, canManageLocalBackend, primaryServerUpdateState, primaryVersionMismatch, canReadRelay, canManageRelay, canReadAccess, currentSessionScopes, handlePairingLinkCreated, authAccessChanges, isRevokingOtherDesktopClients, pendingDesktopServerExposureMode, isUpdatingDesktopServerExposure, setPendingDesktopServerExposureMode, handleConfirmDesktopServerExposureChange, isWslConfirmDialogOpen, isUpdatingWslBackend, setPendingWslChange, pendingWslChange, disableTailscaleServeDialogOpen, setDisableTailscaleServeDialogOpen, handleConfirmTailscaleServeDisable, pendingTailscaleServeEndpoint, setPendingTailscaleServeEndpoint, tailscaleServePortInput, setTailscaleServePortInput, isTailscaleServePortValid, pendingTailscaleServeBaseUrl, handleConfirmTailscaleServeSetup } = s1;
  const { renderWslRow } = s3;
    const renderTailscaleRow = () => (
      <SettingsRow
        title={searchableSetting("tailscale-https").title}
        description={
          tailscaleHttpsEndpoint
            ? tailscaleHttpsEndpoint.status === "available"
              ? tailscaleHttpsEndpoint.httpBaseUrl
              : "Use Tailscale Serve to expose this backend through a MagicDNS HTTPS URL."
            : missingTailscaleEndpointDescription(desktopServerExposureState)
        }
        control={
          tailscaleHttpsEndpoint ? (
            <Switch
              checked={tailscaleHttpsEndpoint.status === "available"}
              disabled={isUpdatingTailscaleServe}
              onCheckedChange={(checked) => {
                if (checked) {
                  handleStartTailscaleServeSetup(tailscaleHttpsEndpoint);
                  return;
                }
                handleStartTailscaleServeDisable(tailscaleHttpsEndpoint);
              }}
              aria-label="Enable Tailscale HTTPS"
            />
          ) : null
        }
        managed={tailscaleHttpsEndpoint?.status === "available" ? undefined : remoteClientsDenial}
      />
    );
    const newestPairingLink = visibleDesktopPairingLinks.find(
      (pairingLink) => pairingLink.id === newestPairingLinkId,
    );
    const renderPairingClientsList = (
      pairingLinks: typeof visibleDesktopPairingLinks,
      clientSessions: typeof desktopClientSessions,
    ) => (
      <PairingClientsList
        endpointUrl={desktopServerExposureState?.endpointUrl}
        endpoints={visibleDesktopAdvertisedEndpoints}
        defaultEndpointKey={defaultDesktopAdvertisedEndpointKey}
        isLoading={isLoadingDesktopAccessManagement}
        pairingLinks={pairingLinks}
        createdPairingCredentials={createdPairingCredentials}
        sharedPairingLinkId={newestPairingLinkId}
        clientSessions={clientSessions}
        revokingPairingLinkId={revokingDesktopPairingLinkId}
        revokingClientSessionId={revokingDesktopClientSessionId}
        onRevokePairingLink={handleRevokeDesktopPairingLink}
        onRevokeClientSession={handleRevokeDesktopClientSession}
        canRevoke={canWriteAccess}
      />
    );
    const renderAuthorizedClients = () => (
      <>
        {desktopAccessManagementError ? (
          <div className={ITEM_ROW_CLASSNAME}>
            <p className="text-xs text-destructive">{desktopAccessManagementError}</p>
          </div>
        ) : null}
        {renderPairingClientsList(visibleDesktopPairingLinks, desktopClientSessions)}
      </>
    );
    const renderNetworkAccessRow = () => (
      <SettingsRow
        title={searchableSetting("network-access").title}
        description={
          isLocalBackendNetworkAccessible ? (
            <NetworkAccessDescription
              endpoint={defaultDesktopNetworkAdvertisedEndpoint}
              hiddenEndpointCount={Math.max(visibleDesktopNetworkAdvertisedEndpoints.length - 1, 0)}
              expanded={isAdvertisedEndpointListExpanded}
              onToggleExpanded={() => setIsAdvertisedEndpointListExpanded((expanded) => !expanded)}
              fallback={
                desktopServerExposureState?.endpointUrl
                  ? `Reachable at ${desktopServerExposureState.endpointUrl}`
                  : desktopServerExposureState?.advertisedHost
                    ? `Exposed on all interfaces. Pairing links use ${desktopServerExposureState.advertisedHost}.`
                    : "Exposed on all interfaces."
              }
            />
          ) : desktopServerExposureState ? (
            "Limited to this machine."
          ) : (
            "Loading…"
          )
        }
        status={
          desktopServerExposureError ? (
            <span className="block text-destructive">{desktopServerExposureError}</span>
          ) : null
        }
        control={renderNetworkAccessToggle()}
        managed={isLocalBackendNetworkAccessible ? undefined : remoteClientsDenial}
      />
    );
    const renderDisabledNetworkAccessRow = () => (
      <SettingsRow
        title={searchableSetting("network-access").title}
        description={
          desktopBridge
            ? "This connection cannot view or change network exposure."
            : currentAuthPolicy === "remote-reachable"
              ? "Remote access is already configured. Change network exposure where the server starts."
              : currentAuthPolicy === "loopback-browser"
                ? "Only this machine can connect. Restart with a non-loopback host for remote pairing."
                : "Network exposure information is unavailable."
        }
        control={
          !desktopBridge &&
          (currentAuthPolicy === "remote-reachable" || currentAuthPolicy === "loopback-browser") ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <span className="inline-flex">
                    <Switch
                      checked={isLocalBackendNetworkAccessible}
                      disabled
                      aria-label="Enable network access"
                    />
                  </span>
                }
              />
              <TooltipPopup side="top">
                Network exposure changes restart the backend and must be controlled where the server
                process is launched.
              </TooltipPopup>
            </Tooltip>
          ) : undefined
        }
      />
    );

    const primarySettings = (
      <>
        {primaryEnvironmentId !== null ? (
          <>
            <SettingsSection
              {...searchableSetting("connections-environment")}
              title={
                primaryEnvironment?.label ?? (desktopBridge ? "This machine" : "Primary environment")
              }
              icon={
                <EnvironmentMachineIcon
                  aria-hidden
                  kind={
                    primaryServerConfig
                      ? resolveEnvironmentMachineKind(primaryServerConfig)
                      : "desktop"
                  }
                  className="size-4"
                />
              }
              headerAction={
                primaryEnvironmentId !== null ? (
                  <Menu>
                    <MenuTrigger
                      render={
                        <Button
                          type="button"
                          variant="ghost-muted"
                          size="icon-xs"
                          aria-label="More actions for this machine"
                        />
                      }
                    >
                      <EllipsisIcon className="size-3.5" />
                    </MenuTrigger>
                    <MenuPopup align="end">
                      <EnvironmentIconMenu
                        environmentId={primaryEnvironmentId}
                        serverConfig={primaryServerConfig}
                      />
                    </MenuPopup>
                  </Menu>
                ) : null
              }
            >
              {primaryManagedPolicy ? (
                <div className="px-3 py-2 sm:px-4">
                  <ManagedByOrganization policy={primaryManagedPolicy} />
                </div>
              ) : null}
              {canManageLocalBackend ? (
                <SettingsRow
                  title="Version"
                  description={
                    primaryServerUpdateState.status !== "idle" ? (
                      <ServerUpdateProgress state={primaryServerUpdateState} />
                    ) : (
                      [
                        primaryServerConfig?.environment.serverVersion ?? null,
                        primaryEnvironment?.displayUrl ?? null,
                      ]
                        .filter((value): value is string => value !== null)
                        .join(" · ") || "Loading…"
                    )
                  }
                  control={
                    primaryVersionMismatch &&
                    primaryEnvironmentId !== null &&
                    primaryServerUpdateState.status !== "running" ? (
                      <ServerUpdateAction
                        size="sm"
                        environmentId={primaryEnvironmentId}
                        serverLabel={
                          primaryEnvironment ? `${primaryEnvironment.label} server` : "server"
                        }
                        selfUpdate={resolveServerSelfUpdateCapability(primaryServerConfig)}
                        installation={
                          primaryServerConfig?.environment.capabilities.serverInstallation
                        }
                        desktopAppUpdate={supportsDesktopAppUpdate(primaryServerConfig)}
                        targetVersion={primaryVersionMismatch.clientVersion}
                        label={
                          primaryServerUpdateState.status === "failed"
                            ? "Retry update"
                            : `Update to ${primaryVersionMismatch.clientVersion}`
                        }
                      />
                    ) : primaryServerUpdateState.status === "idle" && primaryServerConfig ? (
                      <LocalVersionStatusLabel />
                    ) : undefined
                  }
                />
              ) : null}
              {canManageLocalBackend && desktopBridge ? (
                <>
                  {renderNetworkAccessRow()}
                  {renderEndpointRows()}
                  {renderTailscaleRow()}
                  {renderWslRow()}
                  {canReadRelay || canManageRelay ? (
                    <CloudLinkRow canReadRelay={canReadRelay} canManageRelay={canManageRelay} />
                  ) : null}
                </>
              ) : canManageLocalBackend ? (
                <>
                  {renderDisabledNetworkAccessRow()}
                  {canReadRelay || canManageRelay ? (
                    <CloudLinkRow canReadRelay={canReadRelay} canManageRelay={canManageRelay} />
                  ) : null}
                </>
              ) : null}
              {primaryEnvironment ? (
                <details className="group px-3 sm:px-4">
                  <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 rounded-md text-sm font-medium outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
                    Permissions
                    <ChevronRightIcon
                      aria-hidden
                      className="size-3 text-muted-foreground group-open:rotate-90"
                    />
                  </summary>
                  <SessionPermissions
                    environmentId={primaryEnvironment.environmentId}
                    connected={primaryEnvironment.connection.phase === "connected"}
                  />
                </details>
              ) : null}
            </SettingsSection>

            {canReadAccess || canWriteAccess ? (
              <FoldedSettingsSection
                id="authorized-clients"
                title="Authorized clients"
                collapsedContent={
                  canReadAccess && newestPairingLink
                    ? renderPairingClientsList([newestPairingLink], [])
                    : undefined
                }
                summary={summarizeAuthorizedClients(
                  desktopClientSessions,
                  visibleDesktopPairingLinks,
                )}
                control={
                  canWriteAccess ? (
                    <AuthorizedClientsHeaderAction
                      delegatableScopes={currentSessionScopes ?? []}
                      onPairingLinkCreated={handlePairingLinkCreated}
                      clientSessions={
                        canReadAccess &&
                        authAccessChanges.error === null &&
                        authAccessChanges.data?.type === "snapshot"
                          ? desktopClientSessions
                          : null
                      }
                      isRevokingOtherClients={isRevokingOtherDesktopClients}
                      onRevokeOtherClients={handleRevokeOtherDesktopClients}
                    />
                  ) : undefined
                }
              >
                <ScrollArea
                  scrollFade
                  chainVerticalScroll
                  className="max-h-[22.5rem]"
                  data-testid="authorized-clients-scroll-area"
                >
                  {canReadAccess ? (
                    renderAuthorizedClients()
                  ) : (
                    <p className="px-4 py-3 text-xs text-muted-foreground">
                      This connection can create access links but cannot view authorized clients.
                    </p>
                  )}
                </ScrollArea>
              </FoldedSettingsSection>
            ) : null}
            <AlertDialog
              open={pendingDesktopServerExposureMode !== null && canManageLocalBackend}
              onOpenChange={(open) => {
                if (!open && !isUpdatingDesktopServerExposure)
                  setPendingDesktopServerExposureMode(null);
              }}
            >
              <AlertDialogPopup>
                <AlertDialogHeader>
                  <AlertDialogTitle>
                    {pendingDesktopServerExposureMode === "network-accessible"
                      ? "Enable network access?"
                      : "Disable network access?"}
                  </AlertDialogTitle>
                  <AlertDialogDescription>
                    {pendingDesktopServerExposureMode === "network-accessible"
                      ? "Let your other devices connect to T3 Code over the network. Pair devices to give them access. T3 Code will restart."
                      : "Devices connected over your local network will disconnect. Existing tunnels, such as T3 Connect or Tailscale HTTPS, keep working. T3 Code will restart."}
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogClose
                    disabled={isUpdatingDesktopServerExposure}
                    render={<Button variant="outline" disabled={isUpdatingDesktopServerExposure} />}
                  >
                    <span className="[text-box:trim-both_cap_alphabetic]">Cancel</span>
                  </AlertDialogClose>
                  <Button
                    variant="default"
                    onClick={handleConfirmDesktopServerExposureChange}
                    disabled={
                      !canManageLocalBackend ||
                      pendingDesktopServerExposureMode === null ||
                      isUpdatingDesktopServerExposure
                    }
                  >
                    {isUpdatingDesktopServerExposure && <Spinner size="sm" />}
                    <span className="[text-box:trim-both_cap_alphabetic]">
                      {isUpdatingDesktopServerExposure
                        ? "Restarting…"
                        : pendingDesktopServerExposureMode === "network-accessible"
                          ? "Restart and enable"
                          : "Restart and disable"}
                    </span>
                  </Button>
                </AlertDialogFooter>
              </AlertDialogPopup>
            </AlertDialog>
            <AlertDialog
              open={isWslConfirmDialogOpen && canManageLocalBackend}
              onOpenChange={(open) => {
                if (isUpdatingWslBackend) return;
                if (!open) setPendingWslChange(null);
              }}
            >
              <AlertDialogPopup>
                <AlertDialogHeader>
                  <AlertDialogTitle>
                    {pendingWslChange?.kind === "disable"
                      ? pendingWslChange.wasWslOnly
                        ? "Turn off WSL and switch back to Windows?"
                        : "Disable WSL backend?"
                      : pendingWslChange?.kind === "distro"
                        ? "Switch WSL distro?"
                        : pendingWslChange?.kind === "enable"
                          ? "Start the WSL backend"
                          : pendingWslChange?.nextValue
                            ? "Run only the WSL backend?"
                            : "Re-enable the Windows backend?"}
                  </AlertDialogTitle>
                  <AlertDialogDescription>
                    {pendingWslChange?.kind === "disable"
                      ? pendingWslChange.wasWslOnly
                        ? "T3 Code will restart on the Windows backend. Threads and projects opened against WSL stay safe inside the distro and become available again when you re-enable WSL."
                        : "The WSL backend will stop. Threads and projects opened against WSL stay safe inside the distro, but they'll be unavailable in T3 Code until you re-enable WSL."
                      : pendingWslChange?.kind === "distro"
                        ? "T3 Code will restart the WSL backend on the new distro. Sessions still running on the current distro will be interrupted."
                        : pendingWslChange?.kind === "enable"
                          ? "Run the WSL backend alongside the Windows one, or stop the Windows backend and use only WSL? You can change this later from Settings."
                          : pendingWslChange?.nextValue
                            ? "T3 Code will restart and start only the WSL backend. Your Windows-side projects won't be accessible until you turn this off again."
                            : "T3 Code will restart and bring the Windows backend back up alongside WSL."}
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogClose
                    disabled={isUpdatingWslBackend}
                    render={<Button variant="outline" disabled={isUpdatingWslBackend} />}
                  >
                    Cancel
                  </AlertDialogClose>
                  {pendingWslChange?.kind === "enable" ? (
                    <>
                      <Button
                        variant="outline"
                        onClick={() => handleConfirmEnableWsl("wsl-only")}
                        disabled={isUpdatingWslBackend || !canManageLocalBackend}
                      >
                        {isUpdatingWslBackend ? (
                          <>
                            <Spinner size="sm" />
                            Applying…
                          </>
                        ) : (
                          "Use only WSL"
                        )}
                      </Button>
                      <Button
                        variant="default"
                        onClick={() => handleConfirmEnableWsl("both")}
                        disabled={isUpdatingWslBackend || !canManageLocalBackend}
                      >
                        {isUpdatingWslBackend ? (
                          <>
                            <Spinner size="sm" />
                            Applying…
                          </>
                        ) : (
                          "Run both backends"
                        )}
                      </Button>
                    </>
                  ) : (
                    <Button
                      variant={
                        pendingWslChange?.kind === "disable" ||
                        (pendingWslChange?.kind === "wsl-only" && pendingWslChange.nextValue)
                          ? "destructive"
                          : "default"
                      }
                      onClick={handleConfirmWslChange}
                      disabled={isUpdatingWslBackend || !canManageLocalBackend}
                    >
                      {isUpdatingWslBackend ? (
                        <>
                          <Spinner size="sm" />
                          Applying…
                        </>
                      ) : pendingWslChange?.kind === "disable" ? (
                        pendingWslChange.wasWslOnly ? (
                          "Switch to Windows"
                        ) : (
                          "Disable WSL"
                        )
                      ) : pendingWslChange?.kind === "distro" ? (
                        "Switch distro"
                      ) : pendingWslChange?.nextValue ? (
                        "Restart and enable"
                      ) : (
                        "Restart and disable"
                      )}
                    </Button>
                  )}
                </AlertDialogFooter>
              </AlertDialogPopup>
            </AlertDialog>
            <AlertDialog
              open={disableTailscaleServeDialogOpen && canManageLocalBackend}
              onOpenChange={(open) => {
                if (isUpdatingTailscaleServe) return;
                setDisableTailscaleServeDialogOpen(open);
              }}
            >
              <AlertDialogPopup>
                <AlertDialogHeader>
                  <AlertDialogTitle>Disable Tailscale HTTPS?</AlertDialogTitle>
                  <AlertDialogDescription>
                    T3 Code will restart the local backend without Tailscale Serve.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogClose
                    disabled={isUpdatingTailscaleServe}
                    render={<Button variant="outline" disabled={isUpdatingTailscaleServe} />}
                  >
                    Cancel
                  </AlertDialogClose>
                  <Button
                    variant="destructive"
                    onClick={() => void handleConfirmTailscaleServeDisable()}
                    disabled={isUpdatingTailscaleServe || !canManageLocalBackend}
                  >
                    {isUpdatingTailscaleServe ? (
                      <>
                        <Spinner size="sm" />
                        Restarting…
                      </>
                    ) : (
                      "Restart and disable"
                    )}
                  </Button>
                </AlertDialogFooter>
              </AlertDialogPopup>
            </AlertDialog>
            <Dialog
              open={pendingTailscaleServeEndpoint !== null}
              onOpenChange={(open) => {
                if (isUpdatingTailscaleServe) return;
                if (!open) setPendingTailscaleServeEndpoint(null);
              }}
            >
              <DialogPopup className="max-w-md">
                <DialogHeader>
                  <DialogTitle>Set up Tailscale HTTPS?</DialogTitle>
                  <DialogDescription>
                    T3 Code will restart the local backend with Tailscale Serve enabled and ask
                    Tailscale to proxy HTTPS traffic to this backend.
                  </DialogDescription>
                </DialogHeader>
                <DialogPanel>
                  <label className="block">
                    <span className="text-sm font-medium text-foreground">HTTPS port</span>
                    <Input
                      className="mt-2"
                      type="number"
                      inputMode="numeric"
                      min={1}
                      max={65_535}
                      step={1}
                      value={tailscaleServePortInput}
                      onChange={(event) => setTailscaleServePortInput(event.target.value)}
                      disabled={isUpdatingTailscaleServe}
                    />
                  </label>
                  {!isTailscaleServePortValid ? (
                    <p className="mt-2 text-xs text-destructive">Enter a port from 1 to 65535.</p>
                  ) : null}
                  <div className="rounded-md border border-border/70 bg-muted/20 px-3 py-2">
                    <p className="text-xs font-medium text-muted-foreground">HTTPS endpoint</p>
                    <Tooltip>
                      <TooltipTrigger
                        render={
                          <p className="mt-1 truncate text-sm text-foreground">
                            {pendingTailscaleServeBaseUrl ?? "Pending MagicDNS endpoint"}
                          </p>
                        }
                      />
                      {pendingTailscaleServeBaseUrl ? (
                        <TooltipPopup side="top">{pendingTailscaleServeBaseUrl}</TooltipPopup>
                      ) : null}
                    </Tooltip>
                  </div>
                </DialogPanel>
                <DialogFooter>
                  <DialogClose
                    disabled={isUpdatingTailscaleServe}
                    render={<Button variant="outline" disabled={isUpdatingTailscaleServe} />}
                  >
                    Cancel
                  </DialogClose>
                  <Button
                    onClick={() => void handleConfirmTailscaleServeSetup()}
                    disabled={isUpdatingTailscaleServe || !isTailscaleServePortValid}
                  >
                    {isUpdatingTailscaleServe ? (
                      <>
                        <Spinner size="sm" />
                        Restarting…
                      </>
                    ) : (
                      "Enable"
                    )}
                  </Button>
                </DialogFooter>
              </DialogPopup>
            </Dialog>
          </>
        ) : (
          <SettingsSection {...searchableSetting("connections-environment")}>
            <SettingsRow
              title="No environment selected"
              description="Connect an environment to view its settings and access."
            />
            {canReadRelay || canManageRelay ? (
              <CloudLinkRow canReadRelay={canReadRelay} canManageRelay={canManageRelay} />
            ) : null}
          </SettingsSection>
        )}
      </>
    );

  return { primarySettings };
}
