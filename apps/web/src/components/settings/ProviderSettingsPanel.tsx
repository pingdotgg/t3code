import { SettingsGroup } from "./SettingsGroup";
import { RefreshIcon } from "~/components/ui/refresh-icon";
import {
  AuthSettingsWriteScope,
  AuthProvidersManageScope,
  AuthOrchestrationReadScope,
} from "@t3tools/contracts";
import { useEnvironmentScope, readEnvironmentScope } from "../../state/session";
import { useAtomValue } from "@effect/atom-react";
import { connectionStatusTitle } from "@t3tools/client-runtime/connection";
import { safeErrorLogAttributes } from "@t3tools/client-runtime/errors";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  defaultInstanceIdForDriver,
  type EnvironmentId,
  type AcpRegistryUrlAuthAction,
  PROVIDER_DISPLAY_NAMES,
  ProviderDriverKind,
  type ProjectId,
  type ProviderInstanceConfig,
  type ProviderInstanceId,
  type ServerProvider,
  resolveEnvironmentMachineKind,
  resolveProjectProviderInstanceEnabled,
  resolveProviderInstanceEnabled,
} from "@t3tools/contracts";
import { DEFAULT_UNIFIED_SETTINGS, type UnifiedSettings } from "@t3tools/contracts/settings";
import {
  getBackgroundActivityPresetSettings,
  resolveServerBackgroundActivitySettings,
} from "@t3tools/shared/backgroundActivitySettings";
import * as Arr from "effect/Array";
import * as Duration from "effect/Duration";
import * as Result from "effect/Result";
import { PlusIcon } from "lucide-react";
import { useRef, useState, type ReactNode } from "react";

import { isDesktopLocalConnectionTarget } from "../../connection/desktopLocal";
import {
  useEnvironmentSettings,
  usePersistEnvironmentProviderInstanceMutation,
  useUpdateEnvironmentSettings,
  useUpdateEnvironmentModelPreferences,
  useToggleEnvironmentModelFavorite,
} from "../../hooks/useSettings";
import { useStableCallback } from "../../hooks/useStableCallback";
import { EnvironmentMachineIcon } from "../EnvironmentMachineIcon";
import { cn } from "../../lib/utils";
import { resolveAppModelSelectionState } from "../../modelSelection";
import {
  useEnvironments,
  usePrimaryEnvironmentId,
  type EnvironmentPresentation,
} from "../../state/environments";
import {
  EMPTY_SERVER_PROVIDERS,
  providersIgnoringCheckedAtAtom,
  serverEnvironment,
} from "../../state/server";
import { useEnvironmentSessionState } from "../../state/session";
import { useProjects } from "../../state/entities";
import { useAtomCommand } from "../../state/use-atom-command";
import { useRelativeTimeState } from "../../hooks/useRelativeTimeState";
import {
  ConnectionStatusDot,
  connectionPhaseDotClassName,
  connectionPhasePingClassName,
} from "../ConnectionStatusDot";
import {
  isProviderSettingsUpdateCandidate,
  isProviderUpdateActive,
  type ProviderSettingsUpdateCandidate,
} from "../ProviderUpdateLaunchNotification.logic";
import { ProviderUpdatesAction } from "../ProviderUpdatesAction";
import { Button } from "../ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "../ui/empty";
import { ScrollArea } from "../ui/scroll-area";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { AddProviderInstanceDialog } from "./AddProviderInstanceDialog";
import { useManagedPolicy } from "~/state/managedPolicy";
import { ExpandableText } from "./ExpandableText";
import { IntervalSecondsField } from "./IntervalSecondsField";
import { ProviderInstanceCard } from "./ProviderInstanceCard";
import { useSecretSources } from "./SecretSourceInput";
import { UsageProviderSettings } from "./UsageProviderSettings";
import { ProviderSetupSection, readAntigravityAuthMethod } from "./ProviderSetupSection";
import { ProviderAuthenticationSection } from "./ProviderAuthenticationSection";
import { CodexSetupSection, CodexManagedRuntimeFields } from "./CodexSetupSection";
import { readCodexSetupMode } from "./CodexSetupSection.logic";
import { providerClients } from "./providerDriverMeta";
import { searchableSetting } from "./settingsSearch";
import { CompactIdleThreadsRow } from "./SettingsPanels";
import {
  backgroundActivityOverrideSettings,
  buildProviderInstanceUpdatePatch,
  durationToSeconds,
  PROVIDER_HEALTH_INTERVAL_STEP_SECONDS,
} from "./SettingsPanels.logic";
import {
  PolicyTooltip,
  SettingResetButton,
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
  useSettingsSearchTargetId,
} from "./settingsLayout";
import {
  buildProviderEnvironmentOptions,
  buildProviderInstanceOverridePatch,
  classifyProviderEnvironmentAccess,
  isProviderSettingsEnvironmentAvailable,
  type ProviderEnvironmentAccess,
  type ProviderOperateAccess,
  resolveRemoteOperateAccess,
  resolveSelectedProviderEnvironmentId,
} from "./ProviderSettingsPanel.logic";

function modelListChanges(current: ReadonlyArray<string>, next: ReadonlyArray<string>) {
  const currentSet = new Set(current);
  const nextSet = new Set(next.map((model) => model.trim()).filter(Boolean));
  return [...new Set([...currentSet, ...nextSet])]
    .filter((model) => currentSet.has(model) !== nextSet.has(model))
    .map((model) => ({ model, selected: nextSet.has(model) }));
}

function providerConfigString(config: unknown, key: string): string | null {
  if (config === null || typeof config !== "object") return null;
  const value = (config as Record<string, unknown>)[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

const PROVIDER_SETTINGS = providerClients.definitions.map((definition) => ({
  provider: definition.driverKind,
  hasDefaultInstance: definition.hasDefaultInstance !== false,
}));

function configuredBinaryPath(config: unknown): string {
  if (config === null || typeof config !== "object" || !("binaryPath" in config)) return "";
  return typeof config.binaryPath === "string" ? config.binaryPath.trim() : "";
}

// Subscribe only in the label because every status push restamps all providers' checkedAt.
function ProviderLastChecked({ environmentId }: { environmentId: EnvironmentId }) {
  const serverProviders =
    useAtomValue(serverEnvironment.providersValueAtom(environmentId)) ?? EMPTY_SERVER_PROVIDERS;
  const lastCheckedAt =
    serverProviders.length > 0
      ? serverProviders.reduce(
          (latest, provider) => (provider.checkedAt > latest ? provider.checkedAt : latest),
          serverProviders[0]!.checkedAt,
        )
      : null;
  const lastCheckedRelative = useRelativeTimeState(lastCheckedAt);

  if (lastCheckedRelative.status === "missing") {
    return null;
  }

  if (lastCheckedRelative.status === "invalid") {
    return <span>Checked unavailable</span>;
  }

  return (
    <span>
      {lastCheckedRelative.suffix ? (
        <>
          Checked <span className="font-mono tabular-nums">{lastCheckedRelative.value}</span>{" "}
          {lastCheckedRelative.suffix}
        </>
      ) : (
        <>Checked {lastCheckedRelative.value}</>
      )}
    </span>
  );
}

function providerEnvironmentDetail(environment: EnvironmentPresentation): string {
  if (environment.entry.target._tag === "PrimaryConnectionTarget") return "Primary device";
  if (environment.relayManaged) return "T3 Connect";
  if (environment.entry.target._tag === "SshConnectionTarget") return "SSH";
  if (isDesktopLocalConnectionTarget(environment.entry.target)) return "Local device";
  return environment.displayUrl ?? "Remote device";
}

const providerCardHeightClassName =
  "@min-[48rem]/providers:h-[min(44rem,calc(100dvh-11rem))] @min-[48rem]/providers:min-h-[32rem]";

function ProviderSettingsPlaceholder({
  deviceTabs,
  icon,
  title,
  description,
  children,
}: {
  readonly deviceTabs?: ReactNode;
  readonly icon: ReactNode;
  readonly title: string;
  readonly description: string;
  readonly children?: ReactNode;
}) {
  return (
    <SettingsSection {...searchableSetting("providers")} variant="plain">
      {deviceTabs ? (
        <div className="flex min-h-11 min-w-0 items-center px-3 sm:px-4">{deviceTabs}</div>
      ) : null}
      <SettingsGroup
        divided={false}
        className={cn(
          providerCardHeightClassName,
          "scrollbar-gutter-both flex overflow-x-hidden overflow-y-auto",
        )}
      >
        <Empty>
          <EmptyMedia variant="icon">{icon}</EmptyMedia>
          <EmptyHeader>
            <EmptyTitle>{title}</EmptyTitle>
            <EmptyDescription>{description}</EmptyDescription>
          </EmptyHeader>
          {children ? <EmptyContent className="max-w-xl">{children}</EmptyContent> : null}
        </Empty>
      </SettingsGroup>
    </SettingsSection>
  );
}

function EnvironmentUnavailablePlaceholder({
  environment,
  access,
  deviceTabs,
}: {
  readonly environment: EnvironmentPresentation;
  readonly access: Exclude<ProviderEnvironmentAccess, { kind: "editable" | "read-only" }>;
  readonly deviceTabs?: ReactNode;
}) {
  const isLoading = access.kind === "loading";
  const title = isLoading
    ? "Loading provider settings"
    : access.kind === "error"
      ? "Could not connect to this device"
      : "Provider settings are unavailable";
  const description = isLoading
    ? access.reason === "permissions"
      ? "Checking what this session is allowed to change."
      : `Waiting for ${environment.label}'s configuration.`
    : connectionStatusTitle(environment.connection);
  const error = isLoading ? null : environment.connection.error;
  // Wedged devices can remain here indefinitely; a spinner would continuously repaint.
  return (
    <ProviderSettingsPlaceholder
      deviceTabs={deviceTabs}
      icon={
        <EnvironmentMachineIcon kind={resolveEnvironmentMachineKind(environment.serverConfig)} />
      }
      title={title}
      description={description}
    >
      {error ? (
        <ExpandableText
          key={environment.environmentId}
          text={error}
          className="w-full text-left font-mono text-xs leading-relaxed text-muted-foreground"
        />
      ) : null}
    </ProviderSettingsPlaceholder>
  );
}

interface ProviderSettingsTarget {
  readonly environmentId?: EnvironmentId;
  readonly instanceId?: ProviderInstanceId;
  readonly scoped?: boolean;
  readonly environmentIds?: readonly EnvironmentId[];
  readonly projectIds?: readonly ProjectId[];
}

export function ProviderSettingsPanel(target: ProviderSettingsTarget) {
  return (
    <SettingsPageContainer className="@container/providers gap-8">
      <ProviderSettingsPanelContent
        key={`${target.environmentId ?? ""}:${target.instanceId ?? ""}`}
        {...target}
      />
    </SettingsPageContainer>
  );
}

function ProviderSettingsPanelContent(target: ProviderSettingsTarget) {
  const { environments, isReady } = useEnvironments();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const searchTargetId = useSettingsSearchTargetId();
  const options = buildProviderEnvironmentOptions(
    environments,
    primaryEnvironmentId,
    target.environmentIds,
  );
  const [selectedEnvironmentId, setSelectedEnvironmentId] = useState<EnvironmentId | null>(
    target.environmentId ?? primaryEnvironmentId,
  );
  const targetEnvironmentMissing =
    target.environmentId !== undefined &&
    selectedEnvironmentId === target.environmentId &&
    !options.some((environment) => environment.environmentId === target.environmentId);
  const effectiveEnvironmentId =
    target.scoped || targetEnvironmentMissing
      ? target.environmentId
      : resolveSelectedProviderEnvironmentId(options, selectedEnvironmentId, primaryEnvironmentId);
  const selectedEnvironment =
    options.find((environment) => environment.environmentId === effectiveEnvironmentId) ?? null;
  const selectedEnvironmentCanRenderSettings =
    selectedEnvironment !== null &&
    isProviderSettingsEnvironmentAvailable({
      connectionPhase: selectedEnvironment.connection.phase,
      hasServerConfig: selectedEnvironment.serverConfig !== null,
    });
  const searchableEnvironmentId = options.find((environment) =>
    isProviderSettingsEnvironmentAvailable({
      connectionPhase: environment.connection.phase,
      hasServerConfig: environment.serverConfig !== null,
    }),
  )?.environmentId;
  const searchableCursorEnvironmentId = options.find(
    (environment) =>
      environment.serverConfig?.environment.platform.os === "darwin" &&
      isProviderSettingsEnvironmentAvailable({
        connectionPhase: environment.connection.phase,
        hasServerConfig: true,
      }),
  )?.environmentId;
  let searchRedirectEnvironmentId: EnvironmentId | undefined;
  {
    if (
      !target.scoped &&
      searchTargetId === searchableSetting("cursor-keychain-usage").id &&
      (!selectedEnvironmentCanRenderSettings ||
        selectedEnvironment?.serverConfig?.environment.platform.os !== "darwin") &&
      searchableCursorEnvironmentId !== undefined
    ) {
      searchRedirectEnvironmentId = searchableCursorEnvironmentId;
    } else if (
      !target.scoped &&
      (searchTargetId === searchableSetting("provider-health-check-interval").id ||
        searchTargetId === searchableSetting("usage-providers").id) &&
      !selectedEnvironmentCanRenderSettings &&
      searchableEnvironmentId !== undefined
    ) {
      searchRedirectEnvironmentId = searchableEnvironmentId;
    }
  }
  if (
    searchRedirectEnvironmentId !== undefined &&
    searchRedirectEnvironmentId !== selectedEnvironmentId
  ) {
    setSelectedEnvironmentId(searchRedirectEnvironmentId);
  }
  const onlyPrimaryDevice =
    options.length === 1 && options[0]?.entry.target._tag === "PrimaryConnectionTarget";
  const deviceTabs =
    !target.scoped && !onlyPrimaryDevice && options.length > 0 ? (
      <ScrollArea radius="none" hideScrollbars scrollFade className="h-11 min-w-0 flex-1">
        <ToggleGroup
          aria-label="Devices"
          variant="segmented"
          className="my-2"
          value={effectiveEnvironmentId ? [effectiveEnvironmentId] : []}
          onValueChange={(next) => {
            const environment = options.find((option) => option.environmentId === next[0]);
            if (environment) setSelectedEnvironmentId(environment.environmentId);
          }}
        >
          {options.map((environment) => {
            const machine = resolveEnvironmentMachineKind(environment.serverConfig);
            const detail = providerEnvironmentDetail(environment);
            const statusText = connectionStatusTitle(environment.connection);
            return (
              <Tooltip key={environment.environmentId}>
                <TooltipTrigger
                  render={
                    <Toggle value={environment.environmentId}>
                      <EnvironmentMachineIcon
                        kind={machine}
                        className="size-3.5 shrink-0"
                        aria-hidden
                      />
                      <span className="max-w-40 truncate">{environment.label}</span>
                      {environment.connection.phase !== "connected" ? (
                        <ConnectionStatusDot
                          dotClassName={connectionPhaseDotClassName(environment.connection.phase)}
                          pingClassName={connectionPhasePingClassName(environment.connection.phase)}
                        />
                      ) : null}
                      <span className="sr-only">
                        {detail}, {statusText}
                      </span>
                    </Toggle>
                  }
                />
                <TooltipPopup side="top">
                  {detail} · {statusText}
                </TooltipPopup>
              </Tooltip>
            );
          })}
        </ToggleGroup>
      </ScrollArea>
    ) : null;

  return (
    <>
      {targetEnvironmentMissing ? (
        <ProviderSettingsPlaceholder
          deviceTabs={deviceTabs}
          icon={<EnvironmentMachineIcon kind={resolveEnvironmentMachineKind(null)} />}
          title="Device unavailable"
          description="Reconnect this device to set up its provider, or select another device."
        />
      ) : null}
      {options.length === 0 && !targetEnvironmentMissing ? (
        <ProviderSettingsPlaceholder
          icon={<EnvironmentMachineIcon kind={resolveEnvironmentMachineKind(null)} />}
          title={isReady ? "No connected devices" : "Loading devices"}
          description={
            isReady
              ? "Connect an execution environment before configuring providers."
              : "Reading connected execution environments."
          }
        />
      ) : null}

      {selectedEnvironment ? (
        <RemoteSessionGatedProviderSettings
          key={selectedEnvironment.environmentId}
          environment={selectedEnvironment}
          deviceTabs={deviceTabs}
          targetInstanceId={
            target.environmentId === undefined ||
            selectedEnvironment.environmentId === target.environmentId
              ? target.instanceId
              : undefined
          }
          projectIds={target.projectIds ?? []}
        />
      ) : null}
    </>
  );
}

function RemoteSessionGatedProviderSettings({
  environment,
  deviceTabs,
  targetInstanceId,
  projectIds,
}: {
  readonly environment: EnvironmentPresentation;
  readonly deviceTabs?: ReactNode;
  readonly targetInstanceId?: ProviderInstanceId | undefined;
  readonly projectIds: readonly ProjectId[];
}) {
  const sessionState = useEnvironmentSessionState(environment.environmentId);
  const operateAccess = resolveRemoteOperateAccess({
    session: sessionState.data,
    isPending: sessionState.isPending,
    hasError: sessionState.hasError,
  });
  return (
    <AccessGatedProviderSettings
      environment={environment}
      operateAccess={operateAccess}
      deviceTabs={deviceTabs}
      targetInstanceId={targetInstanceId}
      projectIds={projectIds}
    />
  );
}

function AccessGatedProviderSettings({
  environment,
  operateAccess,
  deviceTabs,
  targetInstanceId,
  projectIds,
}: {
  readonly environment: EnvironmentPresentation;
  readonly operateAccess: ProviderOperateAccess;
  readonly deviceTabs?: ReactNode;
  readonly targetInstanceId?: ProviderInstanceId | undefined;
  readonly projectIds: readonly ProjectId[];
}) {
  const access = classifyProviderEnvironmentAccess({
    connectionPhase: environment.connection.phase,
    hasServerConfig: environment.serverConfig !== null,
    operateAccess,
  });
  if (access.kind !== "editable" && access.kind !== "read-only") {
    return (
      <EnvironmentUnavailablePlaceholder
        environment={environment}
        access={access}
        deviceTabs={deviceTabs}
      />
    );
  }
  return (
    <EnvironmentProviderSettings
      environmentId={environment.environmentId}
      environmentLabel={environment.label}
      readOnly={access.kind === "read-only"}
      deviceTabs={deviceTabs}
      targetInstanceId={targetInstanceId}
      projectIds={projectIds}
    />
  );
}

const NO_PROJECT_IDS: readonly ProjectId[] = [];
const NO_FAVORITES: UnifiedSettings["favorites"] = [];

export function EnvironmentProviderSettings({
  environmentId,
  environmentLabel,
  readOnly = false,
  deviceTabs,
  targetInstanceId,
  projectIds = NO_PROJECT_IDS,
}: {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly deviceTabs?: ReactNode;
  readonly targetInstanceId?: ProviderInstanceId | undefined;
  readonly projectIds?: readonly ProjectId[];
  readonly readOnly?: boolean;
}) {
  const settings = useEnvironmentSettings(environmentId);
  const managedPolicy = useManagedPolicy(environmentId);
  // A policy that allows no provider leaves nothing to add.
  const canAddProvider =
    !readOnly && managedPolicy?.limits?.providers?.allowedDrivers?.length !== 0;
  const canWriteSettings = useEnvironmentScope(environmentId, AuthSettingsWriteScope);
  const canRefreshProviders = useEnvironmentScope(environmentId, AuthOrchestrationReadScope);
  const updateSettings = useUpdateEnvironmentSettings(environmentId);
  const updateModelPreferences = useUpdateEnvironmentModelPreferences(environmentId);
  const toggleModelFavorite = useToggleEnvironmentModelFavorite(environmentId);
  const persistProviderInstance = usePersistEnvironmentProviderInstanceMutation(environmentId);
  const serverProviders = useAtomValue(providersIgnoringCheckedAtAtom(environmentId));
  // Hide overrides on older servers that silently ignore providerInstances patches.
  const supportsProjectProviderOverrides = useAtomValue(
    serverEnvironment.configValueAtom(environmentId),
    (config) => config?.environment.capabilities.projectProviderInstanceOverrides === true,
  );
  const refreshServerProviders = useAtomCommand(serverEnvironment.refreshProviders, {
    reportFailure: false,
  });
  const updateProvider = useAtomCommand(serverEnvironment.updateProvider, {
    reportFailure: false,
  });
  const uninstallAcpRegistryManagedBinary = useAtomCommand(
    serverEnvironment.uninstallAcpRegistryManagedBinary,
    { reportFailure: false },
  );
  const acceptAcpRegistryUrlAuth = useAtomCommand(serverEnvironment.acceptAcpRegistryUrlAuth, {
    reportFailure: false,
  });
  const [isRefreshingProviders, setIsRefreshingProviders] = useState(false);
  const [isAddInstanceDialogOpen, setIsAddInstanceDialogOpen] = useState(false);
  const [selectedInstanceId, setSelectedInstanceId] = useState<ProviderInstanceId | null>(
    targetInstanceId ?? null,
  );
  const [updatingProviderInstanceIds, setUpdatingProviderInstanceIds] = useState<
    ReadonlySet<ProviderInstanceId>
  >(() => new Set());
  const refreshingRef = useRef(false);
  const updatingInstanceIdsRef = useRef<Set<ProviderInstanceId>>(new Set());

  const acceptUrlAuthentication = useStableCallback(
    (instanceId: ProviderInstanceId, action: AcpRegistryUrlAuthAction) => {
      void acceptAcpRegistryUrlAuth({
        environmentId,
        input: { instanceId, elicitationId: action.elicitationId },
      }).then((result) => {
        if (result._tag === "Success" && !result.value.accepted) {
          toastManager.add({
            type: "warning",
            title: "Authentication request expired",
            description: "Refresh the provider and start the authentication flow again.",
          });
          return;
        }
        if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
          const error = squashAtomCommandFailure(result);
          toastManager.add({
            type: "error",
            title: "Could not continue authentication",
            description:
              error instanceof Error ? error.message : "The authentication request expired.",
          });
        }
      });
    },
  );

  const visibleProviderSettings = PROVIDER_SETTINGS.filter(
    (providerSettings) =>
      providerSettings.provider !== "cursor" ||
      serverProviders.some(
        (provider) =>
          provider.instanceId === defaultInstanceIdForDriver(ProviderDriverKind.make("cursor")),
      ),
  );
  const resolvedBackgroundActivity = resolveServerBackgroundActivitySettings(settings);
  const providerHealthPreset = getBackgroundActivityPresetSettings(
    resolvedBackgroundActivity.profile,
  ).providerHealthRefreshInterval;
  const providerHealthRefreshIntervalSeconds = durationToSeconds(
    resolvedBackgroundActivity.providerHealthRefreshInterval,
  );
  const defaultProviderHealthRefreshIntervalSeconds = durationToSeconds(providerHealthPreset);

  const refreshProviders = () => {
    if (refreshingRef.current || !readEnvironmentScope(environmentId, AuthOrchestrationReadScope))
      return;
    refreshingRef.current = true;
    setIsRefreshingProviders(true);
    void (async () => {
      const result = await refreshServerProviders({
        environmentId,
        input: { refreshModels: true, reloadSecrets: true },
      });
      refreshingRef.current = false;
      setIsRefreshingProviders(false);
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        console.warn("Failed to refresh providers", {
          operation: "refresh-providers",
          environmentId,
          ...safeErrorLogAttributes(squashAtomCommandFailure(result)),
        });
      }
    })();
  };

  const runProviderUpdate = useStableCallback(
    async (
      candidate: Pick<ProviderSettingsUpdateCandidate, "driver" | "instanceId">,
      targetVersion?: string,
    ) => {
      if (!readEnvironmentScope(environmentId, AuthProvidersManageScope)) return;
      // Guard re-entry with a ref; deferred state updates cannot gate dispatch.
      if (updatingInstanceIdsRef.current.has(candidate.instanceId)) {
        return;
      }
      updatingInstanceIdsRef.current.add(candidate.instanceId);
      setUpdatingProviderInstanceIds((previous) => new Set(previous).add(candidate.instanceId));

      const result = await updateProvider({
        environmentId,
        input: {
          provider: candidate.driver,
          instanceId: candidate.instanceId,
          ...(targetVersion ? { targetVersion } : {}),
        },
      });
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: `Could not update ${PROVIDER_DISPLAY_NAMES[candidate.driver] ?? candidate.driver}`,
            description:
              error instanceof Error
                ? error.message
                : "The provider update command could not be started.",
          }),
        );
      }
      updatingInstanceIdsRef.current.delete(candidate.instanceId);
      setUpdatingProviderInstanceIds((previous) => {
        if (!previous.has(candidate.instanceId)) {
          return previous;
        }
        const next = new Set(previous);
        next.delete(candidate.instanceId);
        return next;
      });
    },
  );

  interface InstanceRow {
    readonly instanceId: ProviderInstanceId;
    /** Undefined for a default slot the user never configured. */
    readonly explicitInstance: ProviderInstanceConfig | undefined;
    readonly driver: ProviderDriverKind;
    readonly isDefault: boolean;
    readonly isDirty?: boolean;
  }

  const instancesByDriver = new Map<
    ProviderDriverKind,
    Array<[ProviderInstanceId, ProviderInstanceConfig]>
  >();
  for (const [rawId, instance] of Object.entries(settings.providerInstances ?? {})) {
    const driver = instance.driver;
    const list = instancesByDriver.get(driver) ?? [];
    list.push([rawId as ProviderInstanceId, instance]);
    instancesByDriver.set(driver, list);
  }

  const defaultSlotIdsBySource = new Set<string>(
    visibleProviderSettings.map((providerSettings) =>
      String(defaultInstanceIdForDriver(providerSettings.provider)),
    ),
  );

  const rows: InstanceRow[] = [];
  const visibleDriverKinds = new Set<ProviderDriverKind>(
    visibleProviderSettings.map((providerSettings) => providerSettings.provider),
  );

  for (const providerSettings of visibleProviderSettings) {
    const driver = providerSettings.provider;
    const defaultInstanceId = defaultInstanceIdForDriver(driver);
    const explicitInstance = settings.providerInstances?.[defaultInstanceId];
    const isDirty = explicitInstance !== undefined;
    const hasDefaultSlot = providerSettings.hasDefaultInstance || explicitInstance !== undefined;
    if (
      hasDefaultSlot &&
      (driver === "codex" ||
        driver === "claudeAgent" ||
        isDirty ||
        resolveProviderInstanceEnabled(explicitInstance ?? { driver }) ||
        defaultInstanceId === targetInstanceId)
    ) {
      rows.push({
        instanceId: defaultInstanceId,
        explicitInstance,
        driver,
        isDefault: true,
        isDirty,
      });
    }
    for (const [id, instance] of instancesByDriver.get(providerSettings.provider) ?? []) {
      if (id === defaultInstanceId) continue;
      rows.push({
        instanceId: id,
        explicitInstance: instance,
        driver: instance.driver,
        isDefault: false,
      });
    }
  }
  for (const [driver, list] of instancesByDriver) {
    if (visibleDriverKinds.has(driver)) continue;
    for (const [id, instance] of list) {
      rows.push({
        instanceId: id,
        explicitInstance: instance,
        driver: instance.driver,
        isDefault: defaultSlotIdsBySource.has(String(id)),
      });
    }
  }

  const targetInstanceMissing =
    targetInstanceId !== undefined &&
    selectedInstanceId === targetInstanceId &&
    !rows.some((row) => row.instanceId === targetInstanceId);
  const selectedRow =
    rows.find((row) => row.instanceId === selectedInstanceId) ??
    (targetInstanceMissing ? null : (rows[0] ?? null));

  const persistInstance = async (
    instanceId: ProviderInstanceId,
    next: ProviderInstanceConfig,
    textGenerationModelSelection?: Parameters<
      typeof buildProviderInstanceUpdatePatch
    >[0]["textGenerationModelSelection"],
  ) => {
    const { providerInstances: _providerInstances, ...patch } = buildProviderInstanceUpdatePatch({
      settings,
      instanceId,
      instance: next,
      textGenerationModelSelection,
    });
    const result = await persistProviderInstance(
      { operation: "upsert", instanceId, instance: next },
      patch,
    );
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      toastManager.add({
        type: "error",
        title: "Could not update provider instance",
        description: error instanceof Error ? error.message : "The settings update failed.",
      });
    }
  };

  const updateInstance = useStableCallback(
    (
      instanceId: ProviderInstanceId,
      previous: ProviderInstanceConfig,
      next: ProviderInstanceConfig,
    ) => {
      const isDisabling = next.enabled === false && resolveProviderInstanceEnabled(previous);
      const shouldClearTextGen =
        isDisabling &&
        resolveAppModelSelectionState(settings, serverProviders).instanceId === instanceId &&
        readEnvironmentScope(environmentId, AuthSettingsWriteScope);
      void persistInstance(
        instanceId,
        next,
        shouldClearTextGen ? DEFAULT_UNIFIED_SETTINGS.textGenerationModelSelection : undefined,
      );
    },
  );

  const enableInstance = useStableCallback(
    (instanceId: ProviderInstanceId, next: ProviderInstanceConfig) =>
      persistInstance(instanceId, next),
  );

  const deleteInstance = useStableCallback(
    async (instanceId: ProviderInstanceId, instance: ProviderInstanceConfig) => {
      const updateResult = await persistProviderInstance({
        operation: "remove",
        instanceId,
      });
      if (updateResult._tag === "Failure") {
        const error = squashAtomCommandFailure(updateResult);
        toastManager.add({
          type: "error",
          title: "Could not delete provider instance",
          description: error instanceof Error ? error.message : "The settings update failed.",
        });
        return;
      }

      if (instance.driver !== ProviderDriverKind.make("acpRegistry")) return;
      if (providerConfigString(instance.config, "source") === "local") return;
      const agentId = providerConfigString(instance.config, "agentId");
      if (agentId === null) return;

      // Concurrent removals race client snapshots; let the server decide whether the agent remains in use.
      const uninstallResult = await uninstallAcpRegistryManagedBinary({
        environmentId,
        input: { agentId },
      });
      if (uninstallResult._tag === "Failure" && !isAtomCommandInterrupted(uninstallResult)) {
        const error = squashAtomCommandFailure(uninstallResult);
        toastManager.add({
          type: "warning",
          title: "Provider deleted, but managed files remain",
          description: error instanceof Error ? error.message : "Managed binary cleanup failed.",
        });
      }
    },
  );

  const resetDefaultInstance = useStableCallback(async (driverKind: ProviderDriverKind) => {
    const result = await persistProviderInstance({
      operation: "remove",
      instanceId: defaultInstanceIdForDriver(driverKind),
    });
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      toastManager.add({
        type: "error",
        title: "Could not reset provider instance",
        description: error instanceof Error ? error.message : "The settings update failed.",
      });
    }
  });

  const writeProjectOverride = useStableCallback(
    (instanceId: ProviderInstanceId, next: boolean | undefined) => {
      updateSettings({
        projectSettingsOverrides: buildProviderInstanceOverridePatch(
          settings,
          projectIds,
          instanceId,
          next,
        ),
      });
    },
  );

  const stableUpdateModelPreferences = useStableCallback(updateModelPreferences);
  const stableToggleModelFavorite = useStableCallback(toggleModelFavorite);
  const actions: ProviderInstanceRowActions = {
    acceptUrlAuthentication,
    runProviderUpdate,
    updateInstance,
    enableInstance,
    deleteInstance,
    resetDefaultInstance,
    writeProjectOverride,
    updateModelPreferences: stableUpdateModelPreferences,
    toggleModelFavorite: stableToggleModelFavorite,
    selectInstance: setSelectedInstanceId,
  };
  // resolveModelPreferences falls back to a fresh `[]`; keep it stable for the rows.
  const favorites = settings.favorites.length > 0 ? settings.favorites : NO_FAVORITES;

  const representativeProjectId = projectIds[0];
  const renderProviderInstance = (row: InstanceRow, mode: "list" | "editor") => {
    const showProjectOverride =
      representativeProjectId !== undefined && supportsProjectProviderOverrides;
    return (
      <ProviderInstanceRow
        key={row.instanceId}
        environmentId={environmentId}
        environmentLabel={environmentLabel}
        instanceId={row.instanceId}
        driver={row.driver}
        explicitInstance={row.explicitInstance}
        isDefault={row.isDefault}
        isDirty={row.isDirty === true}
        mode={mode}
        selected={mode === "list" && selectedRow?.instanceId === row.instanceId}
        readOnly={readOnly}
        canWriteSettings={canWriteSettings}
        liveProvider={serverProviders.find((candidate) => candidate.instanceId === row.instanceId)}
        isUpdateDispatching={updatingProviderInstanceIds.has(row.instanceId)}
        showProjectOverride={showProjectOverride}
        projectOverrideValue={
          showProjectOverride
            ? settings.projectSettingsOverrides[representativeProjectId]?.providerInstances?.[
                row.instanceId
              ]?.enabled
            : undefined
        }
        projectOverrideEffectiveEnabled={
          showProjectOverride
            ? resolveProjectProviderInstanceEnabled(
                settings,
                representativeProjectId,
                row.instanceId,
              )
            : false
        }
        modelPreferences={settings.providerModelPreferences?.[row.instanceId]}
        favorites={favorites}
        actions={actions}
      />
    );
  };

  return (
    <>
      <SettingsSection
        {...searchableSetting("providers")}
        variant="plain"
        titleAction={
          canAddProvider ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    size="icon-xs"
                    variant="ghost-muted"
                    onClick={() => setIsAddInstanceDialogOpen(true)}
                    aria-label="Add provider"
                  >
                    <PlusIcon />
                  </Button>
                }
              />
              <TooltipPopup side="top">Add provider</TooltipPopup>
            </Tooltip>
          ) : null
        }
        headerAction={
          // The ghost button's padding would inset its label, so pull the text to the card edge.
          <div className="-me-2 flex min-w-0 items-center gap-2">
            <ProviderUpdatesAction />
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    size="xs"
                    variant="ghost-muted"
                    disabled={isRefreshingProviders || !canRefreshProviders}
                    aria-busy={isRefreshingProviders}
                    onClick={() => void refreshProviders()}
                  >
                    <RefreshIcon refreshing={isRefreshingProviders} />
                    <span className="sr-only">Refresh provider status</span>
                    <span className="hidden min-w-0 truncate sm:inline">
                      {isRefreshingProviders ? (
                        "Refreshing providers"
                      ) : (
                        <ProviderLastChecked environmentId={environmentId} />
                      )}
                    </span>
                  </Button>
                }
              />
              <TooltipPopup side="top">Refresh provider status</TooltipPopup>
            </Tooltip>
          </div>
        }
      >
        {deviceTabs ? (
          <div className="flex min-h-11 min-w-0 items-center gap-2 px-3 sm:px-4">{deviceTabs}</div>
        ) : null}
        {readOnly ? (
          <SettingsGroup divided={false} className="overflow-hidden">
            <SettingsRow
              title="Limited permissions"
              description={`This session can view ${environmentLabel}'s providers but can't change their settings.`}
            />
          </SettingsGroup>
        ) : null}
        <SettingsGroup
          divided={false}
          className={cn(
            providerCardHeightClassName,
            "overflow-hidden @min-[48rem]/providers:grid @min-[48rem]/providers:grid-cols-[17rem_minmax(0,1fr)]",
          )}
        >
          <div className="border-b border-border/60 bg-muted/10 @min-[48rem]/providers:flex @min-[48rem]/providers:min-h-0 @min-[48rem]/providers:flex-col @min-[48rem]/providers:border-r @min-[48rem]/providers:border-b-0">
            <ScrollArea
              scrollFade
              chainVerticalScroll
              className="@min-[48rem]/providers:min-h-0 @min-[48rem]/providers:flex-1"
            >
              <div className="divide-y divide-border/50">
                {rows.map((row) => renderProviderInstance(row, "list"))}
                {canAddProvider ? (
                  <button
                    type="button"
                    className="flex w-full cursor-pointer items-center gap-3 px-3 py-3 text-left text-sm text-muted-foreground transition-colors outline-none hover:bg-muted/25 hover:text-foreground focus-visible:bg-muted/25 focus-visible:text-foreground sm:px-4"
                    onClick={() => setIsAddInstanceDialogOpen(true)}
                  >
                    <PlusIcon className="size-4 shrink-0" />
                    Add provider
                  </button>
                ) : null}
              </div>
            </ScrollArea>
          </div>

          <div data-provider-detail className="min-w-0 @min-[48rem]/providers:min-h-0">
            {selectedRow ? (
              <ScrollArea scrollFade chainVerticalScroll className="@min-[48rem]/providers:h-full">
                {/* Flat sections run dividers edge to edge and inset text like the list beside them. */}
                <div className="space-y-6 py-4">
                  {renderProviderInstance(selectedRow, "editor")}
                </div>
              </ScrollArea>
            ) : (
              <div className="p-6 text-sm text-muted-foreground">
                {targetInstanceMissing
                  ? "This provider instance is no longer available on this device."
                  : "No providers configured."}
              </div>
            )}
          </div>
        </SettingsGroup>
      </SettingsSection>

      <UsageProviderSettings
        key={environmentId}
        environmentId={environmentId}
        environmentLabel={environmentLabel}
        sources={settings.usageLimitSources}
        cursorKeychainUsageEnabled={settings.cursorKeychainUsageEnabled}
        readOnly={readOnly}
      />

      <SettingsSection title="Advanced">
        <SettingsRow
          id={searchableSetting("provider-health-check-interval").id}
          title={
            <span className="inline-flex items-center gap-1.5">
              {searchableSetting("provider-health-check-interval").title}
              <PolicyTooltip>
                This interval is configured here, then the shared Background activity policy decides
                whether provider probes may run when the timer fires. Custom intervals appear as
                Advanced in Maintenance settings.
              </PolicyTooltip>
            </span>
          }
          description="Refresh provider status, versions, and models in the background. Set to 0 to disable."
          resetAction={
            providerHealthRefreshIntervalSeconds !== defaultProviderHealthRefreshIntervalSeconds ? (
              <span
                inert={!canWriteSettings}
                className={!canWriteSettings ? "opacity-50" : undefined}
              >
                <SettingResetButton
                  label="provider health check interval"
                  onClick={() =>
                    updateSettings(
                      backgroundActivityOverrideSettings(
                        settings.backgroundActivity,
                        resolvedBackgroundActivity,
                        { providerHealthRefreshInterval: undefined },
                      ),
                    )
                  }
                />
              </span>
            ) : null
          }
          control={
            <div
              inert={!canWriteSettings}
              aria-disabled={!canWriteSettings || undefined}
              className={cn(
                "flex shrink-0 items-center gap-2",
                !canWriteSettings && "opacity-50 select-none",
              )}
            >
              <IntervalSecondsField
                label="provider health check interval"
                value={providerHealthRefreshIntervalSeconds}
                min={0}
                step={PROVIDER_HEALTH_INTERVAL_STEP_SECONDS}
                onCommit={(seconds, options) =>
                  updateSettings(
                    backgroundActivityOverrideSettings(
                      settings.backgroundActivity,
                      resolvedBackgroundActivity,
                      { providerHealthRefreshInterval: Duration.seconds(seconds) },
                    ),
                    options,
                  )
                }
              />
              <span className="text-xs text-muted-foreground">seconds</span>
            </div>
          }
        />
        <CompactIdleThreadsRow />
      </SettingsSection>

      {isAddInstanceDialogOpen && !readOnly ? (
        <AddProviderInstanceDialog
          open
          environmentId={environmentId}
          environmentLabel={environmentLabel}
          onOpenChange={setIsAddInstanceDialogOpen}
          onCreated={setSelectedInstanceId}
        />
      ) : null}
    </>
  );
}

interface ProviderInstanceRowActions {
  readonly acceptUrlAuthentication: (
    instanceId: ProviderInstanceId,
    action: AcpRegistryUrlAuthAction,
  ) => void;
  readonly runProviderUpdate: (
    candidate: Pick<ProviderSettingsUpdateCandidate, "driver" | "instanceId">,
    targetVersion?: string,
  ) => Promise<void>;
  readonly updateInstance: (
    instanceId: ProviderInstanceId,
    previous: ProviderInstanceConfig,
    next: ProviderInstanceConfig,
  ) => void;
  readonly enableInstance: (
    instanceId: ProviderInstanceId,
    next: ProviderInstanceConfig,
  ) => Promise<void>;
  readonly deleteInstance: (
    instanceId: ProviderInstanceId,
    instance: ProviderInstanceConfig,
  ) => Promise<void>;
  readonly resetDefaultInstance: (driverKind: ProviderDriverKind) => Promise<void>;
  readonly writeProjectOverride: (
    instanceId: ProviderInstanceId,
    next: boolean | undefined,
  ) => void;
  readonly updateModelPreferences: ReturnType<typeof useUpdateEnvironmentModelPreferences>;
  readonly toggleModelFavorite: ReturnType<typeof useToggleEnvironmentModelFavorite>;
  readonly selectInstance: (instanceId: ProviderInstanceId) => void;
}

const NO_MODELS: ReadonlyArray<string> = [];

/** Stable props let this boundary return cached cards even when settings rebuild parent row elements. */
function ProviderInstanceRow({
  environmentId,
  environmentLabel,
  instanceId,
  driver,
  explicitInstance,
  isDefault,
  isDirty,
  mode,
  selected,
  readOnly,
  canWriteSettings,
  liveProvider,
  isUpdateDispatching,
  showProjectOverride,
  projectOverrideValue,
  projectOverrideEffectiveEnabled,
  modelPreferences,
  favorites,
  actions,
}: {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly instanceId: ProviderInstanceId;
  readonly driver: ProviderDriverKind;
  readonly explicitInstance: ProviderInstanceConfig | undefined;
  readonly isDefault: boolean;
  readonly isDirty: boolean;
  readonly mode: "list" | "editor";
  readonly selected: boolean;
  readonly readOnly: boolean;
  readonly canWriteSettings: boolean;
  readonly liveProvider: ServerProvider | undefined;
  readonly isUpdateDispatching: boolean;
  readonly showProjectOverride: boolean;
  readonly projectOverrideValue: boolean | undefined;
  readonly projectOverrideEffectiveEnabled: boolean;
  readonly modelPreferences:
    | { readonly hiddenModels: ReadonlyArray<string>; readonly modelOrder: ReadonlyArray<string> }
    | undefined;
  readonly favorites: UnifiedSettings["favorites"];
  readonly actions: ProviderInstanceRowActions;
}) {
  const allProjects = useProjects();
  const secretSources = useSecretSources(environmentId);
  const acpProjects =
    mode === "editor" && liveProvider?.driver === "acpRegistry"
      ? allProjects.filter((project) => project.environmentId === environmentId)
      : undefined;
  const instance = explicitInstance ?? { driver };
  const driverOption = providerClients.get(driver);
  const updateCandidate =
    liveProvider !== undefined && isProviderSettingsUpdateCandidate(liveProvider)
      ? liveProvider
      : undefined;
  const isInstanceUpdateRunning =
    isUpdateDispatching || (liveProvider !== undefined && isProviderUpdateActive(liveProvider));
  const hiddenModels = modelPreferences?.hiddenModels ?? NO_MODELS;
  const modelOrder = modelPreferences?.modelOrder ?? NO_MODELS;
  const favoriteModels = Arr.filterMap(favorites, (favorite) =>
    favorite.provider === instanceId ? Result.succeed(favorite.model) : Result.failVoid,
  );
  const resetLabel = driverOption?.label ?? String(driver);
  const projectOverride = showProjectOverride
    ? {
        value: projectOverrideValue,
        effectiveEnabled: projectOverrideEffectiveEnabled,
        onChange: (next: boolean) => actions.writeProjectOverride(instanceId, next),
        onReset: () => actions.writeProjectOverride(instanceId, undefined),
      }
    : undefined;
  const codexSetupMode = driver === "codex" ? readCodexSetupMode(instance.config) : null;
  const recommendedVersion = liveProvider?.compatibilityAdvisory?.recommendedVersion;
  const canInstallRecommended =
    !readOnly &&
    liveProvider !== undefined &&
    Boolean(liveProvider.compatibilityAdvisory?.message) &&
    Boolean(recommendedVersion) &&
    liveProvider.versionAdvisory?.canInstallVersion === true;

  return (
    <ProviderInstanceCard
      environmentId={environmentId}
      secretSources={secretSources}
      acpProjects={acpProjects}
      projectOverride={projectOverride}
      onAcceptUrlAuth={
        readOnly ? undefined : (action) => actions.acceptUrlAuthentication(instanceId, action)
      }
      instanceId={instanceId}
      instance={instance}
      driverOption={driverOption}
      liveProvider={liveProvider}
      mode={mode}
      selected={selected}
      onSelect={mode === "list" ? () => actions.selectInstance(instanceId) : undefined}
      readOnly={readOnly}
      runtime={
        mode === "editor" && codexSetupMode === "managed" ? (
          <CodexManagedRuntimeFields
            environmentId={environmentId}
            instanceId={instanceId}
            provider={liveProvider}
          />
        ) : undefined
      }
      canWriteSettings={canWriteSettings}
      setup={
        mode === "editor" && driver === "antigravity" ? (
          <ProviderSetupSection
            environmentId={environmentId}
            environmentLabel={environmentLabel}
            instanceId={instanceId}
            provider={liveProvider}
            binaryPath={configuredBinaryPath(instance.config)}
            authMethod={readAntigravityAuthMethod(instance.config)}
            enabled={resolveProviderInstanceEnabled(instance)}
            readOnly={readOnly}
            onEnable={() => actions.enableInstance(instanceId, { ...instance, enabled: true })}
          />
        ) : mode === "editor" && codexSetupMode === "managed" ? (
          <CodexSetupSection
            environmentId={environmentId}
            instanceId={instanceId}
            provider={liveProvider}
            mode={codexSetupMode}
            enabled={resolveProviderInstanceEnabled(instance)}
            readOnly={readOnly}
            onModeChange={(setupMode) =>
              actions.enableInstance(instanceId, {
                ...instance,
                enabled: true,
                config: {
                  ...(instance.config !== null && typeof instance.config === "object"
                    ? instance.config
                    : {}),
                  enabled: true,
                  setupMode,
                },
              })
            }
          />
        ) : mode === "editor" &&
          !readOnly &&
          liveProvider &&
          (liveProvider.setup?.canAuthenticate ||
            (liveProvider.driver === "acpRegistry" && liveProvider.installed)) ? (
          <ProviderAuthenticationSection
            key={`${environmentId}:${instanceId}`}
            environmentId={environmentId}
            environmentLabel={environmentLabel}
            instanceId={instanceId}
            provider={liveProvider}
            readOnly={readOnly}
          />
        ) : mode === "editor" &&
          !readOnly &&
          driver === "cursor" &&
          liveProvider?.setup?.canAuthenticate === false ? (
          <SettingsRow
            title="Cursor account"
            description="Using CURSOR_API_KEY. Remove it from this provider's environment to use browser sign-in."
          />
        ) : null
      }
      onUpdate={(next) => actions.updateInstance(instanceId, instance, next)}
      onDelete={
        mode === "editor" && !isDefault
          ? () => actions.deleteInstance(instanceId, instance)
          : undefined
      }
      headerAction={
        mode === "editor" && isDefault && isDirty ? (
          <SettingResetButton
            label={`${resetLabel} provider settings`}
            onClick={() => actions.resetDefaultInstance(driver)}
          />
        ) : null
      }
      hiddenModels={hiddenModels}
      favoriteModels={favoriteModels}
      modelOrder={modelOrder}
      onHiddenModelsChange={(next, affectedModels) => {
        const hidden = new Set(next);
        void actions.updateModelPreferences({
          setModelsHidden: affectedModels.map((model) => ({
            provider: instanceId,
            model,
            hidden: hidden.has(model),
          })),
        });
      }}
      onToggleFavorite={(model) => {
        void actions.toggleModelFavorite(instanceId, model);
      }}
      onFavoriteModelsChange={(next) => {
        void actions.updateModelPreferences({
          setModelFavorites: modelListChanges(favoriteModels, next).map(({ model, selected }) => ({
            provider: instanceId,
            model,
            favorite: selected,
          })),
        });
      }}
      onModelOrderChange={(nextOrder) => {
        void actions.updateModelPreferences({
          setProviderModelOrder: { provider: instanceId, modelOrder: nextOrder },
        });
      }}
      onInstallRecommended={
        canInstallRecommended
          ? () => {
              void actions.runProviderUpdate(liveProvider, recommendedVersion ?? undefined);
            }
          : undefined
      }
      onRunUpdate={
        !readOnly && updateCandidate
          ? () => {
              if (!isInstanceUpdateRunning) void actions.runProviderUpdate(updateCandidate);
            }
          : undefined
      }
      isUpdating={isInstanceUpdateRunning}
    />
  );
}
