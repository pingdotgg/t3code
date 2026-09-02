import { useAtomValue } from "@effect/atom-react";
import { connectionStatusText } from "@t3tools/client-runtime/connection";
import { safeErrorLogAttributes } from "@t3tools/client-runtime/errors";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  defaultInstanceIdForDriver,
  type EnvironmentId,
  PROVIDER_DISPLAY_NAMES,
  ProviderDriverKind,
  type ProviderInstanceConfig,
  type ProviderInstanceId,
  resolveProviderInstanceEnabled,
} from "@t3tools/contracts";
import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts/settings";
import {
  getBackgroundActivityPresetSettings,
  resolveServerBackgroundActivitySettings,
} from "@t3tools/shared/backgroundActivitySettings";
import * as Arr from "effect/Array";
import * as Duration from "effect/Duration";
import * as Equal from "effect/Equal";
import * as Result from "effect/Result";
import {
  ChevronDownIcon,
  CloudIcon,
  LaptopIcon,
  LoaderIcon,
  MonitorIcon,
  PlusIcon,
  RefreshCwIcon,
  TerminalIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { isDesktopLocalConnectionTarget } from "../../connection/desktopLocal";
import { isElectron } from "../../env";
import { usePrimarySessionState } from "../../environments/primary";
import { useEnvironmentSettings, useUpdateEnvironmentSettings } from "../../hooks/useSettings";
import { cn } from "../../lib/utils";
import { resolveAppModelSelectionState } from "../../modelSelection";
import {
  useEnvironments,
  usePrimaryEnvironmentId,
  type EnvironmentPresentation,
} from "../../state/environments";
import { EMPTY_SERVER_PROVIDERS, serverEnvironment } from "../../state/server";
import { useEnvironmentSessionState } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { getRelativeTimeState } from "../../timestampFormat";
import {
  ConnectionStatusDot,
  connectionPhaseDotClassName,
  connectionPhasePingClassName,
} from "../ConnectionStatusDot";
import {
  canOneClickUpdateProviderCandidate,
  collectProviderUpdateCandidates,
  hasOneClickUpdateProviderCandidate,
  isProviderUpdateActive,
  type ProviderUpdateCandidate,
} from "../ProviderUpdateLaunchNotification.logic";
import { Button } from "../ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../ui/collapsible";
import {
  NumberField,
  NumberFieldDecrement,
  NumberFieldGroup,
  NumberFieldIncrement,
  NumberFieldInput,
} from "../ui/number-field";
import { ScrollArea } from "../ui/scroll-area";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { AddProviderInstanceDialog } from "./AddProviderInstanceDialog";
import { ProviderInstanceCard } from "./ProviderInstanceCard";
import { DRIVER_OPTIONS, getDriverOption } from "./providerDriverMeta";
import { providerSettingsTabClassName } from "./providerSettingsTabs";
import { searchableSetting } from "./settingsSearch";
import {
  backgroundActivityOverrideSettings,
  buildProviderInstanceUpdatePatch,
  durationToSeconds,
  normalizeIntervalSeconds,
  PROVIDER_HEALTH_INTERVAL_STEP_SECONDS,
} from "./SettingsPanels.logic";
import {
  PolicyTooltip,
  SettingResetButton,
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
  useRelativeTimeTick,
  useSettingsSearchTargetId,
} from "./settingsLayout";
import {
  buildProviderEnvironmentOptions,
  classifyProviderEnvironmentAccess,
  isProviderSettingsEnvironmentAvailable,
  type ProviderEnvironmentAccess,
  type ProviderOperateAccess,
  resolvePrimaryOperateAccess,
  resolveRemoteOperateAccess,
  resolveSelectedProviderEnvironmentId,
} from "./ProviderSettingsPanel.logic";

function withoutProviderInstanceKey<V>(
  record: Readonly<Record<ProviderInstanceId, V>> | undefined,
  key: ProviderInstanceId,
): Record<ProviderInstanceId, V> {
  const next = { ...record } as Record<ProviderInstanceId, V>;
  delete next[key];
  return next;
}

function withoutProviderInstanceFavorites(
  favorites: ReadonlyArray<{ readonly provider: ProviderInstanceId; readonly model: string }>,
  instanceId: ProviderInstanceId,
) {
  return favorites.filter((favorite) => favorite.provider !== instanceId);
}

const PROVIDER_SETTINGS = DRIVER_OPTIONS.map((definition) => ({
  provider: definition.value,
}));

function ProviderLastChecked({ lastCheckedAt }: { lastCheckedAt: string | null }) {
  useRelativeTimeTick();
  const lastCheckedRelative = getRelativeTimeState(lastCheckedAt);

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

function providerEnvironmentIcon(environment: EnvironmentPresentation) {
  if (environment.entry.target._tag === "PrimaryConnectionTarget") return MonitorIcon;
  if (environment.entry.target._tag === "RelayConnectionTarget") return CloudIcon;
  if (environment.entry.target._tag === "SshConnectionTarget") return TerminalIcon;
  if (isDesktopLocalConnectionTarget(environment.entry.target)) return LaptopIcon;
  return CloudIcon;
}

function providerEnvironmentDetail(environment: EnvironmentPresentation): string {
  if (environment.entry.target._tag === "PrimaryConnectionTarget") return "Primary device";
  if (environment.relayManaged) return "T3 Connect";
  if (environment.entry.target._tag === "SshConnectionTarget") return "SSH";
  if (isDesktopLocalConnectionTarget(environment.entry.target)) return "Local device";
  return environment.displayUrl ?? "Remote device";
}

function EnvironmentUnavailableRow({
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
    : connectionStatusText(environment.connection);
  // No spinner: this state can persist indefinitely for a wedged device, and a
  // continuously repainting animation would run the whole time.
  return (
    <SettingsSection {...searchableSetting("providers")}>
      {deviceTabs}
      <SettingsRow title={title} description={description} />
    </SettingsSection>
  );
}

export function ProviderSettingsPanel() {
  return (
    <SettingsPageContainer className="gap-8">
      <ProviderSettingsPanelContent />
    </SettingsPageContainer>
  );
}

function ProviderSettingsPanelContent() {
  const { environments, isReady } = useEnvironments();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const searchTargetId = useSettingsSearchTargetId();
  const options = useMemo(
    () => buildProviderEnvironmentOptions(environments, primaryEnvironmentId),
    [environments, primaryEnvironmentId],
  );
  // Raw user intent; the effective selection is re-derived every render so a
  // device that drops out of the catalog falls back without erasing the pick —
  // if it reappears (e.g. after a reconnect) the selection is restored.
  const [selectedEnvironmentId, setSelectedEnvironmentId] = useState<EnvironmentId | null>(
    primaryEnvironmentId,
  );
  const effectiveEnvironmentId = resolveSelectedProviderEnvironmentId(
    options,
    selectedEnvironmentId,
    primaryEnvironmentId,
  );
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
  useEffect(() => {
    if (
      searchTargetId === searchableSetting("provider-health-check-interval").id &&
      !selectedEnvironmentCanRenderSettings &&
      searchableEnvironmentId !== undefined
    ) {
      setSelectedEnvironmentId(searchableEnvironmentId);
    }
  }, [searchTargetId, searchableEnvironmentId, selectedEnvironmentCanRenderSettings]);
  const onlyPrimaryDevice =
    options.length === 1 && options[0]?.entry.target._tag === "PrimaryConnectionTarget";
  const deviceTabs =
    !onlyPrimaryDevice && options.length > 0 ? (
      <ScrollArea hideScrollbars scrollFade className="mx-3 h-11 min-w-0 rounded-none sm:mx-4">
        <div
          role="group"
          aria-label="Devices"
          className="flex h-full w-max min-w-full border-b border-border/70 px-1"
        >
          {options.map((environment) => {
            const Icon = providerEnvironmentIcon(environment);
            const selected = environment.environmentId === effectiveEnvironmentId;
            const detail = providerEnvironmentDetail(environment);
            const statusText = connectionStatusText(environment.connection);
            return (
              <Tooltip key={environment.environmentId}>
                <TooltipTrigger
                  render={
                    <button
                      type="button"
                      aria-pressed={selected}
                      className={cn(providerSettingsTabClassName(selected), "gap-2 text-left")}
                      onClick={() => setSelectedEnvironmentId(environment.environmentId)}
                    >
                      <Icon className="size-3.5 shrink-0" aria-hidden />
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
                    </button>
                  }
                />
                <TooltipPopup side="top">
                  {detail} · {statusText}
                </TooltipPopup>
              </Tooltip>
            );
          })}
        </div>
      </ScrollArea>
    ) : null;

  return (
    <>
      {options.length === 0 ? (
        <SettingsSection {...searchableSetting("providers")}>
          <SettingsRow
            title={isReady ? "No connected devices" : "Loading devices"}
            description={
              isReady
                ? "Connect an execution environment before configuring providers."
                : "Reading connected execution environments."
            }
          />
        </SettingsSection>
      ) : null}

      {selectedEnvironment ? (
        <SelectedEnvironmentProviderSettings
          key={selectedEnvironment.environmentId}
          environment={selectedEnvironment}
          deviceTabs={deviceTabs}
        />
      ) : null}
    </>
  );
}

function SelectedEnvironmentProviderSettings({
  environment,
  deviceTabs,
}: {
  readonly environment: EnvironmentPresentation;
  readonly deviceTabs?: ReactNode;
}) {
  const isPrimary = environment.entry.target._tag === "PrimaryConnectionTarget";
  if (isPrimary) {
    // The desktop app owns its primary server outright; a browser session
    // checks the scopes its cookie session was granted.
    if (isElectron) {
      return (
        <AccessGatedProviderSettings
          environment={environment}
          operateAccess="granted"
          deviceTabs={deviceTabs}
        />
      );
    }
    return (
      <PrimarySessionGatedProviderSettings environment={environment} deviceTabs={deviceTabs} />
    );
  }
  return <RemoteSessionGatedProviderSettings environment={environment} deviceTabs={deviceTabs} />;
}

function PrimarySessionGatedProviderSettings({
  environment,
  deviceTabs,
}: {
  readonly environment: EnvironmentPresentation;
  readonly deviceTabs?: ReactNode;
}) {
  const primarySessionState = usePrimarySessionState();
  const operateAccess = resolvePrimaryOperateAccess({
    isPrimary: true,
    hasDesktopBridge: false,
    session: primarySessionState.data,
    isPending: primarySessionState.isPending,
    hasError: primarySessionState.error !== null,
  });
  return (
    <AccessGatedProviderSettings
      environment={environment}
      operateAccess={operateAccess}
      deviceTabs={deviceTabs}
    />
  );
}

function RemoteSessionGatedProviderSettings({
  environment,
  deviceTabs,
}: {
  readonly environment: EnvironmentPresentation;
  readonly deviceTabs?: ReactNode;
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
    />
  );
}

function AccessGatedProviderSettings({
  environment,
  operateAccess,
  deviceTabs,
}: {
  readonly environment: EnvironmentPresentation;
  readonly operateAccess: ProviderOperateAccess;
  readonly deviceTabs?: ReactNode;
}) {
  const access = classifyProviderEnvironmentAccess({
    connectionPhase: environment.connection.phase,
    hasServerConfig: environment.serverConfig !== null,
    operateAccess,
  });
  if (access.kind !== "editable" && access.kind !== "read-only") {
    return (
      <EnvironmentUnavailableRow
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
    />
  );
}

export function EnvironmentProviderSettings({
  environmentId,
  environmentLabel,
  readOnly = false,
  deviceTabs,
}: {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly deviceTabs?: ReactNode;
  /**
   * Grey out and freeze every write control when this session's credential
   * lacks `orchestration:operate` on the environment. Selecting providers and
   * opening Advanced still work so the real configuration stays readable;
   * switches, forms, and the health interval are inert so no write is
   * offered and then rejected.
   */
  readonly readOnly?: boolean;
}) {
  const settings = useEnvironmentSettings(environmentId);
  const updateSettings = useUpdateEnvironmentSettings(environmentId);
  const serverProviders =
    useAtomValue(serverEnvironment.providersValueAtom(environmentId)) ?? EMPTY_SERVER_PROVIDERS;
  const refreshServerProviders = useAtomCommand(serverEnvironment.refreshProviders, {
    reportFailure: false,
  });
  const updateProvider = useAtomCommand(serverEnvironment.updateProvider, {
    reportFailure: false,
  });
  const [isRefreshingProviders, setIsRefreshingProviders] = useState(false);
  const [isAddInstanceDialogOpen, setIsAddInstanceDialogOpen] = useState(false);
  const [selectedInstanceId, setSelectedInstanceId] = useState<ProviderInstanceId | null>(null);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const searchTargetId = useSettingsSearchTargetId();
  const [updatingProviderDrivers, setUpdatingProviderDrivers] = useState<
    ReadonlySet<ProviderDriverKind>
  >(() => new Set());
  const refreshingRef = useRef(false);
  const updatingDriversRef = useRef<Set<ProviderDriverKind>>(new Set());

  useEffect(() => {
    if (searchTargetId === searchableSetting("provider-health-check-interval").id) {
      setAdvancedOpen(true);
    }
  }, [searchTargetId]);

  const providerUpdateCandidates = useMemo(
    () => collectProviderUpdateCandidates(serverProviders),
    [serverProviders],
  );
  const providerUpdateCandidateByInstanceId = useMemo(
    () => new Map(providerUpdateCandidates.map((candidate) => [candidate.instanceId, candidate])),
    [providerUpdateCandidates],
  );
  const visibleProviderSettings = PROVIDER_SETTINGS.filter(
    (providerSettings) =>
      providerSettings.provider !== "cursor" ||
      serverProviders.some(
        (provider) =>
          provider.instanceId === defaultInstanceIdForDriver(ProviderDriverKind.make("cursor")),
      ),
  );
  const textGenerationModelSelection = resolveAppModelSelectionState(settings, serverProviders);
  const textGenInstanceId = textGenerationModelSelection.instanceId;
  const resolvedBackgroundActivity = resolveServerBackgroundActivitySettings(settings);
  const providerHealthPreset = getBackgroundActivityPresetSettings(
    resolvedBackgroundActivity.profile,
  ).providerHealthRefreshInterval;
  const providerHealthRefreshIntervalSeconds = durationToSeconds(
    resolvedBackgroundActivity.providerHealthRefreshInterval,
  );
  const defaultProviderHealthRefreshIntervalSeconds = durationToSeconds(providerHealthPreset);
  const lastCheckedAt =
    serverProviders.length > 0
      ? serverProviders.reduce(
          (latest, provider) => (provider.checkedAt > latest ? provider.checkedAt : latest),
          serverProviders[0]!.checkedAt,
        )
      : null;

  const refreshProviders = useCallback(() => {
    if (refreshingRef.current) return;
    refreshingRef.current = true;
    setIsRefreshingProviders(true);
    void (async () => {
      const result = await refreshServerProviders({
        environmentId,
        input: {},
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
  }, [environmentId, refreshServerProviders]);

  const runProviderUpdate = useCallback(
    async (candidate: ProviderUpdateCandidate) => {
      // Ref-based re-entry guard, mirroring refreshProviders: a state updater
      // may run after this function returns, so it cannot gate the dispatch.
      if (updatingDriversRef.current.has(candidate.driver)) {
        return;
      }
      updatingDriversRef.current.add(candidate.driver);
      setUpdatingProviderDrivers((previous) => new Set(previous).add(candidate.driver));

      const result = await updateProvider({
        environmentId,
        input: {
          provider: candidate.driver,
          instanceId: candidate.instanceId,
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
      updatingDriversRef.current.delete(candidate.driver);
      setUpdatingProviderDrivers((previous) => {
        if (!previous.has(candidate.driver)) {
          return previous;
        }
        const next = new Set(previous);
        next.delete(candidate.driver);
        return next;
      });
    },
    [environmentId, updateProvider],
  );

  interface InstanceRow {
    readonly instanceId: ProviderInstanceId;
    readonly instance: ProviderInstanceConfig;
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
    type LegacyProviderSettings = (typeof settings.providers)[keyof typeof settings.providers];
    const legacyProviders = settings.providers as Record<string, LegacyProviderSettings>;
    const defaultLegacyProviders = DEFAULT_UNIFIED_SETTINGS.providers as Record<
      string,
      LegacyProviderSettings
    >;
    const driver = providerSettings.provider;
    const defaultInstanceId = defaultInstanceIdForDriver(driver);
    const explicitInstance = settings.providerInstances?.[defaultInstanceId];
    // A remote device may run a server version whose settings predate this
    // driver, so the legacy mirror can be absent. Without either an explicit
    // instance or a legacy blob there is nothing to render for the slot.
    const legacyConfig = legacyProviders[providerSettings.provider];
    const defaultLegacyConfig = defaultLegacyProviders[providerSettings.provider];
    // The envelope is the single enabled flag: keep the legacy in-config
    // flag out of the synthesized blob, or an explicit `enabled: false`
    // would keep winning over the envelope and the Switch could never
    // turn a default-off provider on.
    const synthesizedInstance = (): ProviderInstanceConfig | undefined => {
      if (legacyConfig === undefined) {
        return undefined;
      }
      const { enabled: legacyEnabled, ...legacyConfigRest } = legacyConfig;
      return {
        driver,
        enabled: legacyEnabled,
        config: legacyConfigRest,
      } satisfies ProviderInstanceConfig;
    };
    const effectiveInstance: ProviderInstanceConfig | undefined =
      explicitInstance ?? synthesizedInstance();
    // Only the default slot depends on the legacy blob; custom instances for
    // the driver must still render even when the slot has nothing to show.
    if (effectiveInstance !== undefined) {
      const isDirty =
        explicitInstance !== undefined || !Equal.equals(legacyConfig, defaultLegacyConfig);
      rows.push({
        instanceId: defaultInstanceId,
        instance: effectiveInstance,
        driver,
        isDefault: true,
        isDirty,
      });
    }
    for (const [id, instance] of instancesByDriver.get(providerSettings.provider) ?? []) {
      if (id === defaultInstanceId) continue;
      rows.push({ instanceId: id, instance, driver: instance.driver, isDefault: false });
    }
  }
  for (const [driver, list] of instancesByDriver) {
    if (visibleDriverKinds.has(driver)) continue;
    for (const [id, instance] of list) {
      rows.push({
        instanceId: id,
        instance,
        driver: instance.driver,
        isDefault: defaultSlotIdsBySource.has(String(id)),
      });
    }
  }

  const selectedRow = rows.find((row) => row.instanceId === selectedInstanceId) ?? rows[0] ?? null;

  const updateProviderInstance = (
    row: InstanceRow,
    next: ProviderInstanceConfig,
    options?: {
      readonly textGenerationModelSelection?: Parameters<
        typeof buildProviderInstanceUpdatePatch
      >[0]["textGenerationModelSelection"];
    },
  ) => {
    updateSettings(
      buildProviderInstanceUpdatePatch({
        settings,
        instanceId: row.instanceId,
        instance: next,
        driver: row.driver,
        isDefault: row.isDefault,
        textGenerationModelSelection: options?.textGenerationModelSelection,
      }),
    );
  };

  const deleteProviderInstance = (id: ProviderInstanceId) => {
    updateSettings({
      providerInstances: withoutProviderInstanceKey(settings.providerInstances, id),
    });
  };

  const updateProviderModelPreferences = (
    instanceId: ProviderInstanceId,
    next: {
      readonly hiddenModels: ReadonlyArray<string>;
      readonly modelOrder: ReadonlyArray<string>;
    },
  ) => {
    const hiddenModels = [...new Set(next.hiddenModels.filter((slug) => slug.trim().length > 0))];
    const modelOrder = [...new Set(next.modelOrder.filter((slug) => slug.trim().length > 0))];
    const rest = withoutProviderInstanceKey(settings.providerModelPreferences, instanceId);
    updateSettings({
      providerModelPreferences:
        hiddenModels.length === 0 && modelOrder.length === 0
          ? rest
          : {
              ...rest,
              [instanceId]: {
                hiddenModels,
                modelOrder,
              },
            },
    });
  };

  const updateProviderFavoriteModels = (
    instanceId: ProviderInstanceId,
    nextFavoriteModels: ReadonlyArray<string>,
  ) => {
    const favoriteModels = [
      ...new Set(
        Arr.filterMap(nextFavoriteModels, (slug) => {
          const trimmedSlug = slug.trim();
          return trimmedSlug.length > 0 ? Result.succeed(trimmedSlug) : Result.failVoid;
        }),
      ),
    ];
    updateSettings({
      favorites: [
        ...withoutProviderInstanceFavorites(settings.favorites ?? [], instanceId),
        ...favoriteModels.map((model) => ({ provider: instanceId, model })),
      ],
    });
  };

  const resetDefaultInstance = (driverKind: ProviderDriverKind) => {
    type LegacyProviderSettings = (typeof settings.providers)[keyof typeof settings.providers];
    const defaultLegacyProviders = DEFAULT_UNIFIED_SETTINGS.providers as Record<
      string,
      LegacyProviderSettings | undefined
    >;
    const defaultInstanceId = defaultInstanceIdForDriver(driverKind);
    const defaultLegacyProvider = defaultLegacyProviders[driverKind];
    if (defaultLegacyProvider === undefined) return;
    updateSettings({
      providers: {
        ...settings.providers,
        [driverKind]: defaultLegacyProvider,
      } as typeof settings.providers,
      providerInstances: withoutProviderInstanceKey(settings.providerInstances, defaultInstanceId),
    });
  };

  const renderProviderInstance = (row: InstanceRow, mode: "list" | "editor") => {
    const driverOption = getDriverOption(row.driver);
    const liveProvider = serverProviders.find(
      (candidate) => candidate.instanceId === row.instanceId,
    );
    const updateCandidate = liveProvider
      ? providerUpdateCandidateByInstanceId.get(liveProvider.instanceId)
      : undefined;
    const isDriverUpdateRunning =
      updateCandidate !== undefined &&
      (updatingProviderDrivers.has(updateCandidate.driver) ||
        serverProviders.some(
          (provider) =>
            provider.driver === updateCandidate.driver && isProviderUpdateActive(provider),
        ));
    const showInlineUpdateButton =
      updateCandidate !== undefined &&
      hasOneClickUpdateProviderCandidate(updateCandidate, serverProviders);
    const canRunInlineUpdate =
      updateCandidate !== undefined &&
      canOneClickUpdateProviderCandidate(updateCandidate, serverProviders) &&
      !updatingProviderDrivers.has(updateCandidate.driver);
    const modelPreferences = settings.providerModelPreferences?.[row.instanceId] ?? {
      hiddenModels: [],
      modelOrder: [],
    };
    const favoriteModels = Arr.filterMap(settings.favorites ?? [], (favorite) =>
      favorite.provider === row.instanceId ? Result.succeed(favorite.model) : Result.failVoid,
    );
    const resetLabel = driverOption?.label ?? String(row.driver);

    return (
      <ProviderInstanceCard
        key={row.instanceId}
        instanceId={row.instanceId}
        instance={row.instance}
        driverOption={driverOption}
        liveProvider={liveProvider}
        mode={mode}
        selected={mode === "list" && selectedRow?.instanceId === row.instanceId}
        onSelect={mode === "list" ? () => setSelectedInstanceId(row.instanceId) : undefined}
        readOnly={readOnly}
        onUpdate={(next) => {
          const wasEnabled = resolveProviderInstanceEnabled(row.instance);
          const isDisabling = next.enabled === false && wasEnabled;
          const shouldClearTextGen = isDisabling && textGenInstanceId === row.instanceId;
          updateProviderInstance(
            row,
            next,
            shouldClearTextGen
              ? {
                  textGenerationModelSelection:
                    DEFAULT_UNIFIED_SETTINGS.textGenerationModelSelection,
                }
              : undefined,
          );
        }}
        onDelete={
          mode === "editor" && !row.isDefault
            ? () => deleteProviderInstance(row.instanceId)
            : undefined
        }
        headerAction={
          mode === "editor" && row.isDefault && row.isDirty ? (
            <SettingResetButton
              label={`${resetLabel} provider settings`}
              onClick={() => resetDefaultInstance(row.driver)}
            />
          ) : null
        }
        hiddenModels={modelPreferences.hiddenModels}
        favoriteModels={favoriteModels}
        modelOrder={modelPreferences.modelOrder}
        onHiddenModelsChange={(hiddenModels) =>
          updateProviderModelPreferences(row.instanceId, {
            ...modelPreferences,
            hiddenModels,
          })
        }
        onFavoriteModelsChange={(next) => updateProviderFavoriteModels(row.instanceId, next)}
        onModelOrderChange={(modelOrder) =>
          updateProviderModelPreferences(row.instanceId, {
            ...modelPreferences,
            modelOrder,
          })
        }
        onRunUpdate={
          mode === "editor" && showInlineUpdateButton && updateCandidate
            ? () => {
                if (canRunInlineUpdate) void runProviderUpdate(updateCandidate);
              }
            : undefined
        }
        isUpdating={mode === "editor" && showInlineUpdateButton ? isDriverUpdateRunning : undefined}
      />
    );
  };

  return (
    <>
      <SettingsSection
        {...searchableSetting("providers")}
        headerAction={
          <div className="flex min-w-0 items-center gap-2">
            {readOnly ? (
              <span className="min-w-0 truncate text-xs text-muted-foreground">
                <ProviderLastChecked lastCheckedAt={lastCheckedAt} />
              </span>
            ) : (
              <>
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <Button
                        size="compact"
                        variant="ghost-muted"
                        disabled={isRefreshingProviders}
                        onClick={() => void refreshProviders()}
                      >
                        {isRefreshingProviders ? (
                          <LoaderIcon className="animate-spin" />
                        ) : (
                          <RefreshCwIcon />
                        )}
                        <span className="sr-only">Refresh provider status</span>
                        <span className="hidden min-w-0 truncate sm:inline">
                          <ProviderLastChecked lastCheckedAt={lastCheckedAt} />
                        </span>
                      </Button>
                    }
                  />
                  <TooltipPopup side="top">Refresh provider status</TooltipPopup>
                </Tooltip>
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <Button
                        size="icon-micro"
                        variant="ghost-muted"
                        onClick={() => setIsAddInstanceDialogOpen(true)}
                        aria-label="Add provider"
                      >
                        <PlusIcon className="size-3" />
                      </Button>
                    }
                  />
                  <TooltipPopup side="top">Add provider</TooltipPopup>
                </Tooltip>
              </>
            )}
          </div>
        }
      >
        {deviceTabs}
        {readOnly ? (
          <SettingsRow
            title="Limited permissions"
            description={`This session can view ${environmentLabel}'s providers, but its credential does not allow changing their configuration.`}
          />
        ) : null}
        <div className="space-y-1">
          <div className="mx-3 overflow-hidden rounded-lg border border-border/70 sm:mx-4 lg:grid lg:h-[min(38rem,calc(100dvh-16rem))] lg:min-h-[30rem] lg:grid-cols-[20rem_minmax(0,1fr)]">
            <div className="border-b border-border/70 lg:flex lg:min-h-0 lg:flex-col lg:border-r lg:border-b-0">
              <ScrollArea scrollFade chainVerticalScroll className="lg:min-h-0 lg:flex-1">
                <div className="divide-y divide-border/60">
                  {rows.map((row) => (
                    <div key={row.instanceId} className="p-1">
                      {renderProviderInstance(row, "list")}
                    </div>
                  ))}
                </div>
              </ScrollArea>
            </div>

            <div className="min-w-0 lg:min-h-0">
              {selectedRow ? (
                renderProviderInstance(selectedRow, "editor")
              ) : (
                <div className="p-6 text-sm text-muted-foreground">No providers configured.</div>
              )}
            </div>
          </div>

          <Collapsible open={advancedOpen} onOpenChange={setAdvancedOpen} className="mt-1">
            <CollapsibleTrigger className="flex h-10 w-full items-center gap-2 px-3 text-xs text-muted-foreground hover:text-foreground sm:px-4">
              <ChevronDownIcon
                className={cn("size-3 transition-transform", advancedOpen && "rotate-180")}
              />
              Advanced
            </CollapsibleTrigger>
            <CollapsibleContent>
              {/* Only the write controls go inert; the title and its policy tooltip stay readable. */}
              <SettingsRow
                id={searchableSetting("provider-health-check-interval").id}
                title={
                  <span className="inline-flex items-center gap-1.5">
                    {searchableSetting("provider-health-check-interval").title}
                    <PolicyTooltip>
                      This interval is configured here, then the shared Background activity policy
                      decides whether provider probes may run when the timer fires. Custom intervals
                      appear as Advanced in General settings.
                    </PolicyTooltip>
                  </span>
                }
                description="Refresh availability, versions, auth state, and models in the background. 0 seconds turns background checks off."
                resetAction={
                  providerHealthRefreshIntervalSeconds !==
                  defaultProviderHealthRefreshIntervalSeconds ? (
                    <span inert={readOnly} className={readOnly ? "opacity-50" : undefined}>
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
                    inert={readOnly}
                    aria-disabled={readOnly || undefined}
                    className={cn(
                      "flex shrink-0 items-center gap-2",
                      readOnly && "opacity-50 select-none",
                    )}
                  >
                    <NumberField
                      value={providerHealthRefreshIntervalSeconds}
                      min={0}
                      step={PROVIDER_HEALTH_INTERVAL_STEP_SECONDS}
                      size="sm"
                      className="w-32"
                      onValueChange={(value) =>
                        updateSettings(
                          backgroundActivityOverrideSettings(
                            settings.backgroundActivity,
                            resolvedBackgroundActivity,
                            {
                              providerHealthRefreshInterval: Duration.seconds(
                                normalizeIntervalSeconds(value),
                              ),
                            },
                          ),
                        )
                      }
                    >
                      <NumberFieldGroup>
                        <NumberFieldDecrement aria-label="Decrease provider health check interval" />
                        <NumberFieldInput aria-label="Provider health check interval in seconds" />
                        <NumberFieldIncrement aria-label="Increase provider health check interval" />
                      </NumberFieldGroup>
                    </NumberField>
                    <span className="text-xs text-muted-foreground">seconds</span>
                  </div>
                }
              />
            </CollapsibleContent>
          </Collapsible>
        </div>
      </SettingsSection>

      {isAddInstanceDialogOpen ? (
        <AddProviderInstanceDialog
          open
          environmentId={environmentId}
          environmentLabel={environmentLabel}
          onOpenChange={setIsAddInstanceDialogOpen}
        />
      ) : null}
    </>
  );
}
