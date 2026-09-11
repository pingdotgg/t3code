import { RefreshIcon } from "~/components/ui/refresh-icon";
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
  PROVIDER_DISPLAY_NAMES,
  ProviderDriverKind,
  type ProviderInstanceConfig,
  type ProviderInstanceId,
  resolveEnvironmentMachineKind,
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
import { ArrowLeftIcon, ChevronDownIcon, PlusIcon, SearchIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { isDesktopLocalConnectionTarget } from "../../connection/desktopLocal";
import { isElectron } from "../../env";
import { usePrimarySessionState } from "../../environments/primary";
import {
  useEnvironmentSettings,
  useUpdateClientSettings,
  useUpdateEnvironmentSettings,
} from "../../hooks/useSettings";
import { EnvironmentMachineIcon } from "../EnvironmentMachineIcon";
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
  isProviderSettingsUpdateCandidate,
  isProviderUpdateActive,
  type ProviderSettingsUpdateCandidate,
} from "../ProviderUpdateLaunchNotification.logic";
import { Button } from "../ui/button";
import { InputGroup, InputGroupAddon, InputGroupInput } from "../ui/input-group";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "../ui/empty";
import {
  NumberField,
  NumberFieldDecrement,
  NumberFieldGroup,
  NumberFieldIncrement,
  NumberFieldInput,
} from "../ui/number-field";
import { ScrollArea } from "../ui/scroll-area";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { AddProviderInstanceDialog } from "./AddProviderInstanceDialog";
import { ExpandableText } from "./ExpandableText";
import { ProviderInstanceCard } from "./ProviderInstanceCard";
import { UsageProviderSettings } from "./UsageProviderSettings";
import { ProviderSetupSection, readAntigravityAuthMethod } from "./ProviderSetupSection";
import { DRIVER_OPTIONS, getDriverOption } from "./providerDriverMeta";
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
  getProviderAccountLabel,
  getDuplicateProviderAccountIds,
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

type ProviderSettingsView = "accounts" | "usage" | "health";

interface ProviderSettingsViewControl {
  readonly value: ProviderSettingsView;
  readonly onValueChange: (value: ProviderSettingsView) => void;
}

const PROVIDER_SETTINGS_VIEWS = [
  { value: "accounts", label: "Accounts" },
  { value: "usage", label: "Usage providers" },
  { value: "health", label: "Health checks" },
];

function configuredBinaryPath(config: unknown): string {
  if (config === null || typeof config !== "object" || !("binaryPath" in config)) return "";
  return typeof config.binaryPath === "string" ? config.binaryPath.trim() : "";
}

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

function providerEnvironmentDetail(environment: EnvironmentPresentation): string {
  if (environment.entry.target._tag === "PrimaryConnectionTarget") return "Primary device";
  if (environment.relayManaged) return "T3 Connect";
  if (environment.entry.target._tag === "SshConnectionTarget") return "SSH";
  if (isDesktopLocalConnectionTarget(environment.entry.target)) return "Local device";
  return environment.displayUrl ?? "Remote device";
}

const providerCardClassName = "rounded-xl border border-border/60 bg-card/40 shadow-xs/5";
// Shared by the editor grid and the placeholder states so switching devices
// never changes the card's footprint.
const providerCardHeightClassName = "lg:h-[min(44rem,calc(100dvh-11rem))] lg:min-h-[32rem]";

/**
 * Same chrome as the provider editor (section heading, floating device tabs,
 * tall card) for states that cannot render provider settings yet.
 */
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
    <SettingsSection {...searchableSetting("providers")} hideTitle variant="plain">
      {deviceTabs ? (
        <div className="flex min-h-11 min-w-0 items-center px-3 sm:px-4">{deviceTabs}</div>
      ) : null}
      <div
        className={cn(
          providerCardClassName,
          providerCardHeightClassName,
          "flex overflow-x-hidden overflow-y-auto",
        )}
      >
        <Empty className="min-h-88">
          <EmptyMedia variant="icon">{icon}</EmptyMedia>
          <EmptyHeader>
            <EmptyTitle>{title}</EmptyTitle>
            <EmptyDescription>{description}</EmptyDescription>
          </EmptyHeader>
          {children ? <EmptyContent className="max-w-xl">{children}</EmptyContent> : null}
        </Empty>
      </div>
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
  // Keep the description to a short status; the raw failure can be a
  // multi-paragraph CLI dump, so it goes below, clamped and expandable.
  const description = isLoading
    ? access.reason === "permissions"
      ? "Checking what this session is allowed to change."
      : `Waiting for ${environment.label}'s configuration.`
    : connectionStatusTitle(environment.connection);
  const error = isLoading ? null : environment.connection.error;
  // No spinner: this state can persist indefinitely for a wedged device, and a
  // continuously repainting animation would run the whole time.
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
}

export function ProviderSettingsPanel(target: ProviderSettingsTarget) {
  return (
    <SettingsPageContainer width="expanded" className="@container/providers max-w-none gap-5 pt-3">
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
  const searchTargetView =
    searchTargetId === searchableSetting("usage-providers").id
      ? "usage"
      : searchTargetId === searchableSetting("provider-health-check-interval").id
        ? "health"
        : searchTargetId === searchableSetting("providers").id
          ? "accounts"
          : null;
  const [settingsView, setSettingsView] = useState<ProviderSettingsView>(
    searchTargetView ?? "accounts",
  );
  const [previousSearchTargetId, setPreviousSearchTargetId] = useState(searchTargetId);
  // Reveal search destinations before their refs scroll and focus them. Keep
  // the selected view after the search jump clears its temporary URL hash.
  if (previousSearchTargetId !== searchTargetId) {
    setPreviousSearchTargetId(searchTargetId);
    if (searchTargetView) setSettingsView(searchTargetView);
  }
  const options = useMemo(
    () => buildProviderEnvironmentOptions(environments, primaryEnvironmentId),
    [environments, primaryEnvironmentId],
  );
  // Raw user intent; the effective selection is re-derived every render so a
  // device that drops out of the catalog falls back without erasing the pick —
  // if it reappears (e.g. after a reconnect) the selection is restored.
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
  useEffect(() => {
    if (
      !target.scoped &&
      (searchTargetId === searchableSetting("provider-health-check-interval").id ||
        searchTargetId === searchableSetting("usage-providers").id) &&
      !selectedEnvironmentCanRenderSettings &&
      searchableEnvironmentId !== undefined
    ) {
      setSelectedEnvironmentId(searchableEnvironmentId);
    }
  }, [
    searchTargetId,
    searchableEnvironmentId,
    selectedEnvironmentCanRenderSettings,
    target.scoped,
  ]);
  const onlyPrimaryDevice =
    options.length === 1 && options[0]?.entry.target._tag === "PrimaryConnectionTarget";
  const deviceTabs =
    !target.scoped && !onlyPrimaryDevice && options.length > 0 ? (
      <ScrollArea hideScrollbars scrollFade className="h-11 min-w-0 flex-1 rounded-none">
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
                    <Toggle value={environment.environmentId} className="gap-2 text-left">
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
        <SelectedEnvironmentProviderSettings
          key={selectedEnvironment.environmentId}
          environment={selectedEnvironment}
          view={{ value: settingsView, onValueChange: setSettingsView }}
          deviceTabs={deviceTabs}
          targetInstanceId={
            target.environmentId === undefined ||
            selectedEnvironment.environmentId === target.environmentId
              ? target.instanceId
              : undefined
          }
        />
      ) : null}
    </>
  );
}

function SelectedEnvironmentProviderSettings({
  environment,
  deviceTabs,
  view,
  targetInstanceId,
}: {
  readonly environment: EnvironmentPresentation;
  readonly deviceTabs?: ReactNode;
  readonly view: ProviderSettingsViewControl;
  readonly targetInstanceId?: ProviderInstanceId | undefined;
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
          view={view}
          targetInstanceId={targetInstanceId}
        />
      );
    }
    return (
      <PrimarySessionGatedProviderSettings
        environment={environment}
        deviceTabs={deviceTabs}
        view={view}
        targetInstanceId={targetInstanceId}
      />
    );
  }
  return (
    <RemoteSessionGatedProviderSettings
      environment={environment}
      deviceTabs={deviceTabs}
      view={view}
      targetInstanceId={targetInstanceId}
    />
  );
}

function PrimarySessionGatedProviderSettings({
  environment,
  deviceTabs,
  view,
  targetInstanceId,
}: {
  readonly environment: EnvironmentPresentation;
  readonly deviceTabs?: ReactNode;
  readonly view: ProviderSettingsViewControl;
  readonly targetInstanceId?: ProviderInstanceId | undefined;
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
      view={view}
      targetInstanceId={targetInstanceId}
    />
  );
}

function RemoteSessionGatedProviderSettings({
  environment,
  deviceTabs,
  view,
  targetInstanceId,
}: {
  readonly environment: EnvironmentPresentation;
  readonly deviceTabs?: ReactNode;
  readonly view: ProviderSettingsViewControl;
  readonly targetInstanceId?: ProviderInstanceId | undefined;
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
      view={view}
      targetInstanceId={targetInstanceId}
    />
  );
}

function AccessGatedProviderSettings({
  environment,
  operateAccess,
  deviceTabs,
  view,
  targetInstanceId,
}: {
  readonly environment: EnvironmentPresentation;
  readonly operateAccess: ProviderOperateAccess;
  readonly deviceTabs?: ReactNode;
  readonly view: ProviderSettingsViewControl;
  readonly targetInstanceId?: ProviderInstanceId | undefined;
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
      view={view}
      targetInstanceId={targetInstanceId}
    />
  );
}

export function EnvironmentProviderSettings({
  environmentId,
  environmentLabel,
  readOnly = false,
  deviceTabs,
  view,
  targetInstanceId,
}: {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly deviceTabs?: ReactNode;
  readonly view: ProviderSettingsViewControl;
  readonly targetInstanceId?: ProviderInstanceId | undefined;
  /**
   * Grey out and freeze every write control when this session's credential
   * lacks `orchestration:operate` on the environment. Selecting providers
   * still works so the real configuration stays readable; switches, forms,
   * and the health interval are inert so no write is offered and then rejected.
   */
  readonly readOnly?: boolean;
}) {
  const settings = useEnvironmentSettings(environmentId);
  // Provider instances hold per-machine credentials and binaries, so this
  // page always edits exactly the environment it displays.
  const updateSettings = useUpdateEnvironmentSettings(environmentId);
  const updateClientSettings = useUpdateClientSettings();
  const serverProviders =
    useAtomValue(serverEnvironment.providersValueAtom(environmentId)) ?? EMPTY_SERVER_PROVIDERS;
  const refreshServerProviders = useAtomCommand(serverEnvironment.refreshProviders, {
    reportFailure: false,
  });
  const updateProvider = useAtomCommand(serverEnvironment.updateProvider, {
    reportFailure: false,
  });
  const deleteProviderSettings = useAtomCommand(serverEnvironment.updateSettings, {
    reportFailure: false,
  });
  const [isRefreshingProviders, setIsRefreshingProviders] = useState(false);
  const [isAddInstanceDialogOpen, setIsAddInstanceDialogOpen] = useState(false);
  const [addAccountDriver, setAddAccountDriver] = useState<ProviderDriverKind | undefined>();
  const [accountQuery, setAccountQuery] = useState("");
  const [accountSelection, setAccountSelection] = useState({
    instanceId: targetInstanceId ?? null,
    isOpen: targetInstanceId !== undefined,
  });
  const { instanceId: selectedInstanceId, isOpen: isCompactAccountOpen } = accountSelection;
  const accountListRef = useRef<HTMLElement>(null);
  const allAccountsButtonRef = useRef<HTMLButtonElement>(null);
  const accountNavigationPendingRef = useRef(false);
  const [updatingProviderInstanceIds, setUpdatingProviderInstanceIds] = useState<
    ReadonlySet<ProviderInstanceId>
  >(() => new Set());
  const refreshingRef = useRef(false);
  const updatingInstanceIdsRef = useRef<Set<ProviderInstanceId>>(new Set());

  useEffect(() => {
    if (!accountNavigationPendingRef.current) return;
    accountNavigationPendingRef.current = false;
    // A rename saved on blur can remove a filtered row after we return.
    // Keep focus on the filter while searching, otherwise restore the row.
    const accountButton = accountQuery.trim()
      ? null
      : accountListRef.current?.querySelector<HTMLButtonElement>('button[aria-pressed="true"]');
    const target = accountSelection.isOpen
      ? allAccountsButtonRef.current
      : accountButton?.checkVisibility()
        ? accountButton
        : accountListRef.current?.querySelector<HTMLInputElement>('input[type="search"]');
    // Move focus after the pane changes. Wide windows keep both panes visible.
    if (!target?.checkVisibility()) return;
    target.focus({ preventScroll: true });
    target.scrollIntoView({ block: "nearest" });
  }, [accountQuery, accountSelection]);

  const providerUpdateCandidateByInstanceId = useMemo(
    () =>
      new Map(
        serverProviders
          .filter(isProviderSettingsUpdateCandidate)
          .map((candidate) => [candidate.instanceId, candidate]),
      ),
    [serverProviders],
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
        input: { refreshModels: true },
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
    async (candidate: ProviderSettingsUpdateCandidate) => {
      // Ref-based re-entry guard, mirroring refreshProviders: a state updater
      // may run after this function returns, so it cannot gate the dispatch.
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
    // A named instance can occupy another driver's default ID. It belongs
    // only to its actual driver, not to both that driver and the legacy slot.
    const effectiveInstance = explicitInstance
      ? explicitInstance.driver === driver
        ? explicitInstance
        : undefined
      : synthesizedInstance();
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
        isDefault: false,
      });
    }
  }

  const selectedRow =
    selectedInstanceId === null
      ? (rows.find((row) => resolveProviderInstanceEnabled(row.instance)) ?? rows[0] ?? null)
      : (rows.find((row) => row.instanceId === selectedInstanceId) ?? null);
  const duplicateAccountIds = getDuplicateProviderAccountIds(rows);

  const rowsByDriver = new Map<ProviderDriverKind, InstanceRow[]>();
  for (const row of rows) {
    const group = rowsByDriver.get(row.driver);
    if (group) group.push(row);
    else rowsByDriver.set(row.driver, [row]);
  }
  const accountGroups = Array.from(rowsByDriver, ([driver, accounts]) => ({
    driver,
    label: getDriverOption(driver)?.label ?? String(driver),
    icon: getDriverOption(driver)?.icon,
    accounts,
    enabled: accounts.some((row) => resolveProviderInstanceEnabled(row.instance)),
  }));
  const normalizedQuery = accountQuery.trim().toLocaleLowerCase();
  const matchingGroups = accountGroups.flatMap((group) => {
    const accounts = group.accounts.filter((row) =>
      `${group.label} ${getProviderAccountLabel(row.instanceId, row.instance)} ${row.instanceId}`
        .toLocaleLowerCase()
        .includes(normalizedQuery),
    );
    return accounts.length > 0 ? [{ ...group, accounts }] : [];
  });

  const enabledGroups = matchingGroups.filter((group) => group.enabled);
  const disabledGroups = matchingGroups.filter((group) => !group.enabled);

  const selectProviderAccount = (instanceId: ProviderInstanceId) => {
    view.onValueChange("accounts");
    accountNavigationPendingRef.current = true;
    setAccountSelection({ instanceId, isOpen: true });
  };

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

  const deleteProviderInstance = async (id: ProviderInstanceId) => {
    const result = await deleteProviderSettings({
      environmentId,
      input: {
        patch: { providerInstances: withoutProviderInstanceKey(settings.providerInstances, id) },
      },
    });
    if (result._tag === "Failure") {
      if (isAtomCommandInterrupted(result)) return;
      const error = squashAtomCommandFailure(result);
      toastManager.add({
        type: "error",
        title: "Could not remove provider account",
        description: error instanceof Error ? error.message : "Update failed.",
      });
      return;
    }
    // The settings stream may still contain the deleted row after the save.
    // Pick another account now, without overriding navigation during the request.
    const remainingRows = rows.filter((row) => row.instanceId !== id);
    const nextRow =
      remainingRows.find((row) => resolveProviderInstanceEnabled(row.instance)) ?? remainingRows[0];
    accountNavigationPendingRef.current = true;
    setAccountSelection((current) =>
      current.instanceId === id || (current.instanceId === null && selectedRow?.instanceId === id)
        ? { instanceId: nextRow?.instanceId ?? null, isOpen: false }
        : current,
    );
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
    updateClientSettings({
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
    updateClientSettings({
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
    const updateCandidate = providerUpdateCandidateByInstanceId.get(row.instanceId);
    const isInstanceUpdateRunning =
      updateCandidate !== undefined &&
      (updatingProviderInstanceIds.has(updateCandidate.instanceId) ||
        isProviderUpdateActive(updateCandidate));
    const showInlineUpdateButton = updateCandidate !== undefined;
    const canRunInlineUpdate = updateCandidate !== undefined && !isInstanceUpdateRunning;
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
        showInstanceId={duplicateAccountIds.has(row.instanceId)}
        driverOption={driverOption}
        liveProvider={liveProvider}
        mode={mode}
        selected={mode === "list" && selectedRow?.instanceId === row.instanceId}
        onSelect={mode === "list" ? () => selectProviderAccount(row.instanceId) : undefined}
        readOnly={readOnly}
        setup={
          mode === "editor" && row.driver === "antigravity" ? (
            <ProviderSetupSection
              environmentId={environmentId}
              environmentLabel={environmentLabel}
              instanceId={row.instanceId}
              provider={liveProvider}
              binaryPath={configuredBinaryPath(row.instance.config)}
              authMethod={readAntigravityAuthMethod(row.instance.config)}
              enabled={resolveProviderInstanceEnabled(row.instance)}
              readOnly={readOnly}
              onEnable={() => updateProviderInstance(row, { ...row.instance, enabled: true })}
            />
          ) : null
        }
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
        isUpdating={
          mode === "editor" && showInlineUpdateButton ? isInstanceUpdateRunning : undefined
        }
      />
    );
  };

  const renderAccountGroup = (group: (typeof accountGroups)[number]) => {
    const Icon = group.icon;
    const canAddAccount = !readOnly && getDriverOption(group.driver) !== undefined;
    return (
      <section key={group.driver} aria-label={`${group.label} accounts`} className="space-y-1">
        <div className="flex items-center gap-2 px-3 py-1 text-xs font-medium text-muted-foreground">
          {Icon ? <Icon className="size-3.5 shrink-0" aria-hidden /> : null}
          <h3>{group.label}</h3>
          <span className="ml-auto text-[11px] tabular-nums text-muted-foreground/60">
            {group.accounts.length}
          </span>
          {canAddAccount ? (
            <Button
              size="icon-micro"
              variant="ghost-muted"
              className="@max-[48rem]/providers:h-7 @max-[48rem]/providers:w-auto @max-[48rem]/providers:px-2"
              aria-label={`Add ${group.label} account`}
              onClick={() => {
                setAddAccountDriver(group.driver);
                setIsAddInstanceDialogOpen(true);
              }}
            >
              <PlusIcon className="size-3" />
              <span className="hidden @max-[48rem]/providers:inline">Add account</span>
            </Button>
          ) : null}
        </div>
        {group.accounts.map((row) => renderProviderInstance(row, "list"))}
      </section>
    );
  };

  return (
    <>
      <SettingsSection {...searchableSetting("providers")} hideTitle variant="plain">
        <div className="flex min-h-11 min-w-0 flex-wrap items-center gap-2 pb-2">
          <h1 className="shrink-0 text-lg font-semibold tracking-tight @min-[48rem]/providers:mr-2">
            Providers
          </h1>
          <Select
            items={PROVIDER_SETTINGS_VIEWS}
            value={view.value}
            onValueChange={(value) => {
              if (value === "accounts" || value === "usage" || value === "health") {
                view.onValueChange(value);
              }
            }}
          >
            <SelectTrigger
              size="compact"
              variant="ghost"
              className="min-w-0 gap-2 bg-muted/40 text-foreground"
              aria-label="Provider settings view"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectPopup alignItemWithTrigger={false} className="min-w-44">
              {PROVIDER_SETTINGS_VIEWS.map((view) => (
                <SelectItem key={view.value} value={view.value}>
                  {view.label}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
          {deviceTabs ? (
            <div className="order-last min-w-0 basis-full @min-[48rem]/providers:order-none @min-[48rem]/providers:flex-1 @min-[48rem]/providers:basis-auto">
              {deviceTabs}
            </div>
          ) : null}
          {!deviceTabs ? (
            <span className="sr-only min-w-0 truncate text-xs text-muted-foreground @min-[48rem]/providers:not-sr-only">
              {environmentLabel}
            </span>
          ) : null}
          {view.value === "accounts" ? (
            <div className="ml-auto flex min-w-0 shrink-0 items-center gap-1 @min-[48rem]/providers:gap-2">
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
                          size="xs"
                          variant="ghost-muted"
                          className="@max-[48rem]/providers:size-8 @max-[48rem]/providers:p-0"
                          disabled={isRefreshingProviders}
                          aria-busy={isRefreshingProviders}
                          onClick={() => void refreshProviders()}
                        >
                          <RefreshIcon refreshing={isRefreshingProviders} />
                          <span className="sr-only">Refresh provider status</span>
                          <span className="hidden min-w-0 truncate @min-[48rem]/providers:inline">
                            {isRefreshingProviders ? (
                              "Refreshing providers"
                            ) : (
                              <ProviderLastChecked lastCheckedAt={lastCheckedAt} />
                            )}
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
                          size="xs"
                          variant="outline"
                          className="@max-[48rem]/providers:size-8 @max-[48rem]/providers:p-0"
                          onClick={() => {
                            setAddAccountDriver(undefined);
                            setIsAddInstanceDialogOpen(true);
                          }}
                          aria-label="Add provider"
                        >
                          <PlusIcon />
                          <span className="hidden @min-[48rem]/providers:inline">Add provider</span>
                        </Button>
                      }
                    />
                    <TooltipPopup side="top">Add provider</TooltipPopup>
                  </Tooltip>
                </>
              )}
            </div>
          ) : null}
        </div>
        {readOnly ? (
          <div className={cn(providerCardClassName, "overflow-hidden")}>
            <SettingsRow
              title="Limited permissions"
              description={`This session can view ${environmentLabel}'s providers but can't change their settings.`}
            />
          </div>
        ) : null}
        <div className="border-t border-border/60">
          <div hidden={view.value !== "accounts"}>
            <div className="min-w-0 border-b border-border/60 @min-[48rem]/providers:grid @min-[48rem]/providers:h-[clamp(28rem,calc(100dvh-11rem),52rem)] @min-[48rem]/providers:grid-cols-[14rem_minmax(0,1fr)]">
              <nav
                ref={accountListRef}
                aria-label="Provider accounts"
                className={cn(
                  "min-h-0 flex-col py-3 @min-[48rem]/providers:flex @min-[48rem]/providers:border-r @min-[48rem]/providers:border-border/60 @min-[48rem]/providers:pr-3",
                  isCompactAccountOpen ? "hidden" : "flex",
                )}
              >
                <InputGroup
                  variant="ghost"
                  className="mb-3 rounded-md bg-muted/20 [--control-radius:var(--radius-md)]"
                >
                  <InputGroupAddon className="text-muted-foreground [&_svg]:mx-0">
                    <SearchIcon aria-hidden className="size-3.5 shrink-0" />
                  </InputGroupAddon>
                  <InputGroupInput
                    size="compact"
                    type="search"
                    aria-label="Find provider account"
                    placeholder="Filter accounts"
                    value={accountQuery}
                    onChange={(event) => setAccountQuery(event.target.value)}
                  />
                </InputGroup>
                <ScrollArea scrollFade chainVerticalScroll className="min-h-0 flex-1">
                  <div className="space-y-3">
                    {enabledGroups.map(renderAccountGroup)}
                    {disabledGroups.length > 0 ? (
                      <details
                        className="group/disabled border-t border-border/50 pt-2"
                        open={
                          normalizedQuery.length > 0 ||
                          disabledGroups.some((group) =>
                            group.accounts.some(
                              (row) => row.instanceId === selectedRow?.instanceId,
                            ),
                          )
                        }
                      >
                        <summary className="flex cursor-pointer list-none items-center justify-between rounded-md px-3 py-2 text-xs text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
                          Disabled providers
                          <ChevronDownIcon className="size-3.5 -rotate-90 group-open/disabled:rotate-0" />
                        </summary>
                        <div className="space-y-3 pt-2">
                          {disabledGroups.map(renderAccountGroup)}
                        </div>
                      </details>
                    ) : null}
                    {matchingGroups.length === 0 ? (
                      <p className="px-3 py-4 text-xs text-muted-foreground">
                        No matching accounts.
                      </p>
                    ) : null}
                  </div>
                </ScrollArea>
              </nav>
              <div
                className={cn(
                  "min-w-0 @min-[48rem]/providers:block @min-[48rem]/providers:min-h-0",
                  !isCompactAccountOpen && "hidden",
                )}
              >
                <div className="border-b border-border/60 py-3 @min-[48rem]/providers:hidden">
                  <Button
                    ref={allAccountsButtonRef}
                    size="sm"
                    variant="ghost-muted"
                    onClick={() => {
                      accountNavigationPendingRef.current = true;
                      setAccountSelection((current) => ({ ...current, isOpen: false }));
                    }}
                  >
                    <ArrowLeftIcon />
                    All accounts
                  </Button>
                </div>
                {selectedRow ? (
                  <ScrollArea
                    scrollFade
                    chainVerticalScroll
                    className="@min-[48rem]/providers:h-full"
                  >
                    <div className="space-y-4 py-5 @min-[48rem]/providers:px-6">
                      {renderProviderInstance(selectedRow, "editor")}
                    </div>
                  </ScrollArea>
                ) : (
                  <div className="p-6 text-sm text-muted-foreground">
                    {selectedInstanceId !== null
                      ? "This provider instance is no longer available on this device."
                      : "No providers configured."}
                  </div>
                )}
              </div>
            </div>
          </div>
          {view.value === "usage" ? (
            <div className="max-w-3xl py-6">
              <UsageProviderSettings
                key={environmentId}
                environmentId={environmentId}
                environmentLabel={environmentLabel}
                sources={settings.usageLimitSources}
                readOnly={readOnly}
              />
            </div>
          ) : null}
          {view.value === "health" ? (
            <div className="max-w-3xl space-y-6 py-6">
              <div className="space-y-2">
                <h2 className="text-base font-semibold">Health checks</h2>
                <p className="text-sm text-muted-foreground">
                  Keep provider status, versions, and available models up to date on{" "}
                  {environmentLabel}.
                </p>
              </div>
              <SettingsSection title="Automatic checks" hideTitle variant="plain">
                <SettingsRow
                  id={searchableSetting("provider-health-check-interval").id}
                  className="rounded-none border-y border-border/60 px-0 sm:px-0"
                  title={
                    <span className="inline-flex items-center gap-1.5">
                      Check interval
                      <PolicyTooltip>
                        This interval is configured here, then the shared Background activity policy
                        decides whether provider probes may run when the timer fires. Custom
                        intervals appear as Advanced in General settings.
                      </PolicyTooltip>
                    </span>
                  }
                  description="Time between background checks. Set to 0 to turn off automatic checks."
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
              </SettingsSection>
            </div>
          ) : null}
        </div>
      </SettingsSection>

      {isAddInstanceDialogOpen ? (
        <AddProviderInstanceDialog
          open
          environmentId={environmentId}
          environmentLabel={environmentLabel}
          initialDriver={addAccountDriver}
          onAdded={(instanceId) => {
            setAccountQuery("");
            selectProviderAccount(instanceId);
          }}
          onOpenChange={setIsAddInstanceDialogOpen}
        />
      ) : null}
    </>
  );
}
