import { SessionPermissions } from "./SessionPermissions";
import { ChevronRightIcon, EllipsisIcon } from "lucide-react";
import { useAtomValue } from "@effect/atom-react";
import { type ReactNode, useState } from "react";
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
import {
  isAtomCommandInterrupted,
  settlePromise,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import * as Cause from "effect/Cause";

import { isLocalEnvironmentDisabled } from "../../localEnvironment";
import { useT } from "../../hooks/useI18n";
import {
  applyWslEnableSelection,
  isWslSettingsRowVisible,
  missingTailscaleEndpointDescription,
  resolveAccessEnvironmentId,
  resolveLocalVersionStatusLabel,
  resolveTailscaleServeBaseUrl,
} from "./ConnectionsSettings.logic";
import { settingsScopeEnvironmentLabel } from "./settingsScopeAxis";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";
import { ManagedByOrganization } from "../ManagedPolicy";
import { LocalEnvironmentSetting } from "./LocalEnvironmentSetting";
import { searchableSetting } from "./settingsSearch";
import { EnvironmentIconMenu } from "./EnvironmentIconPicker";
import { FoldedSettingsSection } from "./FoldedSettingsSection";
import { LinkedEnvironmentsSettings } from "./LinkedEnvironmentsSettings";
import { usePeerLinkHosts } from "~/state/peerLinks";
import { LoadBalancingSettings } from "./LoadBalancingSettings";
import { PullRequestRoutingSettings } from "./PullRequestRoutingSettings";
import { Input } from "../ui/input";
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
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Menu, MenuPopup, MenuTrigger } from "../ui/menu";
import { Switch } from "../ui/switch";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { Button } from "../ui/button";
import { EnvironmentMachineIcon } from "../EnvironmentMachineIcon";
import { type ServerClientSessionRecord } from "~/environments/primary";
import { isDesktopLocalConnectionTarget } from "~/connection/desktopLocal";
import { useUiStateStore } from "~/uiStateStore";
import {
  resolveServerConfigVersionMismatch,
  resolveServerSelfUpdateCapability,
  supportsDesktopAppUpdate,
} from "~/versionSkew";
import { hasCloudPublicConfig } from "~/cloud/publicConfig";
import { RemoveT3ConnectEnvironmentDialog } from "../clerk/RemoveT3ConnectEnvironmentDialog";
import { authEnvironment } from "~/state/auth";
import { environmentCatalog } from "~/connection/catalog";
import {
  readEnvironmentScope,
  useEnvironmentScope,
  useEnvironmentSessionState,
} from "~/state/session";
import { useEnvironmentQuery } from "~/state/query";
import {
  desktopNetworkAccessStateAtom,
  refreshDesktopNetworkAccessState,
} from "~/state/desktopNetworkAccess";
import { desktopWslStateAtom, refreshDesktopWslState } from "~/state/desktopWslState";
import { useDesktopUpdateState } from "~/state/desktopUpdate";
import {
  type EnvironmentPresentation,
  useEnvironment,
  useEnvironments,
  usePrimaryEnvironment,
  usePrimaryEnvironmentId,
} from "~/state/environments";
import { requestConfirmDialog } from "~/confirmDialog";
import { useAtomCommand } from "../../state/use-atom-command";
import { environmentIdsKey } from "~/state/environmentAtomList";
import { environmentUpdateStatesAtom, serverEnvironment } from "~/state/server";
import {
  ServerUpdateAction,
  ServerUpdateProgress,
  ServerUpdatesAction,
  type ServerUpdateTarget,
} from "../ServerUpdateAction";
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
import { ITEM_ROW_CLASSNAME } from "./itemRows";
import {
  CloudLinkRow,
  CloudRemoteEnvironmentRows,
  SavedBackendListRow,
} from "./SavedEnvironmentRows";
import { AddEnvironmentDialog } from "./AddEnvironmentDialog";

const DEFAULT_TAILSCALE_SERVE_PORT = 443;
const EMPTY_ADVERTISED_ENDPOINTS: ReadonlyArray<AdvertisedEndpoint> = [];

// Colons are invalid in distro names, keeping picker sentinels collision-free.
const BACKEND_VALUE_DEFAULT_WSL = "backend:default-wsl";
const BACKEND_VALUE_WSL_OFF = "backend:wsl-off";

// Subscribes on its own so desktop download progress does not re-render the page.
function LocalVersionStatusLabel() {
  const t = useT();
  const updateState = useDesktopUpdateState();
  return (
    <span className="text-xs text-muted-foreground">
      {resolveLocalVersionStatusLabel(updateState, t)}
    </span>
  );
}

/** Environments lists the machines this app connects to; access covers who may reach one of them. */
export function ConnectionsSettings({ view }: { readonly view: "environments" | "access" }) {
  return view === "access" ? (
    <AccessSettings />
  ) : (
    <ConnectionsSettingsContent view="environments" accessEnvironmentId={null} />
  );
}

function AccessSettings() {
  const { environments } = useEnvironments();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const [selectedEnvironmentId, setSelectedEnvironmentId] = useState<EnvironmentId | null>(null);
  const candidates = environments.filter(
    (environment) =>
      environment.environmentId === primaryEnvironmentId ||
      (environment.entry.enabled && !isDesktopLocalConnectionTarget(environment.entry.target)),
  );
  const accessEnvironmentId = resolveAccessEnvironmentId({
    primaryEnvironmentId,
    environments: candidates.map((environment) => ({
      environmentId: environment.environmentId,
      connected: environment.connection.phase === "connected",
    })),
    selected: selectedEnvironmentId,
  });
  const picker =
    candidates.length > 1 && accessEnvironmentId !== null ? (
      <div className="flex min-w-0 items-center gap-1.5 px-3 text-sm text-muted-foreground sm:px-4">
        <span className="shrink-0">Showing access for</span>
        <Select
          value={accessEnvironmentId}
          onValueChange={(next) => {
            if (next !== null) setSelectedEnvironmentId(next);
          }}
        >
          <SelectTrigger size="sm" className="w-auto max-w-72" aria-label="Environment">
            <SelectValue>
              {(value: EnvironmentId) => {
                const environment = candidates.find(
                  (candidate) => candidate.environmentId === value,
                );
                return environment ? settingsScopeEnvironmentLabel(environment, candidates) : null;
              }}
            </SelectValue>
          </SelectTrigger>
          <SelectPopup alignItemWithTrigger={false}>
            {candidates.map((environment) => (
              <SelectItem
                hideIndicator
                key={environment.environmentId}
                value={environment.environmentId}
              >
                <span className="flex min-w-0 items-center gap-2">
                  <EnvironmentMachineIcon
                    aria-hidden
                    kind={resolveEnvironmentMachineKind(environment.serverConfig)}
                    className="size-3.5 shrink-0"
                  />
                  <span className="min-w-0 truncate">
                    {settingsScopeEnvironmentLabel(environment, candidates)}
                  </span>
                  {environment.connection.phase !== "connected" ? (
                    <span className="shrink-0 text-xs text-muted-foreground">Offline</span>
                  ) : null}
                </span>
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      </div>
    ) : null;
  // Keyed so pairing credentials and pending work never carry over to another environment.
  return (
    <ConnectionsSettingsContent
      key={accessEnvironmentId ?? "none"}
      view="access"
      accessEnvironmentId={accessEnvironmentId}
      accessEnvironmentPicker={picker}
    />
  );
}

function ConnectionsSettingsContent({
  view,
  accessEnvironmentId,
  accessEnvironmentPicker = null,
}: {
  readonly view: "environments" | "access";
  readonly accessEnvironmentId: EnvironmentId | null;
  readonly accessEnvironmentPicker?: ReactNode;
}) {
  const t = useT();
  const desktopBridge = window.desktopBridge;
  const { environments } = useEnvironments();
  const primaryEnvironment = usePrimaryEnvironment();
  const peerLinkHosts = usePeerLinkHosts();
  const removeEnvironment = useAtomCommand(environmentCatalog.remove, { reportFailure: false });
  const setEnvironmentEnabled = useAtomCommand(environmentCatalog.setEnabled, {
    reportFailure: false,
  });
  const primaryEnvironmentId = primaryEnvironment?.environmentId ?? null;
  const accessEnvironment = useEnvironment(accessEnvironmentId);
  // Desktop network, Tailscale, and WSL controls change the backend this app spawned.
  const isPrimaryAccess =
    accessEnvironmentId !== null && accessEnvironmentId === primaryEnvironmentId;
  const accessSessionState = useEnvironmentSessionState(accessEnvironmentId);
  const currentSessionScopes = accessSessionState.data?.authenticated
    ? (accessSessionState.data.permissions ?? accessSessionState.data.scopes ?? null)
    : null;
  const currentAuthPolicy = desktopBridge ? null : (accessSessionState.data?.auth.policy ?? null);
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
  // Turning remote access off stays possible; only the way in is managed.
  const remoteClientsDenial = managedCapabilityDenial(
    primaryServerConfig?.managedPolicy,
    "remoteClients",
  );
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
  const canReadAccess = useEnvironmentScope(accessEnvironmentId, AuthAccessReadScope);
  const canWriteAccess = useEnvironmentScope(accessEnvironmentId, AuthAccessWriteScope);
  const canReadRelay = useEnvironmentScope(accessEnvironmentId, AuthRelayReadScope);
  const canMaintain = useEnvironmentScope(accessEnvironmentId, AuthEnvironmentMaintainScope);
  const canManageRelay = useEnvironmentScope(accessEnvironmentId, AuthRelayWriteScope);
  const canManageLocalBackend = isPrimaryAccess && !isLocalEnvironmentDisabled() && canMaintain;
  const showsAccess = view === "access";
  const authAccessChanges = useEnvironmentQuery(
    showsAccess && canReadAccess && accessEnvironmentId !== null
      ? authEnvironment.accessChanges({
          environmentId: accessEnvironmentId,
          input: null,
        })
      : null,
  );
  const revokePairingLink = useAtomCommand(authEnvironment.revokePairingLink, {
    reportFailure: false,
  });
  const revokeClient = useAtomCommand(authEnvironment.revokeClient, { reportFailure: false });
  const revokeOtherClients = useAtomCommand(authEnvironment.revokeOtherClients, {
    reportFailure: false,
  });
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
      const message =
        error instanceof Error
          ? error.message
          : t("settings.system.connections.updateNetworkFailed");
      setPendingDesktopServerExposureMode(null);
      setDesktopServerExposureMutationError(message);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: t("settings.system.connections.updateNetworkFailedTitle"),
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
        error instanceof Error
          ? error.message
          : t("settings.system.connections.tailscaleSetupFailed");
      setDesktopServerExposureMutationError(message);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: t("settings.system.connections.tailscaleSetupFailedTitle"),
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
      const message =
        error instanceof Error
          ? error.message
          : t("settings.system.connections.tailscaleDisableFailed");
      setDesktopServerExposureMutationError(message);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: t("settings.system.connections.tailscaleDisableFailedTitle"),
          description: message,
        }),
      );
    }
    setIsUpdatingTailscaleServe(false);
  };

  const handleStartTailscaleServeDisable = (_endpoint: AdvertisedEndpoint) => {
    setDisableTailscaleServeDialogOpen(true);
  };

  const handleRevokeDesktopPairingLink = async (id: string) => {
    if (
      accessEnvironmentId === null ||
      !readEnvironmentScope(accessEnvironmentId, AuthAccessWriteScope)
    )
      return;
    setRevokingDesktopPairingLinkId(id);
    setDesktopAccessManagementMutationError(null);
    const result = await revokePairingLink({ environmentId: accessEnvironmentId, input: { id } });
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      const message =
        error instanceof Error ? error.message : t("settings.system.connections.revokeLinkFailed");
      setDesktopAccessManagementMutationError(message);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: t("settings.system.connections.revokeLinkFailedTitle"),
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
      accessEnvironmentId === null ||
      !readEnvironmentScope(accessEnvironmentId, AuthAccessWriteScope)
    )
      return;
    setRevokingDesktopClientSessionId(sessionId);
    setDesktopAccessManagementMutationError(null);
    const result = await revokeClient({ environmentId: accessEnvironmentId, input: { sessionId } });
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      const message =
        error instanceof Error
          ? error.message
          : t("settings.system.connections.revokeAccessFailed");
      setDesktopAccessManagementMutationError(message);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: t("settings.system.connections.revokeAccessFailedTitle"),
          description: message,
        }),
      );
    }
    setRevokingDesktopClientSessionId(null);
  };

  const handleRevokeOtherDesktopClients = async () => {
    if (
      accessEnvironmentId === null ||
      !readEnvironmentScope(accessEnvironmentId, AuthAccessWriteScope)
    )
      return;
    setIsRevokingOtherDesktopClients(true);
    setDesktopAccessManagementMutationError(null);
    const result = await revokeOtherClients({ environmentId: accessEnvironmentId, input: null });
    if (result._tag === "Success") {
      toastManager.add({
        type: "success",
        title:
          result.value === 1
            ? t("settings.system.connections.revokedOneClient")
            : t("settings.system.connections.revokedClients", {
                count: String(result.value),
              }),
        description: t("settings.system.connections.revokedClientsBody"),
      });
    } else if (!isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      const message = error instanceof Error ? error.message : "Failed to revoke other clients.";
      setDesktopAccessManagementMutationError(message);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: t("settings.system.connections.revokeOthersFailedTitle"),
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
          : enabled
            ? t("settings.system.connections.switchBackendOnFailed")
            : t("settings.system.connections.switchBackendOffFailed");
      setSavedBackendError(message);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: enabled
            ? t("settings.system.connections.switchBackendOnFailedTitle")
            : t("settings.system.connections.switchBackendOffFailedTitle"),
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
      const message =
        error instanceof Error
          ? error.message
          : t("settings.system.connections.removeBackendFailed");
      setSavedBackendError(message);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: t("settings.system.connections.removeBackendFailedTitle"),
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
      t("settings.system.connections.removeFromDeviceConfirm", { label: environment.label }),
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
      aria-label={t("settings.system.connections.enableNetworkAccessAria")}
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
      const message =
        error instanceof Error ? error.message : t("settings.system.connections.updateWslFailed");
      setDesktopWslMutationError(message);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: t("settings.system.connections.updateWslFailedTitle"),
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

  const renderWslRow = () => {
    if (!desktopWslState) {
      if (
        isWslSettingsRowVisible({ state: null, error: desktopWslError }) &&
        canManageLocalBackend
      ) {
        return (
          <SettingsRow
            {...searchableSetting("wsl-backend")}
            description={t("settings.system.connections.wslLoadFailed")}
            status={<span className="block text-destructive">{desktopWslError}</span>}
            control={
              <Button
                size="sm"
                variant="outline"
                onClick={loadWslState}
                disabled={isLoadingWslState}
              >
                {isLoadingWslState
                  ? t("settings.system.connections.retrying")
                  : t("misc.common.retry")}
              </Button>
            }
          />
        );
      }
      return null;
    }
    if (!isWslSettingsRowVisible({ state: desktopWslState, error: desktopWslError })) {
      return null;
    }
    if (!desktopWslState.available) {
      return (
        <SettingsRow
          {...searchableSetting("wsl-backend")}
          description={t("settings.system.connections.wslUnavailable")}
          status={
            desktopWslError ? (
              <span className="block text-destructive">{desktopWslError}</span>
            ) : null
          }
          control={
            <Button
              size="sm"
              variant="outline"
              disabled={isUpdatingWslBackend}
              onClick={() => handleSelectWslMode(BACKEND_VALUE_WSL_OFF)}
            >
              {t("settings.system.connections.switchToWindows")}
            </Button>
          }
        />
      );
    }
    const defaultDistroName =
      desktopWslState.distros.find((distro) => distro.isDefault)?.name ?? null;
    const selectValue = !desktopWslState.enabled
      ? BACKEND_VALUE_WSL_OFF
      : (desktopWslState.distro ?? defaultDistroName ?? BACKEND_VALUE_DEFAULT_WSL);
    const selectLabel =
      selectValue === BACKEND_VALUE_WSL_OFF
        ? t("settings.system.inh.off")
        : selectValue === BACKEND_VALUE_DEFAULT_WSL
          ? t("settings.system.connections.defaultDistro")
          : selectValue;
    return (
      <>
        <SettingsRow
          {...searchableSetting("wsl-backend")}
          description={t("settings.system.connections.wslDescription")}
          status={
            desktopWslError ? (
              <span className="block text-destructive">{desktopWslError}</span>
            ) : desktopWslState.preflightError ? (
              <span className="block text-destructive">
                {t("settings.system.connections.wslStartFailed", {
                  error: desktopWslState.preflightError,
                })}
              </span>
            ) : null
          }
          control={
            <Select
              value={selectValue}
              onValueChange={(value) => {
                if (typeof value !== "string") return;
                handleSelectWslMode(value);
              }}
            >
              <SelectTrigger
                size="sm"
                className="w-full sm:w-56"
                aria-label={t("settings.system.connections.wslBackendAria")}
                disabled={isUpdatingWslBackend}
              >
                <SelectValue>{selectLabel}</SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                <SelectItem hideIndicator value={BACKEND_VALUE_WSL_OFF}>
                  {t("settings.system.inh.off")}
                </SelectItem>
                {desktopWslState.distros.length === 0 ? (
                  <SelectItem hideIndicator value={BACKEND_VALUE_DEFAULT_WSL}>
                    {t("settings.system.connections.defaultDistro")}
                  </SelectItem>
                ) : (
                  desktopWslState.distros.map((distro) => (
                    <SelectItem hideIndicator key={distro.name} value={distro.name}>
                      {distro.name}
                      {distro.isDefault ? t("settings.system.connections.distroDefaultSuffix") : ""}
                    </SelectItem>
                  ))
                )}
              </SelectPopup>
            </Select>
          }
        />
        {desktopWslState.enabled ? (
          <SettingsRow
            title={t("settings.system.connections.wslOnlyTitle")}
            description={t("settings.system.connections.wslOnlyDescription")}
            className="bg-muted/20 pl-7 sm:pl-8"
            control={
              <Switch
                checked={desktopWslState.wslOnly}
                disabled={isUpdatingWslBackend}
                onCheckedChange={(checked) => handleToggleWslOnly(checked)}
                aria-label={t("settings.system.connections.runWslOnlyAria")}
              />
            }
          />
        ) : null}
      </>
    );
  };

  const renderTailscaleRow = () => (
    <SettingsRow
      title={searchableSetting("tailscale-https").title}
      description={
        tailscaleHttpsEndpoint
          ? tailscaleHttpsEndpoint.status === "available"
            ? tailscaleHttpsEndpoint.httpBaseUrl
            : t("settings.system.connections.tailscaleServeDescription")
          : missingTailscaleEndpointDescription(desktopServerExposureState, t)
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
            aria-label={t("settings.system.connections.enableTailscaleHttpsAria")}
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
      servedByEnvironment={isPrimaryAccess}
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
      title={t("settings.system.connections.networkAccessTitle")}
      description={
        isLocalBackendNetworkAccessible ? (
          <NetworkAccessDescription
            endpoint={defaultDesktopNetworkAdvertisedEndpoint}
            hiddenEndpointCount={Math.max(visibleDesktopNetworkAdvertisedEndpoints.length - 1, 0)}
            expanded={isAdvertisedEndpointListExpanded}
            onToggleExpanded={() => setIsAdvertisedEndpointListExpanded((expanded) => !expanded)}
            fallback={
              desktopServerExposureState?.endpointUrl
                ? t("settings.system.connections.reachableAt", {
                    url: desktopServerExposureState.endpointUrl,
                  })
                : desktopServerExposureState?.advertisedHost
                  ? t("settings.system.connections.exposedOnAllWithHost", {
                      host: desktopServerExposureState.advertisedHost,
                    })
                  : t("settings.system.connections.exposedOnAll")
            }
          />
        ) : desktopServerExposureState ? (
          t("settings.system.connections.limitedToThisMachine")
        ) : (
          t("settings.system.connections.loading")
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
      title={t("settings.system.connections.networkAccessTitle")}
      description={
        desktopBridge
          ? t("settings.system.connections.cannotViewExposure")
          : currentAuthPolicy === "remote-reachable"
            ? t("settings.system.connections.remoteAccessConfigured")
            : currentAuthPolicy === "loopback-browser"
              ? t("settings.system.connections.loopbackOnly")
              : t("settings.system.connections.exposureUnavailable")
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
                    aria-label={t("settings.system.connections.enableNetworkAccessAria")}
                  />
                </span>
              }
            />
            <TooltipPopup side="top">
              {t("settings.system.connections.exposureTooltip")}
            </TooltipPopup>
          </Tooltip>
        ) : undefined
      }
    />
  );

  const accessServerConfig = accessEnvironment?.serverConfig ?? null;
  const primarySettings = (
    <>
      {accessEnvironmentPicker}
      {accessEnvironmentId !== null ? (
        <>
          <SettingsSection
            {...searchableSetting("connections-environment")}
            title={
              primaryEnvironment?.label ??
              (desktopBridge
                ? t("settings.system.envRow.thisMachine")
                : t("settings.system.connections.primaryEnvironment"))
            }
            icon={
              <EnvironmentMachineIcon
                aria-hidden
                kind={
                  accessServerConfig ? resolveEnvironmentMachineKind(accessServerConfig) : "desktop"
                }
                className="size-4"
              />
            }
            headerAction={
              accessEnvironmentId !== null ? (
                <Menu>
                  <MenuTrigger
                    render={
                      <Button
                        type="button"
                        variant="ghost-muted"
                        size="icon-xs"
                        aria-label={t("settings.system.connections.moreActionsAria")}
                      />
                    }
                  >
                    <EllipsisIcon className="size-3.5" />
                  </MenuTrigger>
                  <MenuPopup align="end">
                    <EnvironmentIconMenu
                      environmentId={accessEnvironmentId}
                      serverConfig={accessServerConfig}
                    />
                  </MenuPopup>
                </Menu>
              ) : null
            }
          >
            {accessServerConfig?.managedPolicy ? (
              <div className="px-3 py-2 sm:px-4">
                <ManagedByOrganization policy={accessServerConfig.managedPolicy} />
              </div>
            ) : null}
            {canManageLocalBackend ? (
              <SettingsRow
                title={t("settings.system.about.version")}
                description={
                  primaryServerUpdateState.status !== "idle" ? (
                    <ServerUpdateProgress state={primaryServerUpdateState} />
                  ) : (
                    [
                      primaryServerConfig?.environment.serverVersion ?? null,
                      primaryEnvironment?.displayUrl ?? null,
                    ]
                      .filter((value): value is string => value !== null)
                      .join(" · ") || t("settings.system.connections.loading")
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
                        primaryEnvironment
                          ? t("settings.system.connections.serverLabel", {
                              label: primaryEnvironment.label,
                            })
                          : t("settings.system.connections.serverFallback")
                      }
                      selfUpdate={resolveServerSelfUpdateCapability(primaryServerConfig)}
                      installation={
                        primaryServerConfig?.environment.capabilities.serverInstallation
                      }
                      desktopAppUpdate={supportsDesktopAppUpdate(primaryServerConfig)}
                      targetVersion={primaryVersionMismatch.clientVersion}
                      label={
                        primaryServerUpdateState.status === "failed"
                          ? t("settings.system.connections.retryUpdate")
                          : t("settings.system.connections.updateToVersion", {
                              version: primaryVersionMismatch.clientVersion,
                            })
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
              </>
            ) : canManageLocalBackend ? (
              renderDisabledNetworkAccessRow()
            ) : null}
            {canReadRelay || canManageRelay ? (
              <CloudLinkRow
                environmentId={accessEnvironmentId}
                canReadRelay={canReadRelay}
                canManageRelay={canManageRelay}
              />
            ) : null}
            {accessEnvironment ? (
              <details className="group px-3 sm:px-4">
                <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 rounded-md text-sm font-medium outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
                  {t("settings.system.connections.permissions")}
                  <ChevronRightIcon
                    aria-hidden
                    className="size-3 text-muted-foreground group-open:rotate-90"
                  />
                </summary>
                <SessionPermissions
                  environmentId={accessEnvironment.environmentId}
                  connected={accessEnvironment.connection.phase === "connected"}
                />
              </details>
            ) : null}
          </SettingsSection>

          {canReadAccess || canWriteAccess ? (
            <FoldedSettingsSection
              id="authorized-clients"
              title={t("settings.system.connections.authorizedClientsTitle")}
              collapsedContent={
                canReadAccess && newestPairingLink
                  ? renderPairingClientsList([newestPairingLink], [])
                  : undefined
              }
              summary={summarizeAuthorizedClients(
                desktopClientSessions,
                visibleDesktopPairingLinks,
                t,
              )}
              control={
                canWriteAccess ? (
                  <AuthorizedClientsHeaderAction
                    environmentId={accessEnvironmentId}
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
                    {t("settings.system.connections.cannotViewAuthorizedClients")}
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
                    ? t("settings.system.connections.enableNetworkAccessTitle")
                    : t("settings.system.connections.disableNetworkAccessTitle")}
                </AlertDialogTitle>
                <AlertDialogDescription>
                  {pendingDesktopServerExposureMode === "network-accessible"
                    ? t("settings.system.connections.enableNetworkAccessBody")
                    : t("settings.system.connections.disableNetworkAccessBody")}
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogClose
                  disabled={isUpdatingDesktopServerExposure}
                  render={<Button variant="outline" disabled={isUpdatingDesktopServerExposure} />}
                >
                  <span className="[text-box:trim-both_cap_alphabetic]">
                    {t("misc.common.cancel")}
                  </span>
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
                      ? t("settings.system.localEnv.restarting")
                      : pendingDesktopServerExposureMode === "network-accessible"
                        ? t("settings.system.connections.restartAndEnable")
                        : t("settings.system.connections.restartAndDisable")}
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
                      ? t("settings.system.connections.wslTurnOffTitle")
                      : t("settings.system.connections.wslDisableTitle")
                    : pendingWslChange?.kind === "distro"
                      ? t("settings.system.connections.wslSwitchDistroTitle")
                      : pendingWslChange?.kind === "enable"
                        ? t("settings.system.connections.wslStartTitle")
                        : pendingWslChange?.nextValue
                          ? t("settings.system.connections.wslOnlyQuestion")
                          : t("settings.system.connections.wslReenableWindowsTitle")}
                </AlertDialogTitle>
                <AlertDialogDescription>
                  {pendingWslChange?.kind === "disable"
                    ? pendingWslChange.wasWslOnly
                      ? t("settings.system.connections.wslTurnOffBody")
                      : t("settings.system.connections.wslDisableBody")
                    : pendingWslChange?.kind === "distro"
                      ? t("settings.system.connections.wslSwitchDistroBody")
                      : pendingWslChange?.kind === "enable"
                        ? t("settings.system.connections.wslStartBody")
                        : pendingWslChange?.nextValue
                          ? t("settings.system.connections.wslOnlyBody")
                          : t("settings.system.connections.wslReenableWindowsBody")}
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogClose
                  disabled={isUpdatingWslBackend}
                  render={<Button variant="outline" disabled={isUpdatingWslBackend} />}
                >
                  {t("misc.common.cancel")}
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
                          {t("settings.system.connections.applying")}
                        </>
                      ) : (
                        t("settings.system.connections.useOnlyWsl")
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
                          {t("settings.system.connections.applying")}
                        </>
                      ) : (
                        t("settings.system.connections.runBothBackends")
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
                        {t("settings.system.connections.applying")}
                      </>
                    ) : pendingWslChange?.kind === "disable" ? (
                      pendingWslChange.wasWslOnly ? (
                        t("settings.system.connections.switchToWindows")
                      ) : (
                        t("settings.system.connections.disableWsl")
                      )
                    ) : pendingWslChange?.kind === "distro" ? (
                      t("settings.system.connections.switchDistro")
                    ) : pendingWslChange?.nextValue ? (
                      t("settings.system.connections.restartAndEnable")
                    ) : (
                      t("settings.system.connections.restartAndDisable")
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
                <AlertDialogTitle>
                  {t("settings.system.connections.disableTailscaleTitle")}
                </AlertDialogTitle>
                <AlertDialogDescription>
                  {t("settings.system.connections.disableTailscaleBody")}
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogClose
                  disabled={isUpdatingTailscaleServe}
                  render={<Button variant="outline" disabled={isUpdatingTailscaleServe} />}
                >
                  {t("misc.common.cancel")}
                </AlertDialogClose>
                <Button
                  variant="destructive"
                  onClick={() => void handleConfirmTailscaleServeDisable()}
                  disabled={isUpdatingTailscaleServe || !canManageLocalBackend}
                >
                  {isUpdatingTailscaleServe ? (
                    <>
                      <Spinner size="sm" />
                      {t("settings.system.localEnv.restarting")}
                    </>
                  ) : (
                    t("settings.system.connections.restartAndDisable")
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
                <DialogTitle>{t("settings.system.connections.setupTailscaleTitle")}</DialogTitle>
                <DialogDescription>
                  {t("settings.system.connections.setupTailscaleBody")}
                </DialogDescription>
              </DialogHeader>
              <DialogPanel>
                <label className="block">
                  <span className="text-sm font-medium text-foreground">
                    {t("settings.system.connections.httpsPort")}
                  </span>
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
                  <p className="mt-2 text-xs text-destructive">
                    {t("settings.system.connections.portRange")}
                  </p>
                ) : null}
                <div className="rounded-md border border-border/70 bg-muted/20 px-3 py-2">
                  <p className="text-xs font-medium text-muted-foreground">
                    {t("settings.system.connections.httpsEndpoint")}
                  </p>
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <p className="mt-1 truncate text-sm text-foreground">
                          {pendingTailscaleServeBaseUrl ??
                            t("settings.system.connections.pendingMagicDnsEndpoint")}
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
                  {t("misc.common.cancel")}
                </DialogClose>
                <Button
                  onClick={() => void handleConfirmTailscaleServeSetup()}
                  disabled={isUpdatingTailscaleServe || !isTailscaleServePortValid}
                >
                  {isUpdatingTailscaleServe ? (
                    <>
                      <Spinner size="sm" />
                      {t("settings.system.localEnv.restarting")}
                    </>
                  ) : (
                    t("settings.system.connections.enable")
                  )}
                </Button>
              </DialogFooter>
            </DialogPopup>
          </Dialog>
        </>
      ) : (
        <SettingsSection {...searchableSetting("connections-environment")}>
          <SettingsRow
            title={t("settings.system.connections.noEnvironmentTitle")}
            description={t("settings.system.connections.connectToViewSettings")}
          />
        </SettingsSection>
      )}
    </>
  );

  if (showsAccess) return <SettingsPageContainer>{primarySettings}</SettingsPageContainer>;

  return (
    <SettingsPageContainer>
      {desktopBridge ? (
        <SettingsSection id="this-app" title={t("settings.system.connections.thisApp")}>
          <LocalEnvironmentSetting />
        </SettingsSection>
      ) : null}
      <SettingsSection
        {...searchableSetting("remote-environments")}
        title={t("settings.system.connections.environments")}
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
