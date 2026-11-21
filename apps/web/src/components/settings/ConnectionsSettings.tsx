import { errorDisplayMessage, thrownErrorMessage } from "@t3tools/client-runtime/errors";
import { m as resolveMessage } from "~/i18n/messages";
import { managedCapabilityDenial } from "@t3tools/client-runtime/contract-labels";
import { SessionPermissions } from "./SessionPermissions";
import { useSearch } from "@tanstack/react-router";
import { ChevronRightIcon, EllipsisIcon } from "lucide-react";
import { useAtom, useAtomValue } from "@effect/atom-react";
import { type ReactNode, useState } from "react";
import { T, useGT, useMessages, Var } from "gt-react";
import {
  AuthAccessReadScope,
  AuthAccessWriteScope,
  AuthEnvironmentMaintainScope,
  AuthRelayReadScope,
  AuthRelayWriteScope,
  allowsPreviewTunnel,
  isManagedSettingPath,
  type AuthClientSession,
  type AuthPairingLink,
  type AuthPairingCredentialResult,
  type AdvertisedEndpoint,
  type DesktopServerExposureState,
  type DesktopWslState,
  EnvironmentId,
  resolveEnvironmentMachineKind,
} from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  settlePromise,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import * as Cause from "effect/Cause";

import { isLocalEnvironmentDisabled } from "../../localEnvironment";
import {
  applyWslEnableSelection,
  connectDeviceName,
  isWslSettingsRowVisible,
  missingTailscaleEndpointDescription,
  resolveLocalVersionStatusLabel,
  resolveTailscaleServeBaseUrl,
} from "./ConnectionsSettings.logic";
import { settingsScopeEnvironmentLabel } from "./settingsScopeAxis";
import { useAccessEnvironment } from "./useAccessEnvironment";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";
import { ManagedByOrganization } from "../ManagedPolicy";
import { LocalEnvironmentSetting } from "./LocalEnvironmentSetting";
import { useSearchableSetting } from "./settingsSearch";
import { ConnectDeviceApprovalSettings } from "./ConnectDeviceApprovalSettings";
import { EnvironmentIconMenu } from "./EnvironmentIconPicker";
import { FoldedSettingsSection } from "./FoldedSettingsSection";
import { T3ConnectServiceSettings } from "./T3ConnectServiceSettings";
import { EnvironmentsMap } from "./EnvironmentsMap";
import { LinkedEnvironmentsSettings } from "./LinkedEnvironmentsSettings";
import { addEnvironmentPrefillAtom } from "~/state/linkedThreadView";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { useMediaQuery } from "~/hooks/useMediaQuery";
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
import { desktopWslAccessStateAtom, refreshDesktopWslState } from "~/state/desktopWslState";
import { useDesktopUpdateState } from "~/state/desktopUpdate";
import {
  type EnvironmentPresentation,
  useEnvironment,
  useEnvironments,
  usePrimaryEnvironment,
} from "~/state/environments";
import { requestConfirmDialog } from "~/confirmDialog";
import { useUpdateEnvironmentSettings } from "~/hooks/useSettings";
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
  isServerNetworkAccessible,
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
import {
  type ConnectDeviceRevokeRequest,
  RevokeConnectDeviceDialog,
} from "./RevokeConnectDeviceDialog";

// Sessions T3 Connect minted for a device signed in to the linked account.
const CLOUD_CONNECT_SESSION_SUBJECT = "cloud-connect";
const DEFAULT_TAILSCALE_SERVE_PORT = 443;
const EMPTY_ADVERTISED_ENDPOINTS: ReadonlyArray<AdvertisedEndpoint> = [];

// Colons are invalid in distro names, keeping picker sentinels collision-free.
const BACKEND_VALUE_DEFAULT_WSL = "backend:default-wsl";
const BACKEND_VALUE_WSL_OFF = "backend:wsl-off";

// Subscribes on its own so desktop download progress does not re-render the page.
function LocalVersionStatusLabel() {
  const m = useMessages();
  const updateState = useDesktopUpdateState();
  return (
    <span className="text-xs text-muted-foreground">
      {resolveLocalVersionStatusLabel(updateState, m)}
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
  const gt = useGT();
  // A link that names an environment, such as the MCP wizard's, opens the page on it. The
  // settings layout remounts this page when the link changes.
  const linkedEnvironmentId = useSearch({
    strict: false,
    select: (search) =>
      typeof search.machine === "string" ? EnvironmentId.make(search.machine) : null,
  });
  const [selectedEnvironmentId, setSelectedEnvironmentId] = useState(linkedEnvironmentId);
  const { candidates, environment: accessEnvironment } =
    useAccessEnvironment(selectedEnvironmentId);
  const accessEnvironmentId = accessEnvironment?.environmentId ?? null;
  const picker =
    candidates.length > 1 && accessEnvironmentId !== null ? (
      <div className="flex min-w-0 items-center gap-1.5 px-3 text-sm text-muted-foreground sm:px-4">
        <span className="shrink-0">
          <T>Showing access for</T>
        </span>
        <Select
          value={accessEnvironmentId}
          onValueChange={(next) => {
            if (next !== null) setSelectedEnvironmentId(next);
          }}
        >
          <SelectTrigger size="sm" className="w-auto max-w-72" aria-label={gt("Environment")}>
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
                    <span className="shrink-0 text-xs text-muted-foreground">
                      <T>Offline</T>
                    </span>
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
  const searchableSetting = useSearchableSetting();
  const gt = useGT();
  const m = useMessages();
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
      const mismatch = resolveServerConfigVersionMismatch(environment.serverConfig, m);
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
  // An address the map already knows for the machine being added; remounts the dialog with it.
  const [addBackendHost, setAddBackendHost] = useState("");
  const [savedBackendError, setSavedBackendError] = useState<string | null>(null);
  // Set by a read-only linked thread whose machine this client is about to pair with.
  const [addPrefill, setAddPrefill] = useAtom(addEnvironmentPrefillAtom);
  const handleAddBackendDialogOpenChange = (open: boolean) => {
    setAddBackendDialogOpen(open);
    if (open) {
      setRouteTarget(null);
      setAddBackendHost("");
    } else {
      setSavedBackendError(null);
      setAddPrefill(null);
    }
  };
  const openAddRoute = (target: EnvironmentPresentation) => {
    setRouteTarget(target);
    setAddBackendHost("");
    setSavedBackendError(null);
    setAddBackendDialogOpen(true);
  };
  const openAddEnvironment = (host = "") => {
    setRouteTarget(null);
    setAddBackendHost(host);
    setSavedBackendError(null);
    setAddBackendDialogOpen(true);
  };
  // The map is the page's main view where there is room; the list is its equivalent everywhere.
  const roomForMap = useMediaQuery("md");
  const [pickedEnvironmentsView, setPickedEnvironmentsView] = useState<"map" | "list" | null>(null);
  const environmentsView = roomForMap ? (pickedEnvironmentsView ?? "map") : "list";
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
    m,
  );
  const primaryVersionMismatch = resolveServerConfigVersionMismatch(primaryServerConfig, m);
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
    m,
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
    m,
  );
  const desktopWsl = useEnvironmentQuery(
    showsAccess && canManageLocalBackend && desktopBridge ? desktopWslAccessStateAtom : null,
    m,
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
    : isServerNetworkAccessible({
        authPolicy: currentAuthPolicy,
        directEndpoints: accessEnvironment?.serverConfig?.directEndpoints,
      });
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
          ? (thrownErrorMessage(error, resolveMessage) ?? error.message)
          : gt("Failed to update network exposure.");
      setPendingDesktopServerExposureMode(null);
      setDesktopServerExposureMutationError(message);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: gt("Could not update network access"),
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
          ? (thrownErrorMessage(error, resolveMessage) ?? error.message)
          : gt("Failed to configure Tailscale HTTPS.");
      setDesktopServerExposureMutationError(message);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: gt("Could not set up Tailscale HTTPS"),
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
          ? (thrownErrorMessage(error, resolveMessage) ?? error.message)
          : gt("Failed to disable Tailscale HTTPS.");
      setDesktopServerExposureMutationError(message);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: gt("Could not disable Tailscale HTTPS"),
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
        error instanceof Error
          ? (thrownErrorMessage(error, resolveMessage) ?? error.message)
          : gt("Failed to revoke pairing link.");
      setDesktopAccessManagementMutationError(message);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: gt("Could not revoke pairing link"),
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
          ? (thrownErrorMessage(error, resolveMessage) ?? error.message)
          : gt("Failed to revoke client access.");
      setDesktopAccessManagementMutationError(message);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: gt("Could not revoke client access"),
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
            ? gt("Revoked 1 other client")
            : gt("{count, plural, other {Revoked {count} clients}}", { count: result.value }),
        description: gt("Other paired clients will need a new pairing link before reconnecting."),
      });
    } else if (!isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      const message =
        error instanceof Error
          ? (thrownErrorMessage(error, resolveMessage) ?? error.message)
          : gt("Failed to revoke other clients.");
      setDesktopAccessManagementMutationError(message);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: gt("Could not revoke other clients"),
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
          ? (errorDisplayMessage(error, resolveMessage) ?? error.message)
          : enabled
            ? gt("Failed to switch the backend on.")
            : gt("Failed to switch the backend off.");
      setSavedBackendError(message);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: enabled ? gt("Could not switch backend on") : gt("Could not switch backend off"),
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
          ? (thrownErrorMessage(error, resolveMessage) ?? error.message)
          : gt("Failed to remove backend.");
      setSavedBackendError(message);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: gt("Could not remove backend"),
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
      gt(
        "Remove {environment} from this device?\nThis forgets its pairing, credentials, and cached threads here. Switch it off instead to keep it saved.",
        { environment: environment.label },
      ),
      { variant: "destructive" },
    );
    if (confirmed === true) await removeSavedBackend(environment);
  };

  // T3 Connect devices waiting for approval have their own list.
  const visibleDesktopPairingLinks = desktopPairingLinks.filter(
    (pairingLink) => pairingLink.connectDeviceRequest === undefined,
  );
  const connectDeviceRequests = desktopPairingLinks.filter(
    (pairingLink) => pairingLink.connectDeviceRequest !== undefined,
  );
  // Older servers omit the list; they cannot hold devices for approval.
  const connectDevices =
    authAccessChanges.data?.type === "snapshot"
      ? (authAccessChanges.data.payload.connectDevices ?? null)
      : null;
  const updateAccessSettings = useUpdateEnvironmentSettings(accessEnvironmentId);
  const [pendingConnectRevoke, setPendingConnectRevoke] =
    useState<ConnectDeviceRevokeRequest | null>(null);
  // With approval off a revoked T3 Connect device signs straight back in, so offer to turn it
  // on. Older servers have no such setting, and revoking there goes ahead as before.
  const connectApprovalOff =
    accessEnvironment?.serverConfig?.settings.requireConnectDeviceApproval === false;
  const requestConnectRevoke = (title: string, revoke: () => Promise<void>) => {
    if (connectApprovalOff && canWriteAccess) setPendingConnectRevoke({ title, revoke });
    else void revoke();
  };
  const requireConnectApproval = () =>
    new Promise<boolean>((resolve) =>
      updateAccessSettings(
        { requireConnectDeviceApproval: true },
        { onSaved: () => resolve(true), onFailed: () => resolve(false) },
      ),
    );
  const requestRevokeClientSession = (sessionId: ServerClientSessionRecord["sessionId"]) => {
    const session = desktopClientSessions.find((candidate) => candidate.sessionId === sessionId);
    if (session?.subject === CLOUD_CONNECT_SESSION_SUBJECT) {
      requestConnectRevoke(gt("Revoke {name}?", { name: connectDeviceName(session, m) }), () =>
        handleRevokeDesktopClientSession(sessionId),
      );
    } else {
      void handleRevokeDesktopClientSession(sessionId);
    }
  };
  const requestRevokeOtherClients = () => {
    const revokesConnectDevices =
      (connectDevices?.length ?? 0) > 0 ||
      desktopClientSessions.some(
        (session) => !session.current && session.subject === CLOUD_CONNECT_SESSION_SUBJECT,
      );
    if (revokesConnectDevices) {
      requestConnectRevoke(gt("Revoke all other clients?"), handleRevokeOtherDesktopClients);
    } else {
      void handleRevokeOtherDesktopClients();
    }
  };
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
      aria-label={gt("Enable network access")}
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
        error instanceof Error
          ? (thrownErrorMessage(error, resolveMessage) ?? error.message)
          : gt("Failed to update WSL backend.");
      setDesktopWslMutationError(message);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: gt("Could not change WSL backend"),
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
            description={gt("Couldn't load the WSL backend state.")}
            status={<span className="block text-destructive">{desktopWslError}</span>}
            control={
              <Button
                size="sm"
                variant="outline"
                onClick={loadWslState}
                disabled={isLoadingWslState}
              >
                {isLoadingWslState ? gt("Retrying…") : gt("Retry")}
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
          description={gt(
            "WSL is unavailable, so Windows is running instead. Turn WSL off to clear this preference.",
          )}
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
              <T>Switch to Windows</T>
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
        ? gt("Off", { $context: "WSL backend is off" })
        : selectValue === BACKEND_VALUE_DEFAULT_WSL
          ? gt("Default distro")
          : selectValue;
    return (
      <>
        <SettingsRow
          {...searchableSetting("wsl-backend")}
          description={gt(
            "Run the selected WSL distro alongside Windows. Projects remain on their current filesystem.",
          )}
          status={
            desktopWslError ? (
              <span className="block text-destructive">{desktopWslError}</span>
            ) : desktopWslState.preflightError ? (
              <span className="block text-destructive">
                <T>
                  WSL backend couldn't start: <Var>{desktopWslState.preflightError}</Var>
                </T>
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
                aria-label={gt("WSL backend")}
                disabled={isUpdatingWslBackend}
              >
                <SelectValue>{selectLabel}</SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                <SelectItem hideIndicator value={BACKEND_VALUE_WSL_OFF}>
                  {gt("Off", { $context: "WSL backend is off" })}
                </SelectItem>
                {desktopWslState.distros.length === 0 ? (
                  <SelectItem hideIndicator value={BACKEND_VALUE_DEFAULT_WSL}>
                    <T>Default distro</T>
                  </SelectItem>
                ) : (
                  desktopWslState.distros.map((distro) => (
                    <SelectItem hideIndicator key={distro.name} value={distro.name}>
                      {distro.name}
                      {distro.isDefault ? ` ${gt("(default)")}` : ""}
                    </SelectItem>
                  ))
                )}
              </SelectPopup>
            </Select>
          }
        />
        {desktopWslState.enabled ? (
          <SettingsRow
            title={gt("WSL only")}
            description={gt("Run only the WSL backend. T3 Code restarts when this changes.")}
            className="bg-muted/20 pl-7 sm:pl-8"
            control={
              <Switch
                checked={desktopWslState.wslOnly}
                disabled={isUpdatingWslBackend}
                onCheckedChange={(checked) => handleToggleWslOnly(checked)}
                aria-label={gt("Run WSL only")}
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
            : gt("Use Tailscale Serve to expose this backend through a MagicDNS HTTPS URL.")
          : missingTailscaleEndpointDescription(desktopServerExposureState, m)
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
            aria-label={gt("Enable Tailscale HTTPS")}
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
      onRevokeClientSession={requestRevokeClientSession}
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
                ? gt("Reachable at {url}", { url: desktopServerExposureState.endpointUrl })
                : desktopServerExposureState?.advertisedHost
                  ? gt("Exposed on all interfaces. Pairing links use {host}.", {
                      host: desktopServerExposureState.advertisedHost,
                    })
                  : gt("Exposed on all interfaces.")
            }
          />
        ) : desktopServerExposureState ? (
          gt("Limited to this machine.")
        ) : (
          gt("Loading…")
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
          ? gt("This connection cannot view or change network exposure.")
          : isLocalBackendNetworkAccessible
            ? gt(
                "Remote access is already configured. Change network exposure where the server starts.",
              )
            : currentAuthPolicy === "loopback-browser"
              ? gt(
                  "Only this machine can connect. Restart with a non-loopback host for remote pairing.",
                )
              : gt("Network exposure information is unavailable.")
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
                    aria-label={gt("Enable network access")}
                  />
                </span>
              }
            />
            <TooltipPopup side="top">
              <T>
                Network exposure changes restart the backend and must be controlled where the server
                process is launched.
              </T>
            </TooltipPopup>
          </Tooltip>
        ) : undefined
      }
    />
  );

  const accessServerConfig = accessEnvironment?.serverConfig ?? null;
  const accessPolicy = accessServerConfig?.managedPolicy;
  const previewTunnelDenial =
    managedCapabilityDenial(accessPolicy, "previewTunnel", m) ??
    (accessPolicy !== undefined && isManagedSettingPath(accessPolicy, "enablePreviewTunnel")
      ? gt("Managed by {organization}.", { organization: accessPolicy.organization })
      : undefined);
  const primarySettings = (
    <>
      {accessEnvironmentPicker}
      {accessEnvironmentId !== null ? (
        <>
          <SettingsSection
            {...searchableSetting("connections-environment")}
            title={
              accessEnvironment?.label ??
              (desktopBridge ? gt("This machine") : gt("Primary environment"))
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
                        aria-label={gt("More actions for this machine")}
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
                title={gt("Version")}
                description={
                  primaryServerUpdateState.status !== "idle" ? (
                    <ServerUpdateProgress state={primaryServerUpdateState} />
                  ) : (
                    [
                      primaryServerConfig?.environment.serverVersion ?? null,
                      primaryEnvironment?.displayUrl ?? null,
                    ]
                      .filter((value): value is string => value !== null)
                      .join(" · ") || gt("Loading…")
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
                          ? gt("{environment} server", { environment: primaryEnvironment.label })
                          : gt("server")
                      }
                      selfUpdate={resolveServerSelfUpdateCapability(primaryServerConfig)}
                      installation={
                        primaryServerConfig?.environment.capabilities.serverInstallation
                      }
                      desktopAppUpdate={supportsDesktopAppUpdate(primaryServerConfig)}
                      targetVersion={primaryVersionMismatch.clientVersion}
                      label={
                        primaryServerUpdateState.status === "failed"
                          ? gt("Retry update")
                          : gt("Update to {version}", {
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
                connectDeviceApproval={
                  accessServerConfig?.settings.requireConnectDeviceApproval === undefined
                    ? null
                    : {
                        required: accessServerConfig.settings.requireConnectDeviceApproval,
                        canManage: canWriteAccess,
                      }
                }
              />
            ) : null}
            {accessServerConfig?.environment.capabilities.previewTunnelSetting ? (
              <SettingsRow
                title={searchableSetting("preview-tunnel").title}
                description={gt(
                  "Lets other devices open this machine's local servers: browser tabs loaded on the device, Open on this device, and port forwarding. Off: browser tabs stream from this machine.",
                )}
                managed={previewTunnelDenial}
                control={
                  <Switch
                    checked={allowsPreviewTunnel(accessServerConfig)}
                    disabled={!canWriteAccess}
                    aria-label={gt("Allow the preview tunnel")}
                    onCheckedChange={(enabled) =>
                      void updateAccessSettings({ enablePreviewTunnel: enabled })
                    }
                  />
                }
              />
            ) : null}
            {accessEnvironment ? (
              <details className="group px-3 sm:px-4">
                <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 rounded-md text-sm font-medium outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
                  <T>Permissions</T>
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
              title={gt("Authorized clients")}
              collapsedContent={
                canReadAccess && newestPairingLink
                  ? renderPairingClientsList([newestPairingLink], [])
                  : undefined
              }
              summary={summarizeAuthorizedClients(
                desktopClientSessions,
                visibleDesktopPairingLinks,
                m,
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
                    onRevokeOtherClients={requestRevokeOtherClients}
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
                    <T>
                      This connection can create access links but cannot view authorized clients.
                    </T>
                  </p>
                )}
              </ScrollArea>
            </FoldedSettingsSection>
          ) : null}
          {canReadAccess &&
          connectDevices !== null &&
          (connectDeviceRequests.length > 0 || connectDevices.length > 0) ? (
            <ConnectDeviceApprovalSettings
              environmentId={accessEnvironmentId}
              requests={connectDeviceRequests}
              devices={connectDevices}
              canWrite={canWriteAccess}
              requestRevoke={requestConnectRevoke}
            />
          ) : null}
          <RevokeConnectDeviceDialog
            request={pendingConnectRevoke}
            onClose={() => setPendingConnectRevoke(null)}
            requireApproval={requireConnectApproval}
          />
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
                    ? gt("Enable network access?")
                    : gt("Disable network access?")}
                </AlertDialogTitle>
                <AlertDialogDescription>
                  {pendingDesktopServerExposureMode === "network-accessible"
                    ? gt(
                        "Let your other devices connect to T3 Code over the network. Pair devices to give them access. T3 Code will restart.",
                      )
                    : gt(
                        "Devices connected over your local network will disconnect. Existing tunnels, such as T3 Connect or Tailscale HTTPS, keep working. T3 Code will restart.",
                      )}
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogClose
                  disabled={isUpdatingDesktopServerExposure}
                  render={<Button variant="outline" disabled={isUpdatingDesktopServerExposure} />}
                >
                  <span className="[text-box:trim-both_cap_alphabetic]">
                    <T>Cancel</T>
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
                      ? gt("Restarting…")
                      : pendingDesktopServerExposureMode === "network-accessible"
                        ? gt("Restart and enable")
                        : gt("Restart and disable")}
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
                      ? gt("Turn off WSL and switch back to Windows?")
                      : gt("Disable WSL backend?")
                    : pendingWslChange?.kind === "distro"
                      ? gt("Switch WSL distro?")
                      : pendingWslChange?.kind === "enable"
                        ? gt("Start the WSL backend")
                        : pendingWslChange?.nextValue
                          ? gt("Run only the WSL backend?")
                          : gt("Re-enable the Windows backend?")}
                </AlertDialogTitle>
                <AlertDialogDescription>
                  {pendingWslChange?.kind === "disable"
                    ? pendingWslChange.wasWslOnly
                      ? gt(
                          "T3 Code will restart on the Windows backend. Threads and projects opened against WSL stay safe inside the distro and become available again when you re-enable WSL.",
                        )
                      : gt(
                          "The WSL backend will stop. Threads and projects opened against WSL stay safe inside the distro, but they'll be unavailable in T3 Code until you re-enable WSL.",
                        )
                    : pendingWslChange?.kind === "distro"
                      ? gt(
                          "T3 Code will restart the WSL backend on the new distro. Sessions still running on the current distro will be interrupted.",
                        )
                      : pendingWslChange?.kind === "enable"
                        ? gt(
                            "Run the WSL backend alongside the Windows one, or stop the Windows backend and use only WSL? You can change this later from Settings.",
                          )
                        : pendingWslChange?.nextValue
                          ? gt(
                              "T3 Code will restart and start only the WSL backend. Your Windows-side projects won't be accessible until you turn this off again.",
                            )
                          : gt(
                              "T3 Code will restart and bring the Windows backend back up alongside WSL.",
                            )}
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogClose
                  disabled={isUpdatingWslBackend}
                  render={<Button variant="outline" disabled={isUpdatingWslBackend} />}
                >
                  <T>Cancel</T>
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
                          <T>Applying…</T>
                        </>
                      ) : (
                        gt("Use only WSL")
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
                          <T>Applying…</T>
                        </>
                      ) : (
                        gt("Run both backends")
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
                        <T>Applying…</T>
                      </>
                    ) : pendingWslChange?.kind === "disable" ? (
                      pendingWslChange.wasWslOnly ? (
                        gt("Switch to Windows")
                      ) : (
                        gt("Disable WSL")
                      )
                    ) : pendingWslChange?.kind === "distro" ? (
                      gt("Switch distro")
                    ) : pendingWslChange?.nextValue ? (
                      gt("Restart and enable")
                    ) : (
                      gt("Restart and disable")
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
                  <T>Disable Tailscale HTTPS?</T>
                </AlertDialogTitle>
                <AlertDialogDescription>
                  <T>T3 Code will restart the local backend without Tailscale Serve.</T>
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogClose
                  disabled={isUpdatingTailscaleServe}
                  render={<Button variant="outline" disabled={isUpdatingTailscaleServe} />}
                >
                  <T>Cancel</T>
                </AlertDialogClose>
                <Button
                  variant="destructive"
                  onClick={() => void handleConfirmTailscaleServeDisable()}
                  disabled={isUpdatingTailscaleServe || !canManageLocalBackend}
                >
                  {isUpdatingTailscaleServe ? (
                    <>
                      <Spinner size="sm" />
                      <T>Restarting…</T>
                    </>
                  ) : (
                    gt("Restart and disable")
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
                <DialogTitle>
                  <T>Set up Tailscale HTTPS?</T>
                </DialogTitle>
                <DialogDescription>
                  <T>
                    T3 Code will restart the local backend with Tailscale Serve enabled and ask
                    Tailscale to proxy HTTPS traffic to this backend.
                  </T>
                </DialogDescription>
              </DialogHeader>
              <DialogPanel>
                <label className="block">
                  <span className="text-sm font-medium text-foreground">
                    <T>HTTPS port</T>
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
                    <T>Enter a port from 1 to 65535.</T>
                  </p>
                ) : null}
                <div className="rounded-md border border-border/70 bg-muted/20 px-3 py-2">
                  <p className="text-xs font-medium text-muted-foreground">
                    <T>HTTPS endpoint</T>
                  </p>
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <p className="mt-1 truncate text-sm text-foreground">
                          {pendingTailscaleServeBaseUrl ?? gt("Pending MagicDNS endpoint")}
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
                  <T>Cancel</T>
                </DialogClose>
                <Button
                  onClick={() => void handleConfirmTailscaleServeSetup()}
                  disabled={isUpdatingTailscaleServe || !isTailscaleServePortValid}
                >
                  {isUpdatingTailscaleServe ? (
                    <>
                      <Spinner size="sm" />
                      <T>Restarting…</T>
                    </>
                  ) : (
                    gt("Enable")
                  )}
                </Button>
              </DialogFooter>
            </DialogPopup>
          </Dialog>
        </>
      ) : (
        <SettingsSection {...searchableSetting("connections-environment")}>
          <SettingsRow
            title={gt("No environment selected")}
            description={gt("Connect an environment to view its settings and access.")}
          />
        </SettingsSection>
      )}
    </>
  );

  if (showsAccess) return <SettingsPageContainer>{primarySettings}</SettingsPageContainer>;

  return (
    <SettingsPageContainer>
      {desktopBridge ? (
        <SettingsSection id="this-app" title={gt("This app")}>
          <LocalEnvironmentSetting />
        </SettingsSection>
      ) : null}
      <T3ConnectServiceSettings />
      <SettingsSection
        {...searchableSetting("remote-environments")}
        title={gt("Environments")}
        titleAction={
          roomForMap ? (
            <ToggleGroup
              aria-label={gt("Show environments as")}
              value={[environmentsView]}
              onValueChange={(next) => {
                const value = next[0];
                if (value === "map" || value === "list") setPickedEnvironmentsView(value);
              }}
            >
              <Toggle value="map">
                {gt("Map", { $context: "view switch: show machines as a diagram" })}
              </Toggle>
              <Toggle value="list">
                {gt("List", { $context: "view switch: show items as a list" })}
              </Toggle>
            </ToggleGroup>
          ) : null
        }
        headerAction={
          <div className="flex items-center gap-1">
            {savedServerUpdateTargets.length > 0 ? (
              <ServerUpdatesAction targets={savedServerUpdateTargets} variant="ghost-muted" />
            ) : null}
            {/* Actions on several machines at once, such as linking several, go here. */}
            <AddEnvironmentDialog
              key={`${addPrefill?.environmentId ?? "any"}:${addBackendHost}`}
              open={addBackendDialogOpen || addPrefill !== null}
              prefill={addPrefill}
              routeTarget={routeTarget}
              initialHost={addBackendHost}
              error={savedBackendError}
              savedEnvironments={savedEnvironments}
              onOpenChange={handleAddBackendDialogOpenChange}
              onErrorChange={setSavedBackendError}
            />
          </div>
        }
      >
        {environmentsView === "map" ? (
          <EnvironmentsMap
            footerId={searchableSetting("linked-environments").id}
            onAddEnvironment={openAddEnvironment}
            renderSavedEnvironment={(environment) =>
              listedEnvironments.some(
                (listed) => listed.environmentId === environment.environmentId,
              ) ? (
                <SavedBackendListRow
                  key={environment.environmentId}
                  environment={environment}
                  initialRoutesOpen
                  removingEnvironmentId={removingSavedEnvironmentId}
                  onSetEnabled={handleSetSavedBackendEnabled}
                  onRemove={handleRemoveSavedBackend}
                  onAddRoute={openAddRoute}
                />
              ) : null
            }
            renderConnectMachine={(environmentId) => (
              <CloudRemoteEnvironmentRows
                only={environmentId}
                primaryEnvironmentId={primaryEnvironmentId}
                savedEnvironments={savedEnvironments}
              />
            )}
          />
        ) : (
          <>
            {listedEnvironments.map((environment) => (
              <SavedBackendListRow
                key={environment.environmentId}
                environment={environment}
                removingEnvironmentId={removingSavedEnvironmentId}
                onSetEnabled={handleSetSavedBackendEnabled}
                onRemove={handleRemoveSavedBackend}
                onAddRoute={openAddRoute}
              />
            ))}
            <CloudRemoteEnvironmentRows
              primaryEnvironmentId={primaryEnvironmentId}
              savedEnvironments={savedEnvironments}
            />
          </>
        )}
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
      {environmentsView === "list"
        ? peerLinkHosts.map((environment, index) => (
            <LinkedEnvironmentsSettings
              key={environment.environmentId}
              environmentId={environment.environmentId}
              environmentLabel={peerLinkHosts.length > 1 ? environment.label : null}
              isSearchTarget={index === 0}
            />
          ))
        : null}
      <LoadBalancingSettings environments={loadBalancingEnvironments} />
      <PullRequestRoutingSettings environments={loadBalancingEnvironments} />
    </SettingsPageContainer>
  );
}
