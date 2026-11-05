import { ChatGptUsageButton } from "../settings/ChatGptUsageButton";
import { usesChatGptSharing } from "@t3tools/shared/usageLimits";
import { RefreshIcon } from "~/components/ui/refresh-icon";
import { useAtomValue } from "@effect/atom-react";
import { Atom } from "effect/reactivity";
import {
  ProviderDriverKind,
  USAGE_CONTRACT_VERSION,
  type EnvironmentId,
  type UsageProviderKind,
  type UsageSummaryInput,
} from "@t3tools/contracts";
import {
  CalendarDaysIcon,
  CircleAlertIcon,
  ChevronDownIcon,
  SlidersHorizontalIcon,
} from "lucide-react";
import { useEffect, useEffectEvent, useRef, useState } from "react";
import { settlePromise } from "@t3tools/client-runtime/state/runtime";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import * as Cause from "effect/Cause";
import {
  cursorKeychainAccessEnvironments,
  refreshUsageLimits,
} from "@t3tools/client-runtime/state/usage";
import {
  updatingProvidersLabel,
  usageEnvironmentProgress,
  usageLoadingState,
} from "@t3tools/client-runtime/state/usage-progress";

import { isCompatibleUsageContractVersion, type MergedUsage } from "@t3tools/shared/usageMerge";

import { cn } from "../../lib/utils";
import { usePrimarySettings } from "../../hooks/useSettings";
import { resolveHour12 } from "../../timestampFormat";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { environmentPresentations } from "../../state/presentation";
import { primaryServerKeybindingsAtom, serverEnvironment } from "../../state/server";
import { isCommandPaletteOpen } from "../../commandPaletteBus";
import { isModelPickerOpen } from "../../modelPickerVisibility";
import { shortcutLabelForCommand } from "../../keybindings";
import {
  dailyFallback,
  baselineCoversCurrent,
  useUsage,
  type EnvironmentUsageStatus,
} from "../../state/usage";
import { useAtomCommand } from "../../state/use-atom-command";
import { formatUsageContractMismatch } from "@t3tools/shared/usageFormat";
import { Button, InlineButton } from "../ui/button";
import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";
import { Input } from "../ui/input";
import {
  Menu,
  MenuCheckboxItem,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuTrigger,
} from "../ui/menu";
import { ScrollArea } from "../ui/scroll-area";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { AppRouteModal, AppRouteModalClose } from "../AppRouteModal";
import { Skeleton } from "../ui/skeleton";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import {
  WorkspaceBreadcrumb,
  WorkspaceBreadcrumbItem,
  WorkspaceBreadcrumbSeparator,
  WorkspaceBreadcrumbText,
} from "../WorkspaceBreadcrumb";
import { WorkspacePageContainer } from "../WorkspacePageContainer";
import { UsageExplorer } from "./UsageExplorer";
import { UsageLimitsSection } from "./UsageLimits";
import { UsagePriceOverrides } from "./UsagePriceOverrides";
import { UsageModelDialog } from "./UsageModelDialog";
import {
  METRIC_OPTIONS,
  WINDOW_OPTIONS,
  resolveUsageShortcut,
  type UsageMetric,
} from "./usageShortcuts";
import { PROVIDER_ORDER, PROVIDER_PRESENTATION } from "./usageProviders";
import {
  readUsageExplorerPreferences,
  readUsagePagePreferences,
  saveUsageExplorerPreferences,
  saveUsagePagePreferences,
  type UsageExplorerPreferences,
  type UsagePagePreferences,
} from "./usagePagePreferences";
import { splitAccountKey } from "./usageExplorerModel";
import {
  formatWindow,
  previousWindow,
  timelineFor,
  type UsageRange,
  windowFor,
} from "./usageWindow";

function isUsageMetric(value: string | null | undefined): value is UsageMetric {
  return METRIC_OPTIONS.some((option) => option.value === value);
}

function isUsageWindowDays(value: number): value is UsagePagePreferences["windowDays"] {
  return WINDOW_OPTIONS.some((option) => option.days === value);
}

const providerLabel = (provider: UsageProviderKind) => PROVIDER_PRESENTATION[provider].label;

const selectedUsageModelKeyAtom = Atom.make<string | null>(null).pipe(
  Atom.keepAlive,
  Atom.withLabel("usage:selected-model-key"),
);

function selectUsageModel(key: string | null): void {
  appAtomRegistry.set(selectedUsageModelKeyAtom, key);
}

function UsageModelDialogHost({
  models,
  onSetPrice,
  ...dialogProps
}: Omit<Parameters<typeof UsageModelDialog>[0], "model" | "onSetPrice" | "onClose"> & {
  readonly models: MergedUsage["models"];
  readonly onSetPrice: (model: string) => void;
}) {
  const selectedKey = useAtomValue(selectedUsageModelKeyAtom);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- clears the shared selected-model atom on unmount
  useEffect(() => () => selectUsageModel(null), []);
  const model =
    selectedKey === null
      ? undefined
      : models.find((candidate) => `${candidate.provider}:${candidate.model}` === selectedKey);
  if (model === undefined) return null;
  return (
    <UsageModelDialog
      {...dialogProps}
      model={model}
      onSetPrice={() => {
        selectUsageModel(null);
        onSetPrice(model.model);
      }}
      onClose={() => selectUsageModel(null)}
    />
  );
}

export function UsagePage() {
  const [preferences, setPreferences] = useState(readUsagePagePreferences);
  const [explorerPreferences, setExplorerPreferences] = useState(readUsageExplorerPreferences);
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const hour12 = usePrimarySettings((settings) => resolveHour12(settings.timestampFormat));
  const shortcutTitle = (
    option: (typeof METRIC_OPTIONS)[number] | (typeof WINDOW_OPTIONS)[number],
  ) => {
    const shortcut = shortcutLabelForCommand(keybindings, option.command, {
      context: { usagePageOpen: true },
    });
    return shortcut ? `${option.label} (${shortcut})` : option.label;
  };
  const [windowSelection, setWindowSelection] = useState<{
    readonly range: UsageRange;
    readonly window: UsageSummaryInput;
  }>(() => {
    const range: UsageRange = { kind: "period", days: preferences.windowDays };
    return { range, window: windowFor(range) };
  });
  const metric = preferences.metric;
  const showingLimits = metric === "limits";
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [limitsNow, setLimitsNow] = useState(() => Date.now());
  const refreshingRef = useRef(false);
  const [priceDialog, setPriceDialog] = useState<{ readonly model?: string } | null>(null);
  const [selectedEnvironmentIds, setSelectedEnvironmentIds] =
    useState<ReadonlySet<EnvironmentId> | null>(null);
  const { range, window: requested } = windowSelection;
  const periodDays = range.kind === "period" ? range.days : null;
  // Older servers require day buckets for long ranges; all selected environments
  // must use the same granularity, returning to hours when those servers leave.
  const [daysNeeded, setDaysNeeded] = useState<{
    readonly for: UsageSummaryInput;
    readonly ids: ReadonlySet<EnvironmentId>;
  } | null>(null);
  const byDay = dailyFallback(requested);
  const neededNow = daysNeeded?.for === requested ? daysNeeded.ids : null;
  const window =
    byDay !== null &&
    neededNow !== null &&
    [...neededNow].some((id) => selectedEnvironmentIds === null || selectedEnvironmentIds.has(id))
      ? byDay
      : requested;
  const hiddenProviders = new Set(preferences.hiddenProviders);
  const {
    merged: answeredUsage,
    environments,
    selectedEnvironments,
    shown,
    isPending,
    isPartial,
    refresh,
  } = useUsage(window, selectedEnvironmentIds, hiddenProviders);
  const merged = shown?.merged ?? answeredUsage;
  const shownWindow = shown?.window ?? window;
  const refreshingUsage = isRefreshing && !showingLimits;
  const showingKept = shown !== null && shown.window !== window;
  const loading = (() => {
    if (showingKept) {
      return { partial: true, everyProvider: true, providers: new Set<UsageProviderKind>() };
    }
    const state = usageLoadingState(selectedEnvironments, refreshingUsage);
    // A hidden provider still refreshing must not add its row or mute the totals.
    const providers = new Set([...state.providers].filter((p) => !hiddenProviders.has(p)));
    return {
      partial: state.everyProvider || providers.size > 0,
      everyProvider: state.everyProvider,
      providers,
    };
  })();
  const fellBack =
    byDay !== null && window === requested
      ? selectedEnvironments
          .filter(
            (environment) => environment.readByDay && !neededNow?.has(environment.environmentId),
          )
          .map((environment) => environment.environmentId)
      : [];
  if (fellBack.length > 0) {
    // Adjusting state while rendering: React re-renders before painting.
    setDaysNeeded({ for: requested, ids: new Set([...(neededNow ?? []), ...fellBack]) });
  }
  // The Change column compares with the same span just before; read it only then.
  const wantsPrevious = !showingLimits && explorerPreferences.columns.includes("change");
  const previous = useUsage(
    wantsPrevious ? previousWindow(window) : null,
    selectedEnvironmentIds,
    hiddenProviders,
  );
  // Change compares like for like only when every environment that counts now,
  // even with no usage, also answered for the span before.
  const previousCoversCurrent = baselineCoversCurrent(
    selectedEnvironments,
    previous.selectedEnvironments,
  );
  const presentations = useAtomValue(environmentPresentations.presentationsAtom);
  const presentationsWithProviders = useAtomValue(
    environmentPresentations.presentationsWithProvidersAtom,
  );
  const selectedEnvironmentIdList = selectedEnvironments.map(
    (environment) => environment.environmentId,
  );
  const cursorAccessEnvironments = hiddenProviders.has("cursor")
    ? []
    : cursorKeychainAccessEnvironments(selectedEnvironments);
  const environmentNote = (environmentId: string) => {
    const environment = selectedEnvironments.find((entry) => entry.environmentId === environmentId);
    return environment?.savedAt ? `Offline · as of ${formatSavedAt(environment.savedAt)}` : null;
  };
  const sourceMessages = [
    ...new Set(
      selectedEnvironments.flatMap(
        (environment) =>
          environment.summary?.sources.flatMap((source) =>
            source.message &&
            !source.action &&
            !hiddenProviders.has(source.fingerprint.provider) &&
            (source.status === "partial" ||
              source.status === "failed" ||
              source.fingerprint.provider === "cursor")
              ? [source.message]
              : [],
          ) ?? [],
      ),
    ),
  ];
  const providersByEnvironment = useAtomValue(environmentPresentations.providersByEnvironmentAtom);
  const refreshProviders = useAtomCommand(serverEnvironment.refreshProviders, {
    reportFailure: false,
  });

  const timeline = timelineFor(shownWindow);
  const canReadDiagnostics = selectedEnvironments.some(
    (environment) => environment.canReadDiagnostics,
  );
  const environmentLabel = (environmentId: string) =>
    environments.find((environment) => environment.environmentId === environmentId)?.label ??
    environmentId;
  // Accounts are provider instances, named in their own environment's settings.
  const showEnvironments = selectedEnvironments.length > 1;
  const accountLabel = (account: string, provider: UsageProviderKind) => {
    const { environmentId, instance } = splitAccountKey(account);
    const configured = providersByEnvironment
      .get(environmentId as EnvironmentId)
      ?.find((entry) => entry.instanceId === instance)?.displayName;
    const label = PROVIDER_PRESENTATION[provider]?.label ?? provider;
    const name =
      configured ??
      (instance === provider || instance === PROVIDER_PRESENTATION[provider]?.driverKind
        ? label
        : `${label} · ${instance}`);
    return showEnvironments ? `${name} · ${environmentLabel(environmentId)}` : name;
  };

  const setRange = (next: UsageRange) =>
    setWindowSelection({ range: next, window: windowFor(next) });
  const updatePreferences = (patch: Partial<UsagePagePreferences>) => {
    const nextPreferences = { ...preferences, ...patch };
    setPreferences(nextPreferences);
    saveUsagePagePreferences(nextPreferences);
  };
  const selectWindow = (days: number) => {
    if (!isUsageWindowDays(days)) return;
    updatePreferences({ windowDays: days });
    setRange({ kind: "period", days });
  };
  const selectMetric = (nextMetric: UsageMetric) => {
    if (nextMetric === "limits") setLimitsNow(Date.now());
    updatePreferences({ metric: nextMetric });
  };
  const changeExplorerPreferences = (next: UsageExplorerPreferences) => {
    setExplorerPreferences(next);
    saveUsageExplorerPreferences(next);
  };
  const refreshLimits = (automatic = false, afterPending = false) =>
    // Settled so the timestamp still advances when a refresh throws.
    settlePromise(() =>
      Promise.all(
        Array.from(presentations, ([environmentId, presentation]) => {
          if (selectedEnvironmentIds !== null && !selectedEnvironmentIds.has(environmentId)) return;
          if (presentation.connection.phase === "connected" && presentation.serverConfig !== null) {
            return refreshUsageLimits(
              environmentId,
              () => refreshProviders({ environmentId, input: {} }),
              automatic,
              afterPending,
            );
          }
        }),
      ),
    ).then((result) => {
      setLimitsNow(Date.now());
      if (!AsyncResult.isSuccess(result)) throw Cause.squash(result.cause);
    });
  const onUsageKeyDown = useEffectEvent((event: KeyboardEvent) => {
    if (
      event.defaultPrevented ||
      event.repeat ||
      event.isComposing ||
      isCommandPaletteOpen() ||
      isModelPickerOpen()
    )
      return;
    const command = resolveUsageShortcut(event, keybindings);
    const metricOption = METRIC_OPTIONS.find((option) => option.command === command);
    const periodOption = WINDOW_OPTIONS.find((option) => option.command === command);
    if (!metricOption && !periodOption) return;

    event.preventDefault();
    event.stopPropagation();
    if (metricOption) selectMetric(metricOption.value);
    if (periodOption && !showingLimits) selectWindow(periodOption.days);
  });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- window capture keydown listener for usage metric and period shortcuts
  useEffect(() => {
    globalThis.window.addEventListener("keydown", onUsageKeyDown, true);
    return () => globalThis.window.removeEventListener("keydown", onUsageKeyDown, true);
  }, []);

  const refreshWindow = () => {
    if (refreshingRef.current) return;

    if (showingLimits) {
      refreshingRef.current = true;
      setIsRefreshing(true);
      void refreshLimits().finally(() => {
        refreshingRef.current = false;
        setIsRefreshing(false);
      });
      return;
    }
    // A span that fell back to days stays on days, and Refresh rereads by day:
    // rereading by hour would fail again and reuse the cached daily read.
    const readingByDay = window !== requested;
    const nextWindow = windowFor(range);
    if (
      nextWindow.sinceDay !== requested.sinceDay ||
      nextWindow.untilDay !== requested.untilDay ||
      nextWindow.sinceTime !== requested.sinceTime ||
      nextWindow.untilTime !== requested.untilTime
    ) {
      setWindowSelection({ range, window: nextWindow });
      if (readingByDay && neededNow !== null) setDaysNeeded({ for: nextWindow, ids: neededNow });
    }
    const target = readingByDay ? (dailyFallback(nextWindow) ?? nextWindow) : nextWindow;
    refreshingRef.current = true;
    setIsRefreshing(true);
    void refresh(target).finally(() => {
      refreshingRef.current = false;
      setIsRefreshing(false);
    });
  };
  const connectedLimitsEnvironments = [...presentations]
    .filter(
      ([environmentId, presentation]) =>
        presentation.connection.phase === "connected" &&
        presentation.serverConfig !== null &&
        (selectedEnvironmentIds === null || selectedEnvironmentIds.has(environmentId)),
    )
    .map(([environmentId]) => environmentId)
    .sort()
    .join(",");
  const autoRefreshLimits = useEffectEvent(() => {
    void refreshLimits(true);
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- refreshes provider limits from the server when the connected environment set changes
  useEffect(() => {
    if (showingLimits && connectedLimitsEnvironments) autoRefreshLimits();
  }, [showingLimits, connectedLimitsEnvironments]);

  const showChatGptSharing =
    !hiddenProviders.has("codex") &&
    [...presentationsWithProviders].some(
      ([id, presentation]) =>
        (selectedEnvironmentIds === null || selectedEnvironmentIds.has(id)) &&
        (presentation.serverConfig?.providers ?? []).some(usesChatGptSharing),
    );

  const topbarContent = (
    <div className="grid w-full min-w-0 grid-cols-1 items-center gap-x-3 gap-y-2 py-2 @lg/usage-header:grid-cols-[minmax(0,1fr)_auto] @4xl/usage-header:flex">
      <WorkspaceBreadcrumb ariaLabel="Usage breadcrumb" className="min-w-0">
        <WorkspaceBreadcrumbItem>
          <h1>Usage</h1>
        </WorkspaceBreadcrumbItem>
        <WorkspaceBreadcrumbSeparator />
        <WorkspaceBreadcrumbItem className="min-w-10 shrink">
          <UsageEnvironmentFilter
            environments={environments}
            selectedEnvironments={selectedEnvironments}
            selectedEnvironmentIds={selectedEnvironmentIds}
            onSelectionChange={setSelectedEnvironmentIds}
            showUsageStatus={!showingLimits}
            refreshing={refreshingUsage}
            isPartial={isPartial}
            duplicateSources={merged.duplicateSources}
            contractMismatches={merged.contractMismatches}
            onOpenModelPrices={() => setPriceDialog({})}
          />
        </WorkspaceBreadcrumbItem>
        <WorkspaceBreadcrumbSeparator />
        <WorkspaceBreadcrumbItem current className="min-w-10">
          <UsageProviderFilter
            hiddenProviders={hiddenProviders}
            onChange={(next) => updatePreferences({ hiddenProviders: next })}
          />
        </WorkspaceBreadcrumbItem>
      </WorkspaceBreadcrumb>
      {!showingLimits ? (
        <span className="hidden min-w-0 truncate text-xs @7xl/usage-header:block">
          <UsageRangePicker
            window={window}
            onChange={(sinceDay, untilDay) => setRange({ kind: "days", sinceDay, untilDay })}
          />
        </span>
      ) : null}
      <div className="ms-auto hidden shrink-0 items-center justify-end gap-2 @4xl/usage-header:flex">
        {!showingLimits ? (
          <span className="@7xl/usage-header:hidden">
            <UsageRangePicker
              compact
              window={window}
              onChange={(sinceDay, untilDay) => setRange({ kind: "days", sinceDay, untilDay })}
            />
          </span>
        ) : null}
        {/* Limits are always current, so they have no period. The period sits before the metric
            tabs so dropping it never moves them. */}
        {showingLimits ? null : (
          <ToggleGroup
            aria-label="Usage period"
            variant="segmented"
            value={periodDays === null ? [] : [String(periodDays)]}
            onValueChange={(next) => {
              const value = next[0];
              if (value) selectWindow(Number(value));
            }}
          >
            {WINDOW_OPTIONS.map((option) => (
              <Toggle key={option.days} value={String(option.days)} title={shortcutTitle(option)}>
                {option.label}
              </Toggle>
            ))}
          </ToggleGroup>
        )}
        <ToggleGroup
          aria-label="Usage metric"
          variant="segmented"
          value={[metric]}
          onValueChange={(next) => {
            const value = next[0];
            if (isUsageMetric(value)) selectMetric(value);
          }}
        >
          {METRIC_OPTIONS.map((option) => (
            <Toggle key={option.value} value={option.value} title={shortcutTitle(option)}>
              {option.label}
            </Toggle>
          ))}
        </ToggleGroup>
        <Button
          onClick={refreshWindow}
          aria-label={showingLimits ? "Refresh limits" : "Refresh usage"}
          aria-busy={isRefreshing}
          disabled={isRefreshing || (!showingLimits && !canReadDiagnostics)}
          size="icon-sm"
          variant="ghost"
        >
          <RefreshIcon size="sm" refreshing={isRefreshing} />
        </Button>
      </div>
      <div className="ms-auto flex shrink-0 items-center justify-end gap-1 @4xl/usage-header:hidden">
        {!showingLimits ? (
          <UsageRangePicker
            compact
            window={window}
            onChange={(sinceDay, untilDay) => setRange({ kind: "days", sinceDay, untilDay })}
          />
        ) : null}
        {showingLimits ? null : (
          <Select
            value={periodDays === null ? "" : String(periodDays)}
            onValueChange={(value) => selectWindow(Number(value))}
          >
            <SelectTrigger
              aria-label="Usage period"
              size="compact"
              variant="ghost"
              className="w-auto min-w-0"
            >
              <SelectValue>
                {WINDOW_OPTIONS.find((option) => option.days === periodDays)?.label ??
                  formatWindow(window)}
              </SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              {WINDOW_OPTIONS.map((option) => (
                <SelectItem
                  key={option.days}
                  value={String(option.days)}
                  title={shortcutTitle(option)}
                >
                  {option.label}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        )}
        <Select
          value={metric}
          onValueChange={(value) => {
            if (isUsageMetric(value)) selectMetric(value);
          }}
        >
          <SelectTrigger
            aria-label="Usage metric"
            size="compact"
            variant="ghost"
            className="w-auto min-w-0"
          >
            <SelectValue>
              {METRIC_OPTIONS.find((option) => option.value === metric)?.label}
            </SelectValue>
          </SelectTrigger>
          <SelectPopup align="end" alignItemWithTrigger={false}>
            {METRIC_OPTIONS.map((option) => (
              <SelectItem key={option.value} value={option.value} title={shortcutTitle(option)}>
                {option.label}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
        <Button
          onClick={refreshWindow}
          aria-label={showingLimits ? "Refresh limits" : "Refresh usage"}
          aria-busy={isRefreshing}
          disabled={isRefreshing || (!showingLimits && !canReadDiagnostics)}
          size="icon-sm"
          variant="ghost"
        >
          <RefreshIcon size="sm" refreshing={isRefreshing} />
        </Button>
      </div>
    </div>
  );

  const providerExtras = (
    <>
      {showChatGptSharing ? (
        <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
          <span>ChatGPT shared usage</span>
          <ChatGptUsageButton size="xs" />
        </div>
      ) : null}
      {cursorAccessEnvironments.map((environment) => (
        <CursorEnableRow
          key={`enable:${environment.environmentId}`}
          environmentId={environment.environmentId}
          label={environment.label}
          showEnvironment={selectedEnvironments.length > 1}
          onEnabled={() => {
            void refresh();
            void refreshLimits(false, true);
          }}
        />
      ))}
    </>
  );

  return (
    <AppRouteModal label="Usage">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <header className="@container/usage-header flex min-h-12 shrink-0 items-center gap-1 border-b ps-5 pe-2">
          {topbarContent}
          <AppRouteModalClose />
        </header>

        <ScrollArea className="min-h-0 flex-1">
          <WorkspacePageContainer width="wide">
            {selectedEnvironments.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                {environments.length === 0
                  ? `Connect an environment to see ${showingLimits ? "limits" : "usage"}.`
                  : `Select an environment to see ${showingLimits ? "limits" : "usage"}.`}
              </p>
            ) : showingLimits ? (
              <UsageLimitsSection
                selectedEnvironmentIds={selectedEnvironmentIds}
                hiddenProviders={hiddenProviders}
                now={limitsNow}
                cursorPrompt={
                  cursorAccessEnvironments.length > 0 ? (
                    <CursorEnableLimits
                      environments={cursorAccessEnvironments}
                      onEnabled={() => {
                        void refresh();
                        void refreshLimits(false, true);
                      }}
                    />
                  ) : null
                }
              />
            ) : shown === null ? (
              <UsageSkeleton />
            ) : !canReadDiagnostics ? (
              <div className="space-y-2 py-12 text-center text-sm text-muted-foreground">
                {selectedEnvironments.map((environment) => (
                  <p key={environment.environmentId}>
                    {selectedEnvironments.length > 1 ? `${environment.label}: ` : null}
                    {environment.error}
                  </p>
                ))}
              </div>
            ) : (
              <>
                {(isPending ? [] : sourceMessages).map((message) => (
                  <p key={message} className="mb-4 text-sm text-muted-foreground">
                    {message}
                  </p>
                ))}
                {selectedEnvironments.some((environment) => environment.offline) ? (
                  <div className="mb-4 flex flex-col gap-1 text-sm text-muted-foreground">
                    {selectedEnvironments
                      .filter((environment) => environment.offline)
                      .map((environment) => (
                        <p key={environment.environmentId}>{offlineNotice(environment)}</p>
                      ))}
                  </div>
                ) : null}
                <UsageExplorer
                  merged={merged}
                  previous={
                    wantsPrevious && !previous.isPending && previousCoversCurrent
                      ? previous.merged
                      : null
                  }
                  metric={metric}
                  timeline={timeline}
                  timeZone={shownWindow.timeZone}
                  preferences={explorerPreferences}
                  onPreferencesChange={changeExplorerPreferences}
                  environmentIds={selectedEnvironmentIdList}
                  environmentNote={environmentNote}
                  environmentLabel={environmentLabel}
                  accountLabel={accountLabel}
                  zoomed={range.kind === "zoom"}
                  onZoom={(sinceMs, untilMs) =>
                    setRange({
                      kind: "zoom",
                      sinceMs,
                      untilMs,
                      from: range.kind === "zoom" ? range.from : range,
                    })
                  }
                  onResetZoom={() => {
                    if (range.kind === "zoom") setRange(range.from);
                  }}
                  onOpenModel={(provider, model) => selectUsageModel(`${provider}:${model}`)}
                  onSetPrice={(model) => setPriceDialog({ model })}
                  providerExtras={providerExtras}
                  updating={loading}
                />
              </>
            )}
          </WorkspacePageContainer>
        </ScrollArea>
      </div>
      {showingLimits ? null : (
        <UsageModelDialogHost
          models={merged.models}
          environments={selectedEnvironments}
          metric={metric === "tokens" ? "tokens" : "cost"}
          chartWindow={{
            days: timeline.days,
            hours: timeline.hours,
            resolution: timeline.hours.length > 0 ? "hour" : "day",
            timeZone: shownWindow.timeZone,
            referenceTime: shownWindow.untilTime,
            hour12,
          }}
          onSetPrice={(model) => setPriceDialog({ model })}
        />
      )}
      {priceDialog ? (
        <UsagePriceOverrides
          usage={environments}
          initialSelectedEnvironmentIds={selectedEnvironmentIds}
          initialModel={priceDialog.model}
          onOpenChange={(open) => {
            if (!open) setPriceDialog(null);
          }}
        />
      ) : null}
    </AppRouteModal>
  );
}

/**
 * The shown range, which opens to pick exact days. Compact, for the one-row
 * header on narrow windows, it is a calendar button named after the range.
 */
function UsageRangePicker({
  window,
  onChange,
  compact = false,
}: {
  readonly window: UsageSummaryInput;
  readonly onChange: (sinceDay: string, untilDay: string) => void;
  readonly compact?: boolean;
}) {
  const [now, setNow] = useState(() => Date.now());
  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone: window.timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(now));
  const [open, setOpen] = useState(false);
  const [since, setSince] = useState<string>(window.sinceDay);
  const [until, setUntil] = useState<string>(window.untilDay);
  const valid = since !== "" && until !== "" && since <= until && until <= today;
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) return;
        setNow(Date.now());
        setSince(window.sinceDay);
        setUntil(window.untilDay);
      }}
    >
      {compact ? (
        <PopoverTrigger
          render={<Button size="icon-sm" variant="ghost" />}
          aria-label={`Choose dates, now ${formatWindow(window)}`}
          title={formatWindow(window)}
        >
          <CalendarDaysIcon aria-hidden />
        </PopoverTrigger>
      ) : (
        <PopoverTrigger render={<InlineButton tone="muted" />} aria-label="Choose dates">
          {formatWindow(window)}
        </PopoverTrigger>
      )}
      <PopoverPopup side="bottom" align={compact ? "end" : "start"}>
        <form
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            if (!valid) return;
            onChange(since, until);
            setOpen(false);
          }}
        >
          <div className="flex items-center gap-2 text-sm">
            <Input
              type="date"
              size="compact"
              aria-label="From"
              value={since}
              max={until || today}
              onChange={(event) => setSince(event.currentTarget.value)}
            />
            <span className="text-muted-foreground">to</span>
            <Input
              type="date"
              size="compact"
              aria-label="To"
              value={until}
              min={since}
              max={today}
              onChange={(event) => setUntil(event.currentTarget.value)}
            />
          </div>
          <Button type="submit" size="compact" disabled={!valid}>
            Show these days
          </Button>
        </form>
      </PopoverPopup>
    </Popover>
  );
}

const CURSOR_KEYCHAIN_COPY = "Requires access to your Cursor login in macOS Keychain.";

function CursorEnableButton({
  environmentId,
  label,
  onEnabled,
  tooltip,
  buttonText = "Enable",
}: {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly onEnabled: () => void;
  readonly tooltip: boolean;
  readonly buttonText?: string;
}) {
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, {
    label: "enable Cursor account usage",
  });
  const [pending, setPending] = useState(false);
  const enable = async () => {
    setPending(true);
    const result = await updateSettings({
      environmentId,
      input: { patch: { cursorKeychainUsageEnabled: true } },
    });
    if (result._tag === "Success") onEnabled();
    setPending(false);
  };
  const button = tooltip ? (
    <InlineButton
      disabled={pending}
      aria-busy={pending}
      aria-label={`Enable Cursor usage from ${label}`}
      onClick={() => void enable()}
    >
      {buttonText}
    </InlineButton>
  ) : (
    <Button
      size="sm"
      variant="outline"
      disabled={pending}
      aria-busy={pending}
      aria-label={`Enable Cursor usage from ${label}`}
      onClick={() => void enable()}
    >
      {buttonText}
    </Button>
  );
  if (!tooltip) return button;
  return (
    <Tooltip>
      <TooltipTrigger render={button} />
      <TooltipPopup>{CURSOR_KEYCHAIN_COPY}</TooltipPopup>
    </Tooltip>
  );
}

function CursorEnableRow({
  environmentId,
  label,
  showEnvironment,
  onEnabled,
}: {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly showEnvironment: boolean;
  readonly onEnabled: () => void;
}) {
  return (
    <div className="flex min-w-0 items-baseline justify-between gap-4 text-sm">
      <span className="flex min-w-0 items-center gap-2 text-sm text-foreground">
        <span
          aria-hidden
          className="size-2 shrink-0 rounded-full"
          style={{ backgroundColor: PROVIDER_PRESENTATION.cursor.color }}
        />
        <ProviderMark provider="cursor" className="size-4" />
        <span className="truncate">Cursor{showEnvironment ? ` · ${label}` : ""}</span>
      </span>
      <CursorEnableButton
        environmentId={environmentId}
        label={label}
        onEnabled={onEnabled}
        tooltip
      />
    </div>
  );
}

function CursorEnableLimits({
  environments,
  onEnabled,
}: {
  readonly environments: readonly EnvironmentUsageStatus[];
  readonly onEnabled: () => void;
}) {
  return (
    <section className="flex flex-col gap-3">
      <h2 className="flex items-center gap-2 text-sm font-medium text-foreground">
        <ProviderInstanceIcon
          driverKind={ProviderDriverKind.make("cursor")}
          displayName="Cursor"
          indicatorBackground="var(--background)"
          className="size-5"
          iconClassName="size-4 text-foreground/80"
        />
        Cursor
      </h2>
      <div className="flex flex-col items-start gap-3 rounded-lg border border-border/60 p-4">
        <p className="text-xs text-muted-foreground">{CURSOR_KEYCHAIN_COPY}</p>
        <div className="flex flex-wrap gap-2">
          {environments.map((environment) => (
            <CursorEnableButton
              key={environment.environmentId}
              environmentId={environment.environmentId}
              label={environment.label}
              buttonText={environments.length > 1 ? `Enable on ${environment.label}` : "Enable"}
              onEnabled={onEnabled}
              tooltip={false}
            />
          ))}
        </div>
      </div>
    </section>
  );
}

function ProviderMark({
  provider,
  className,
}: {
  readonly provider: UsageProviderKind;
  readonly className: string;
}) {
  const presentation = PROVIDER_PRESENTATION[provider];
  return (
    <ProviderInstanceIcon
      driverKind={presentation.driverKind}
      displayName={presentation.label}
      iconClassName={className}
    />
  );
}

/**
 * Explains failed or incompatible environments and deduplicated transcripts.
 * Shown inside the environment filter so arriving results do not move the page.
 */
function UsageCoverageNotice({
  environments,
  duplicateSources,
  contractMismatches,
}: {
  readonly environments: readonly EnvironmentUsageStatus[];
  readonly duplicateSources: readonly string[];
  readonly contractMismatches: MergedUsage["contractMismatches"];
}) {
  const failed = environments.filter((environment) => environment.error !== null);
  const offline = environments.filter((environment) => environment.offline);
  const mismatchByEnvironment = new Map(
    contractMismatches.map((mismatch) => [mismatch.environmentId, mismatch]),
  );
  const incompatible = environments.flatMap((environment) => {
    const mismatch = mismatchByEnvironment.get(environment.environmentId);
    return mismatch === undefined ? [] : [{ environment, mismatch }];
  });
  if (
    failed.length === 0 &&
    offline.length === 0 &&
    incompatible.length === 0 &&
    duplicateSources.length === 0
  ) {
    return null;
  }

  return (
    <div className="flex flex-col gap-1 border-t border-border px-2 py-2 text-xs text-muted-foreground">
      {failed.map((environment) => (
        <span key={environment.environmentId}>
          {environment.label}: {environment.error}
        </span>
      ))}
      {offline.map((environment) => (
        <span key={environment.environmentId}>{offlineNotice(environment)}</span>
      ))}
      {incompatible.map(({ environment, mismatch }) => (
        <span key={environment.environmentId}>
          {formatUsageContractMismatch(environment.label, mismatch)}
        </span>
      ))}
      {duplicateSources.length > 0 ? (
        <span>
          Counted once across environments sharing a transcript directory:{" "}
          {duplicateSources.join(", ")}
        </span>
      ) : null}
    </div>
  );
}

function UsageEnvironmentFilter({
  environments,
  selectedEnvironments,
  selectedEnvironmentIds,
  onSelectionChange,
  showUsageStatus,
  refreshing,
  isPartial,
  duplicateSources,
  contractMismatches,
  onOpenModelPrices,
}: {
  readonly environments: readonly EnvironmentUsageStatus[];
  readonly selectedEnvironments: readonly EnvironmentUsageStatus[];
  readonly selectedEnvironmentIds: ReadonlySet<EnvironmentId> | null;
  readonly onSelectionChange: (ids: ReadonlySet<EnvironmentId> | null) => void;
  readonly showUsageStatus: boolean;
  readonly refreshing: boolean;
  readonly isPartial: boolean;
  readonly duplicateSources: readonly string[];
  readonly contractMismatches: MergedUsage["contractMismatches"];
  readonly onOpenModelPrices: () => void;
}) {
  const allSelected = selectedEnvironmentIds === null;
  const label = allSelected
    ? "All environments"
    : selectedEnvironments.length === 1
      ? selectedEnvironments[0]!.label
      : `${selectedEnvironments.length} environments`;
  const hasIssue =
    selectedEnvironments.some((environment) => environment.error !== null || environment.offline) ||
    contractMismatches.length > 0;

  return (
    <Menu>
      <MenuTrigger render={<InlineButton />} className="group/usage-environment min-w-0 max-w-full">
        <WorkspaceBreadcrumbText>{label}</WorkspaceBreadcrumbText>
        <span className="flex size-3.5 shrink-0 items-center justify-center text-muted-foreground">
          {showUsageStatus && hasIssue ? (
            <CircleAlertIcon
              className="size-3.5 text-warning-foreground"
              aria-label="Some environments are offline or could not report usage"
            />
          ) : (
            <ChevronDownIcon
              className="size-3.5 opacity-60 transition-opacity group-hover/usage-environment:opacity-100 group-focus-visible/usage-environment:opacity-100 group-data-popup-open/usage-environment:opacity-100"
              aria-hidden
            />
          )}
        </span>
      </MenuTrigger>
      <MenuPopup align="start">
        <MenuCheckboxItem
          checked={allSelected}
          closeOnClick={false}
          onCheckedChange={(checked) => onSelectionChange(checked ? null : new Set())}
        >
          All environments
        </MenuCheckboxItem>
        <MenuSeparator />
        {environments.map((environment) => {
          const checked =
            selectedEnvironmentIds === null ||
            selectedEnvironmentIds.has(environment.environmentId);
          const progress = usageEnvironmentProgress(environment, refreshing);
          const status = environment.offline
            ? environment.savedAt === null
              ? "Offline"
              : `Offline · as of ${formatSavedAt(environment.savedAt)}`
            : environment.error !== null
              ? "Unavailable"
              : environment.summary !== null &&
                  !isCompatibleUsageContractVersion(
                    environment.summary.contractVersion,
                    USAGE_CONTRACT_VERSION,
                  )
                ? "Update required"
                : !environment.isConnected
                  ? "Connecting…"
                  : progress.phase === "loading"
                    ? "Scanning…"
                    : progress.phase === "stale"
                      ? "Refreshing…"
                      : progress.phase === "partway"
                        ? updatingProvidersLabel(progress.providers, providerLabel)
                        : "Ready";
          return (
            <MenuCheckboxItem
              key={environment.environmentId}
              checked={checked}
              closeOnClick={false}
              onCheckedChange={(nextChecked) => {
                const next = new Set(selectedEnvironments.map((entry) => entry.environmentId));
                if (nextChecked) next.add(environment.environmentId);
                else next.delete(environment.environmentId);
                onSelectionChange(next.size === environments.length ? null : next);
              }}
            >
              <span className="flex min-w-0 items-center gap-3">
                <span className="min-w-0 flex-1 truncate">{environment.label}</span>
                {showUsageStatus ? (
                  <span
                    className={cn(
                      "shrink-0 text-xs text-muted-foreground",
                      environment.error !== null && "text-destructive",
                    )}
                  >
                    {status}
                  </span>
                ) : null}
              </span>
            </MenuCheckboxItem>
          );
        })}
        {environments.length === 0 ? (
          <p className="px-2 py-2 text-xs text-muted-foreground">No environments connected.</p>
        ) : null}
        {showUsageStatus && isPartial ? (
          <p className="px-2 py-2 text-xs text-muted-foreground">
            Totals are partial while selected environments scan.
          </p>
        ) : null}
        {showUsageStatus ? (
          <UsageCoverageNotice
            environments={selectedEnvironments}
            duplicateSources={duplicateSources}
            contractMismatches={contractMismatches}
          />
        ) : null}
        <MenuSeparator />
        <MenuItem onClick={onOpenModelPrices}>
          <SlidersHorizontalIcon aria-hidden />
          Model prices
        </MenuItem>
      </MenuPopup>
    </Menu>
  );
}

function UsageProviderFilter({
  hiddenProviders,
  onChange,
}: {
  readonly hiddenProviders: ReadonlySet<UsageProviderKind>;
  readonly onChange: (hiddenProviders: readonly UsageProviderKind[]) => void;
}) {
  const visible = PROVIDER_ORDER.filter((provider) => !hiddenProviders.has(provider));
  const label =
    visible.length === PROVIDER_ORDER.length
      ? "All providers"
      : visible.length === 0
        ? "No providers"
        : visible.length === 1
          ? PROVIDER_PRESENTATION[visible[0]!].label
          : `${visible.length} providers`;

  return (
    <Menu>
      <MenuTrigger render={<InlineButton />} className="group/usage-provider min-w-0 max-w-full">
        <span className="min-w-0 truncate">{label}</span>
        <ChevronDownIcon
          className="size-3.5 shrink-0 text-muted-foreground opacity-60 transition-opacity group-hover/usage-provider:opacity-100 group-focus-visible/usage-provider:opacity-100 group-data-popup-open/usage-provider:opacity-100"
          aria-hidden
        />
      </MenuTrigger>
      <MenuPopup align="start">
        <MenuCheckboxItem
          checked={hiddenProviders.size === 0}
          closeOnClick={false}
          onCheckedChange={(checked) => onChange(checked ? [] : PROVIDER_ORDER)}
        >
          All providers
        </MenuCheckboxItem>
        <MenuSeparator />
        {PROVIDER_ORDER.map((provider) => (
          <MenuCheckboxItem
            key={provider}
            checked={!hiddenProviders.has(provider)}
            closeOnClick={false}
            onCheckedChange={(checked) =>
              onChange(
                PROVIDER_ORDER.filter((entry) =>
                  entry === provider ? !checked : hiddenProviders.has(entry),
                ),
              )
            }
          >
            <span className="flex min-w-0 items-center gap-2">
              <ProviderMark provider={provider} className="size-3.5" />
              <span className="truncate">{PROVIDER_PRESENTATION[provider].label}</span>
            </span>
          </MenuCheckboxItem>
        ))}
      </MenuPopup>
    </Menu>
  );
}

function UsageSkeleton() {
  return (
    <>
      <section className="grid gap-6 lg:grid-cols-[minmax(0,18rem)_minmax(0,1fr)]">
        <div className="flex flex-col gap-5">
          <div className="flex flex-col gap-1">
            <Skeleton className="h-10 w-36" />
            <Skeleton className="h-4 w-32" />
          </div>
          {PROVIDER_ORDER.map((provider) => (
            <div key={provider} className="flex flex-col gap-1">
              <div className="flex min-h-5 items-center justify-between gap-4">
                <span className="flex items-center gap-2">
                  <Skeleton shape="pill" className="size-2 shrink-0" />
                  <Skeleton shape="pill" className="size-4 shrink-0" />
                  <Skeleton className="h-3.5 w-20" />
                </span>
                <Skeleton className="h-3.5 w-14" />
              </div>
              <Skeleton className="h-4 w-36" />
            </div>
          ))}
        </div>

        <div className="flex flex-col gap-3">
          <Skeleton className="h-5 w-24" />
          <div className="flex flex-col gap-1">
            <Skeleton className="ml-16 h-56" />
            <Skeleton className="ml-16 h-4" />
          </div>
        </div>
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="text-sm font-medium text-foreground">Totals</h2>
        <MetricSkeletons
          labels={["Processed tokens", "Cached input", "Uncached input", "Output", "Cache savings"]}
        />
      </section>

      <section className="grid gap-x-12 gap-y-8 lg:grid-cols-2">
        <div className="flex flex-col gap-2.5">
          <Skeleton className="h-5 w-28" />
          <Skeleton className="h-2" />
          <Skeleton className="h-4 w-72" />
        </div>
      </section>

      <section className="flex flex-col gap-3">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-sm font-medium text-foreground">Breakdown</h2>
          <Skeleton shape="card" className="h-7 w-28" />
        </div>
        <Skeleton className="h-44" />
      </section>
    </>
  );
}

function MetricSkeletons({ labels }: { readonly labels: readonly string[] }) {
  return (
    <div className="grid grid-cols-2 gap-x-6 gap-y-4 py-1 md:grid-cols-5">
      {labels.map((label) => (
        <div key={label} className="flex flex-col gap-0.5">
          <span className="text-xs text-muted-foreground">{label}</span>
          <Skeleton className="h-6 w-16" />
        </div>
      ))}
    </div>
  );
}

const savedAtFormat = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

/** When an offline environment's shown usage was read, such as "Oct 7, 10:42 AM". */
function formatSavedAt(readAt: string): string {
  return savedAtFormat.format(new Date(readAt));
}

function offlineNotice(environment: EnvironmentUsageStatus): string {
  return environment.savedAt === null
    ? `${environment.label} is offline, and this browser has no saved usage from it for this range.`
    : `${environment.label} is offline. Its usage is shown as of ${formatSavedAt(environment.savedAt)}, when it last reported.`;
}
