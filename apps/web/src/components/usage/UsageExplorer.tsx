import type {
  ContextMenuItem,
  EnvironmentId,
  ThreadId,
  UsageProviderKind,
} from "@t3tools/contracts";
import { formatCount, formatPercent, formatTokens, formatUsd } from "@t3tools/shared/usageFormat";
import type { MergedUsage } from "@t3tools/shared/usageMerge";
import { useNavigate } from "@tanstack/react-router";
import {
  ArrowLeftIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  Columns3Icon,
  InfoIcon,
  SearchIcon,
  XIcon,
} from "lucide-react";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { writeTextToClipboard } from "~/hooks/useCopyToClipboard";
import { readLocalApi } from "~/localApi";
import { cn } from "../../lib/utils";
import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";
import { Button, InlineButton } from "../ui/button";
import { InputGroup, InputGroupAddon, InputGroupInput } from "../ui/input-group";
import {
  Menu,
  MenuCheckboxItem,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuTrigger,
} from "../ui/menu";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { toastManager } from "../ui/toast";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { UsageShareBar } from "./UsageShareBar";
import { UsageStackedChart } from "./UsageStackedChart";
import { UsageTypeBreakdown } from "./UsageTypeBreakdown";
import { speedCostSegments } from "./usageBreakdown";
import { SpeedPremium } from "./UsageModelDialog";
import {
  type BreakdownDimension,
  type BreakdownRow,
  buildBreakdownRows,
  type ItemRow,
} from "./usageBreakdownRows";
import {
  buildExplorerData,
  buildSeries,
  cachedShare,
  chartColumns,
  binKey,
  DEFAULT_COLUMNS,
  foldFacts,
  formatShare,
  isUnpriced,
  keyFor,
  matchesFilters,
  metricOf,
  modelKey,
  OTHER_SERIES,
  OUTSIDE_PROJECTS,
  speedCostOf,
  splitModelKey,
  sumFacts,
  tidyTitle,
  timelineBins,
  tokensOf,
  toCsv,
  UNKNOWN_PROJECT,
  USAGE_COLUMNS,
  type UsageColumnId,
  type UsageDimension,
  type UsageExplorerData,
  type UsageExplorerMetric,
  type UsageFact,
  type UsageFilters,
  type UsageSort,
  type UsageTotals,
} from "./usageExplorerModel";
import type { UsageExplorerPreferences } from "./usagePagePreferences";
import { PROVIDER_ORDER, PROVIDER_PRESENTATION } from "./usageProviders";
import { binEndMs, binStartMs, formatBin, type WindowTimeline } from "./usageWindow";

const DIMENSIONS: readonly {
  readonly value: UsageDimension;
  readonly label: string;
  readonly one: string;
}[] = [
  { value: "project", label: "Projects", one: "project" },
  { value: "provider", label: "Providers", one: "provider" },
  { value: "model", label: "Models", one: "model" },
  { value: "environment", label: "Environments", one: "environment" },
  { value: "thread", label: "Threads", one: "thread" },
];

const NOUNS: Record<BreakdownDimension, readonly [string, string]> = {
  project: ["project", "projects"],
  provider: ["provider", "providers"],
  account: ["account", "accounts"],
  model: ["model", "models"],
  environment: ["environment", "environments"],
  thread: ["thread", "threads"],
};
const NO_FILTERS: UsageFilters = { accounts: null, environment: null, project: null, model: null };

const noun = (dimension: BreakdownDimension, count: number) =>
  NOUNS[dimension][count === 1 ? 0 : 1];

export interface UsageExplorerProps {
  readonly merged: MergedUsage;
  /** The same span just before, when the Change column needs it. */
  readonly previous: MergedUsage | null;
  readonly metric: UsageExplorerMetric;
  readonly timeline: WindowTimeline;
  readonly timeZone: string;
  readonly preferences: UsageExplorerPreferences;
  readonly onPreferencesChange: (next: UsageExplorerPreferences) => void;
  /** The environments selected in the page's environment menu. */
  readonly environmentIds: readonly string[];
  readonly environmentLabel: (environmentId: string) => string;
  readonly accountLabel: (account: string, provider: UsageProviderKind) => string;
  readonly zoomed: boolean;
  readonly onZoom: (sinceMs: number, untilMs: number) => void;
  readonly onResetZoom: () => void;
  readonly onOpenModel: (provider: UsageProviderKind, model: string) => void;
  readonly onSetPrice: (model: string) => void;
  /** Rows below the provider list, such as Cursor's enable prompt. */
  readonly providerExtras?: ReactNode;
  /**
   * Shown instead of the page while a new range loads. The explorer stays
   * mounted, so focus, filters and open rows survive a zoom or range change.
   */
  readonly loading?: ReactNode;
}

export function UsageExplorer(props: UsageExplorerProps) {
  const { merged, metric, timeline, timeZone, preferences, onPreferencesChange } = props;
  const { environmentLabel, accountLabel, previous } = props;
  const navigate = useNavigate();
  const data = useMemo(
    () =>
      buildExplorerData(
        merged.contributions.map((contribution) => ({
          ...contribution,
          environmentLabel: environmentLabel(contribution.environmentId),
        })),
      ),
    [environmentLabel, merged],
  );
  const previousData = useMemo(
    () =>
      previous === null
        ? null
        : buildExplorerData(
            previous.contributions.map((contribution) => ({
              ...contribution,
              environmentLabel: environmentLabel(contribution.environmentId),
            })),
          ),
    [environmentLabel, previous],
  );

  const [filterState, setFilters] = useState<UsageFilters>(NO_FILTERS);
  const [threadView, setThreadView] = useState(false);
  const [hidden, setHidden] = useState<Record<UsageDimension, ReadonlySet<string>>>(() => ({
    project: new Set(),
    provider: new Set(),
    model: new Set(),
    environment: new Set(),
    thread: new Set(),
  }));
  const [sort, setSort] = useState<UsageSort | null>(null);
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const [showAll, setShowAll] = useState<ReadonlySet<string>>(new Set());
  const [query, setQuery] = useState("");
  const [highlight, setHighlight] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);

  const environments = useMemo(() => new Set(props.environmentIds), [props.environmentIds]);
  const environmentCount = environments.size;
  // A focused environment deselected in the page's menu stops filtering.
  const filters = useMemo(
    () =>
      filterState.environment !== null && !environments.has(filterState.environment)
        ? { ...filterState, environment: null }
        : filterState,
    [environments, filterState],
  );
  // Threads live inside a project: the tab works only while one is focused.
  // Environments needs two to compare; with one, the page groups by project.
  const dimension: UsageDimension =
    threadView && filters.project !== null && data.hasThreads
      ? "thread"
      : preferences.dimension === "environment" && environmentCount < 2
        ? "project"
        : preferences.dimension;
  const favorites = useMemo(() => new Set(preferences.favorites), [preferences.favorites]);

  const resetDrill = () => {
    setOpen(new Set());
    setShowAll(new Set());
    setSort(null);
    setHighlight(null);
  };

  /* ------------------------------ names ------------------------------ */
  const accountProvider = useMemo(() => {
    const map = new Map<string, UsageProviderKind>();
    for (const fact of data.facts) map.set(fact.account, fact.provider);
    return map;
  }, [data.facts]);
  const nameOf = useCallback(
    (dim: BreakdownDimension, key: string): string => {
      switch (dim) {
        case "project":
          return key === OUTSIDE_PROJECTS
            ? "Outside projects"
            : key === UNKNOWN_PROJECT
              ? "Unknown folder"
              : ((filters.environment === null ? data.projectNames : data.projectTitles).get(key) ??
                "Unknown project");
        case "provider":
          return PROVIDER_PRESENTATION[key as UsageProviderKind]?.label ?? key;
        case "account":
          return accountLabel(key, accountProvider.get(key) ?? (key as UsageProviderKind));
        case "model":
          return splitModelKey(key).model;
        case "environment":
          return environmentLabel(key);
        case "thread":
          return threadTitle(data, key);
      }
    },
    [accountLabel, accountProvider, data, environmentLabel, filters.environment],
  );

  // Under an environment, its projects need no environment in their names.
  const rowName = (row: ItemRow) =>
    row.dimension === "project" && row.ancestors.some((step) => step.dimension === "environment")
      ? (data.projectTitles.get(row.key) ?? nameOf("project", row.key))
      : nameOf(row.dimension, row.key);

  /* ------------------------------ facts ------------------------------ */
  const filtered = useMemo(
    () => data.facts.filter((fact) => matchesFilters(fact, filters)),
    [data.facts, filters],
  );
  const hiddenNow = hidden[dimension];
  const visible = useMemo(
    () =>
      hiddenNow.size === 0
        ? filtered
        : filtered.filter((fact) => {
            const key = keyFor(dimension, fact, data.threads);
            return key === null || !hiddenNow.has(key);
          }),
    [data.threads, dimension, filtered, hiddenNow],
  );
  const total = useMemo(() => sumFacts(visible), [visible]);
  // Short spans read better per hour than per partial day. Days are local.
  const perActive = useMemo(() => {
    const hourly = timeline.hours.length > 0 && timeline.hours.length <= 48;
    const active = new Set(
      visible.map((fact) => (hourly ? fact.time : binKey(fact.time, 1440, timeZone))),
    ).size;
    return {
      tokens: active === 0 ? 0 : tokensOf(total) / active,
      unit: hourly ? ("hour" as const) : ("day" as const),
    };
  }, [timeZone, timeline.hours.length, total, visible]);
  const previousFiltered = useMemo(
    () => previousData?.facts.filter((fact) => matchesFilters(fact, filters)) ?? null,
    [filters, previousData],
  );
  // Hidden series leave both windows, so the comparison stays like for like.
  const previousVisible = useMemo(
    () =>
      previousFiltered === null || previousData === null || hiddenNow.size === 0
        ? previousFiltered
        : previousFiltered.filter((fact) => {
            const key = keyFor(dimension, fact, previousData.threads);
            return key === null || !hiddenNow.has(key);
          }),
    [dimension, hiddenNow, previousData, previousFiltered],
  );
  const previousByKey = useMemo(
    () =>
      previousFiltered === null || previousData === null
        ? undefined
        : foldFacts(previousFiltered, (fact) => keyFor(dimension, fact, previousData.threads)),
    [dimension, previousData, previousFiltered],
  );

  /* ------------------------------ series ----------------------------- */
  const totalsByKey = useMemo(
    () => foldFacts(filtered, (fact) => keyFor(dimension, fact, data.threads)),
    [data.threads, dimension, filtered],
  );
  const allByKey = useMemo(() => {
    const unfiltered = data.facts.filter((fact) =>
      matchesFilters(fact, { ...filters, accounts: null }),
    );
    return foldFacts(unfiltered, (fact) => keyFor(dimension, fact, data.threads));
  }, [data.facts, data.threads, dimension, filters]);
  const { series, seriesOf, colorOf } = useMemo(
    () =>
      buildSeries(totalsByKey, allByKey, metric, (key) =>
        dimension === "provider"
          ? PROVIDER_PRESENTATION[key as UsageProviderKind]?.color
          : undefined,
      ),
    [allByKey, dimension, metric, totalsByKey],
  );
  const bins = useMemo(
    () => timelineBins(timeline, timeline.binMinutes, timeZone),
    [timeZone, timeline],
  );
  const columns = useMemo(
    () =>
      chartColumns({
        facts: visible,
        bins,
        series,
        seriesOf: (fact) => {
          const key = keyFor(dimension, fact, data.threads);
          return key === null ? null : seriesOf(key);
        },
        binOf: (fact) => binKey(fact.time, timeline.binMinutes, timeZone),
        metric,
        running: preferences.running,
      }),
    [
      bins,
      data.threads,
      dimension,
      metric,
      preferences.running,
      series,
      seriesOf,
      timeZone,
      timeline.binMinutes,
      visible,
    ],
  );

  /* ------------------------------ table ------------------------------ */
  const accountsByProvider = useMemo(() => {
    const map = new Map<string, Set<string>>();
    for (const fact of filtered) {
      const set = map.get(fact.provider) ?? new Set<string>();
      set.add(fact.account);
      map.set(fact.provider, set);
    }
    return map;
  }, [filtered]);
  const rows = useMemo(
    () =>
      buildBreakdownRows({
        dimension,
        facts: filtered,
        tree: data.threads,
        metric,
        sort,
        nameOf,
        nounOf: noun,
        seriesOf,
        colorOf,
        hidden: hiddenNow,
        favorites,
        accountsOfProvider: (provider) => accountsByProvider.get(provider)?.size ?? 0,
        open,
        showAll,
        query,
        ...(previousByKey === undefined ? {} : { previous: previousByKey }),
      }),
    [
      accountsByProvider,
      colorOf,
      data.threads,
      dimension,
      favorites,
      filtered,
      hiddenNow,
      metric,
      nameOf,
      open,
      previousByKey,
      query,
      seriesOf,
      showAll,
      sort,
    ],
  );

  /* ------------------------------ actions ---------------------------- */
  const setPreference = (patch: Partial<UsageExplorerPreferences>) =>
    onPreferencesChange({ ...preferences, ...patch });
  const toggleHidden = (keys: readonly string[]) =>
    setHidden((current) => {
      const next = new Set(current[dimension]);
      const allHidden = keys.every((key) => next.has(key));
      for (const key of keys) {
        if (allHidden) next.delete(key);
        else next.add(key);
      }
      return { ...current, [dimension]: next };
    });
  const showOnly = (key: string) =>
    setHidden((current) => ({
      ...current,
      [dimension]: new Set([...totalsByKey.keys()].filter((other) => other !== key)),
    }));
  const toggleOpen = (path: string) =>
    setOpen((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  const toggleShowAll = (path: string) =>
    setShowAll((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  const accountsOf = (provider: string) => [
    ...new Set(data.facts.filter((fact) => fact.provider === provider).map((fact) => fact.account)),
  ];
  const allAccounts = useMemo(
    () => [...new Set(data.facts.map((fact) => fact.account))],
    [data.facts],
  );
  const setAccounts = (accounts: readonly string[] | null) => {
    const next =
      accounts === null || allAccounts.every((account) => accounts.includes(account))
        ? null
        : new Set(accounts);
    setFilters((current) => ({ ...current, accounts: next }));
    resetDrill();
  };
  const focus = (dim: BreakdownDimension, key: string, ancestors: ItemRow["ancestors"] = []) => {
    const next = { ...filters };
    let nextDimension = preferences.dimension;
    let toThreads = false;
    for (const step of [...ancestors, { dimension: dim, key }]) {
      if (step.dimension === "project") {
        next.project = step.key;
        toThreads = true;
      } else if (step.dimension === "model") {
        next.model = step.key;
        nextDimension = "project";
      } else if (step.dimension === "provider") {
        next.accounts = new Set(accountsOf(step.key));
        nextDimension = "model";
      } else if (step.dimension === "account") {
        next.accounts = new Set([step.key]);
        nextDimension = "model";
      } else if (step.dimension === "environment") {
        next.environment = step.key;
        nextDimension = "project";
      }
    }
    setFilters(next);
    setThreadView(toThreads);
    if (!toThreads && nextDimension !== preferences.dimension)
      setPreference({ dimension: nextDimension });
    setQuery("");
    resetDrill();
  };
  /** Clears the deepest focus: project, then model, then provider, then environment. */
  const back = () => {
    if (filters.project !== null) {
      setFilters({ ...filters, project: null });
      setThreadView(false);
    } else if (filters.model !== null) {
      setFilters({ ...filters, model: null });
      setPreference({ dimension: "model" });
    } else if (filters.accounts !== null) {
      setFilters({ ...filters, accounts: null });
      setPreference({ dimension: "provider" });
    } else if (filters.environment !== null) {
      setFilters({ ...filters, environment: null });
      setPreference({ dimension: "environment" });
    }
    resetDrill();
  };
  const toggleFavorite = (key: string) =>
    setPreference({
      favorites: favorites.has(key)
        ? preferences.favorites.filter((entry) => entry !== key)
        : [...preferences.favorites, key],
    });
  const openThread = (key: string) => {
    const t3 = data.threads.info.get(key)?.t3;
    if (t3 === null || t3 === undefined) return;
    void navigate({
      to: "/$environmentId/$threadId",
      params: {
        environmentId: t3.environmentId as EnvironmentId,
        threadId: t3.threadId as ThreadId,
      },
    });
  };
  const copy = (text: string, what: string) => {
    void writeTextToClipboard(text).then(
      () => toastManager.add({ type: "success", title: `Copied ${what}` }),
      () => toastManager.add({ type: "error", title: `Could not copy ${what}` }),
    );
  };

  const showMenu = async (row: ItemRow, position: { x: number; y: number }) => {
    const api = readLocalApi();
    if (!api) return;
    const name = rowName(row);
    type Action =
      | "expand"
      | "focus"
      | "only-account"
      | "exclude"
      | "favorite"
      | "hide"
      | "show-only"
      | "open"
      | "parent"
      | "details"
      | "price"
      | "copy-name"
      | "copy-id";
    const items: ContextMenuItem<Action>[] = [];
    if (row.expandable) items.push({ id: "expand", label: row.open ? "Collapse" : "Expand" });
    const info = row.dimension === "thread" ? data.threads.info.get(row.key) : undefined;
    if (row.dimension === "thread") {
      if (info?.t3) items.push({ id: "open", label: "Open thread" });
      const parent =
        info?.parent === null || info?.parent === undefined
          ? undefined
          : data.threads.info.get(info.parent);
      if (parent?.t3) {
        items.push({ id: "parent", label: "Go to parent thread" });
      }
    } else if (row.dimension === "provider" || row.dimension === "account") {
      items.push({ id: "focus", label: `Focus on this ${NOUNS[row.dimension][0]}` });
      items.push({ id: "only-account", label: `Filter to this ${NOUNS[row.dimension][0]}` });
      items.push({ id: "exclude", label: `Exclude this ${NOUNS[row.dimension][0]}` });
    } else {
      items.push({ id: "focus", label: `Focus on this ${NOUNS[row.dimension][0]}` });
    }
    if (
      row.dimension === "project" &&
      row.key !== OUTSIDE_PROJECTS &&
      row.key !== UNKNOWN_PROJECT
    ) {
      items.push({
        id: "favorite",
        label: favorites.has(row.key) ? "Remove from favourites" : "Favourite project",
      });
    }
    if (row.dimension === "model") {
      items.push({ id: "details", label: "Model details" });
      if (isUnpriced(row.totals)) items.push({ id: "price", label: "Set price" });
    }
    if (row.color !== null) {
      items.push({
        id: "hide",
        label: row.hidden ? "Show on chart" : "Hide from chart",
        separatorBefore: true,
      });
      items.push({ id: "show-only", label: "Show only this on chart" });
    }
    items.push({
      id: "copy-name",
      label: row.dimension === "thread" ? "Copy title" : "Copy name",
      icon: "copy",
      separatorBefore: true,
    });
    if (info?.t3) items.push({ id: "copy-id", label: "Copy thread ID", icon: "copy" });
    let action: Action | null = null;
    try {
      action = await api.contextMenu.show(items, position);
    } catch {
      return;
    }
    switch (action) {
      case "expand":
        toggleOpen(row.path);
        break;
      case "focus":
        focus(row.dimension, row.key, row.ancestors);
        break;
      case "only-account":
        setAccounts(row.dimension === "provider" ? accountsOf(row.key) : [row.key]);
        break;
      case "exclude": {
        const remove = new Set(row.dimension === "provider" ? accountsOf(row.key) : [row.key]);
        setAccounts(
          (filters.accounts === null ? allAccounts : [...filters.accounts]).filter(
            (account) => !remove.has(account),
          ),
        );
        break;
      }
      case "favorite":
        toggleFavorite(row.key);
        break;
      case "hide":
        toggleHidden([row.key]);
        break;
      case "show-only":
        showOnly(row.key);
        break;
      case "open":
        openThread(row.key);
        break;
      case "parent":
        if (info?.parent) openThread(info.parent);
        break;
      case "details": {
        const { provider, model } = splitModelKey(row.key);
        props.onOpenModel(provider as UsageProviderKind, model);
        break;
      }
      case "price":
        props.onSetPrice(splitModelKey(row.key).model);
        break;
      case "copy-name":
        copy(name, row.dimension === "thread" ? "title" : "name");
        break;
      case "copy-id":
        if (info?.t3) copy(info.t3.threadId, "thread ID");
        break;
      case null:
        break;
    }
  };

  const downloadCsv = () => {
    const shownColumns = preferences.columns.filter(
      (column) => column !== "change" || previousByKey !== undefined,
    );
    const whole = metricOf(sumFacts(filtered), metric);
    const header = [
      DIMENSIONS.find((entry) => entry.value === dimension)?.one ?? dimension,
      ...shownColumns.map((column) =>
        column === "share"
          ? `Share of ${metric} %`
          : column === "cost"
            ? "Cost USD"
            : (USAGE_COLUMNS.find((c) => c.id === column)?.label ?? column),
      ),
    ];
    const lines = [...totalsByKey]
      .filter(([, totals]) => tokensOf(totals) > 0 || totals.costUsd > 0)
      .sort((a, b) => metricOf(b[1], metric) - metricOf(a[1], metric))
      .map(([key, totals]) => [
        nameOf(dimension, key),
        ...shownColumns.map((column) =>
          csvCell(column, totals, whole, metric, previousByKey?.get(key)),
        ),
      ]);
    const anchor = document.createElement("a");
    anchor.href = URL.createObjectURL(new Blob([toCsv([header, ...lines])], { type: "text/csv" }));
    anchor.download = `usage-${dimension}s.csv`;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(anchor.href), 1000);
  };

  // "/" jumps to search, Escape clears it.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (
        event.key !== "/" ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        event.defaultPrevented
      )
        return;
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, textarea, select, [contenteditable='true']")) return;
      event.preventDefault();
      searchRef.current?.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  /* ------------------------------ render ----------------------------- */
  const format = metric === "cost" ? formatUsd : formatTokens;
  const formatAxis = (value: number) =>
    metric === "cost" && Number.isInteger(value) ? `$${formatCount(value)}` : format(value);
  const hiddenCount = hiddenNow.size;
  const providerScope = useMemo(
    () => data.facts.filter((fact) => matchesFilters(fact, { ...filters, accounts: null })),
    [data.facts, filters],
  );
  const chips = [
    filters.environment === null
      ? null
      : {
          label: "Environment",
          value: nameOf("environment", filters.environment),
          clear: () => {
            setFilters({ ...filters, environment: null });
            resetDrill();
          },
        },
    filters.accounts === null
      ? null
      : {
          label: "Provider",
          value: describeAccounts(filters.accounts, accountsOf, nameOf),
          clear: () => setAccounts(null),
        },
    filters.model === null
      ? null
      : {
          label: "Model",
          value: splitModelKey(filters.model).model,
          clear: () => {
            setFilters({ ...filters, model: null });
            resetDrill();
          },
        },
    filters.project === null
      ? null
      : {
          label: "Project",
          value: nameOf("project", filters.project),
          clear: () => {
            setFilters({ ...filters, project: null });
            setThreadView(false);
            resetDrill();
          },
        },
  ].filter((chip) => chip !== null);
  const backLabel =
    filters.project !== null
      ? "All projects"
      : filters.model !== null
        ? "All models"
        : filters.accounts !== null
          ? "All providers"
          : filters.environment !== null
            ? "All environments"
            : null;
  const title =
    dimension === "thread" && filters.project !== null
      ? `Threads in ${nameOf("project", filters.project)}`
      : (DIMENSIONS.find((entry) => entry.value === dimension)?.label ?? "");
  const visibleColumns = preferences.columns.filter((column) =>
    USAGE_COLUMNS.some((entry) => entry.id === column),
  );

  if (props.loading) return props.loading;

  return (
    <>
      <section className="grid gap-6 lg:grid-cols-[minmax(0,18rem)_minmax(0,1fr)]">
        <div className="flex min-w-0 flex-col gap-5">
          <Headline
            metric={metric}
            total={total}
            hiddenCount={hiddenCount}
            previous={previousVisible === null ? null : sumFacts(previousVisible)}
          />
          <ProviderList
            facts={providerScope}
            metric={metric}
            accounts={filters.accounts}
            accountName={(account) => nameOf("account", account)}
            onAccountsChange={setAccounts}
          />
          {props.providerExtras}
        </div>
        <div className="flex min-w-0 flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <ToggleGroup
              aria-label="Chart values"
              variant="segmented"
              value={[preferences.running ? "running" : "interval"]}
              onValueChange={(next) => {
                if (next[0] === "running" || next[0] === "interval") {
                  setPreference({ running: next[0] === "running" });
                }
              }}
            >
              <Toggle value="interval" title="What each interval used on its own">
                Per interval
              </Toggle>
              <Toggle
                value="running"
                title="Adds up from the start of the range; the end matches the total"
              >
                Running total
              </Toggle>
            </ToggleGroup>
            <ToggleGroup
              aria-label="Group by"
              variant="segmented"
              value={[dimension]}
              onValueChange={(next) => {
                const value = next[0];
                if (value === "thread") {
                  if (filters.project !== null) setThreadView(true);
                } else if (
                  value === "project" ||
                  value === "provider" ||
                  value === "model" ||
                  value === "environment"
                ) {
                  setThreadView(false);
                  setPreference({ dimension: value });
                }
                resetDrill();
              }}
            >
              {DIMENSIONS.filter(
                (entry) => entry.value !== "environment" || environmentCount > 1,
              ).map((entry) => (
                <Toggle
                  key={entry.value}
                  value={entry.value}
                  disabled={
                    entry.value === "thread" && (filters.project === null || !data.hasThreads)
                  }
                  title={
                    entry.value === "thread" && filters.project === null
                      ? "Threads live inside a project: focus one below"
                      : undefined
                  }
                >
                  {entry.label}
                </Toggle>
              ))}
            </ToggleGroup>
            {props.zoomed ? (
              <span className="text-xs">
                <InlineButton tone="muted" onClick={props.onResetZoom}>
                  Reset zoom
                </InlineButton>
              </span>
            ) : null}
          </div>
          <UsageStackedChart
            columns={columns}
            series={series.map((entry) => ({
              key: entry.key,
              color: entry.color,
              label:
                entry.key === OTHER_SERIES
                  ? `Other (${entry.members.length})`
                  : nameOf(dimension, entry.key),
            }))}
            format={format}
            formatAxis={formatAxis}
            formatBin={(bin) => formatBin(bin, timeZone)}
            running={preferences.running}
            // A hidden series has no band to bring forward.
            highlightKey={highlight !== null && hiddenNow.has(highlight) ? null : highlight}
            onHoverSeries={setHighlight}
            onZoom={(firstBin, lastBin) =>
              props.onZoom(
                binStartMs(firstBin, timeZone),
                binEndMs(lastBin, timeline.binMinutes, timeZone),
              )
            }
            ariaLabel={`${preferences.running ? "Running " : ""}${metric === "cost" ? "cost" : "tokens"} by ${DIMENSIONS.find((entry) => entry.value === dimension)?.one ?? dimension}`}
          />
        </div>
      </section>

      <UsageTypeBreakdown total={total} metric={metric} perActive={perActive} />
      {metric === "cost" && total.fastUsd + total.ultrafastUsd > 0 ? (
        <UsageShareBar
          label="Cost by speed"
          segments={speedCostSegments(speedCostOf(total))}
          format={formatUsd}
          aside={<SpeedPremium premiumUsd={total.premiumUsd} />}
        />
      ) : null}

      <section className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2">
            {backLabel === null ? null : (
              <Button size="compact" variant="outline" onClick={back}>
                <ArrowLeftIcon aria-hidden />
                {backLabel}
              </Button>
            )}
            <h2 className="truncate text-sm font-medium text-foreground">{title}</h2>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {hiddenCount > 0 ? (
              <span className="text-xs text-muted-foreground">
                {formatCount(hiddenCount)} hidden ·{" "}
                <InlineButton
                  tone="muted"
                  onClick={() => setHidden((current) => ({ ...current, [dimension]: new Set() }))}
                >
                  show all
                </InlineButton>
              </span>
            ) : null}
            {dimension === "thread" ? (
              <ThreadFilters
                facts={data.facts.filter(
                  (fact) =>
                    fact.project === filters.project &&
                    (filters.environment === null || fact.environment === filters.environment),
                )}
                filters={filters}
                accountName={(account) => nameOf("account", account)}
                onAccountsChange={setAccounts}
                onModelChange={(model) => {
                  setFilters({ ...filters, model });
                  resetDrill();
                }}
              />
            ) : null}
            <InputGroup className="w-44">
              <InputGroupAddon>
                <SearchIcon aria-hidden />
              </InputGroupAddon>
              <InputGroupInput
                ref={searchRef}
                type="search"
                size="compact"
                placeholder="Search"
                aria-label="Search projects, threads and models"
                value={query}
                onChange={(event) => setQuery(event.currentTarget.value)}
                onKeyDown={(event) => {
                  if (event.key === "Escape" && query !== "") {
                    event.stopPropagation();
                    setQuery("");
                  }
                }}
              />
            </InputGroup>
            <ColumnsMenu
              columns={visibleColumns}
              onChange={(next) => setPreference({ columns: next })}
              onDownload={downloadCsv}
            />
          </div>
        </div>
        {chips.length === 0 ? null : (
          <div className="flex flex-wrap items-center gap-1.5">
            {chips.map((chip) => (
              <span
                key={chip.label}
                className="inline-flex items-center gap-1 rounded-full border border-border px-2 py-0.5 text-xs"
              >
                <span className="text-muted-foreground">{chip.label}</span>
                <span className="text-foreground">{chip.value}</span>
                <button
                  type="button"
                  className="text-muted-foreground hover:text-foreground"
                  aria-label={`Clear ${chip.label.toLowerCase()} filter`}
                  onClick={chip.clear}
                >
                  <XIcon className="size-3" aria-hidden />
                </button>
              </span>
            ))}
            {chips.length > 1 ? (
              <InlineButton
                tone="muted"
                onClick={() => {
                  setFilters(NO_FILTERS);
                  setThreadView(false);
                  resetDrill();
                }}
              >
                Clear filters
              </InlineButton>
            ) : null}
          </div>
        )}
        <BreakdownTable
          rows={rows}
          dimension={dimension}
          columns={visibleColumns}
          hasPrevious={previousByKey !== undefined}
          metric={metric}
          sort={sort}
          onSort={(column) =>
            setSort((current) =>
              current?.column === column
                ? current.descending
                  ? { column, descending: false }
                  : null
                : { column, descending: column !== "name" },
            )
          }
          rowName={rowName}
          threads={data}
          favorites={favorites}
          onToggleOpen={toggleOpen}
          onToggleShowAll={toggleShowAll}
          onToggleHidden={toggleHidden}
          onFocus={focus}
          onMenu={(row, position) => void showMenu(row, position)}
          onOpenThread={openThread}
          onOpenModel={(key) => {
            const { provider, model } = splitModelKey(key);
            props.onOpenModel(provider as UsageProviderKind, model);
          }}
          onHoverRow={setHighlight}
          highlight={highlight}
          seriesOf={seriesOf}
        />
      </section>

      <details className="text-xs text-muted-foreground">
        <summary className="cursor-pointer select-none">How these numbers are calculated</summary>
        <p className="mt-2 max-w-3xl leading-relaxed">
          Usage is read from each environment's Claude Code, Codex, Grok, OpenCode, Antigravity and
          Cursor history, including work run outside T3. Cost is the API list price for those
          tokens, not your bill. Work in a T3 thread is placed in that thread's project. Sessions
          started outside T3 are placed by the folder they ran in; anything outside every project
          shows as Outside projects. When environments read the same history folder, its usage
          counts once, under the environment that ran most of it in T3 threads. Sub-agents are
          listed under the thread that started them. Cache write cost is what writing the prompt
          cache cost at list price; a thread is tagged cache-heavy when at least half of its own
          cost went there.
        </p>
      </details>
    </>
  );
}

function csvCell(
  column: UsageColumnId,
  totals: UsageTotals,
  whole: number,
  metric: UsageExplorerMetric,
  previous: UsageTotals | undefined,
): string | number {
  switch (column) {
    case "cost":
      return isUnpriced(totals) ? "" : Number(totals.costUsd.toFixed(2));
    case "share":
      return whole === 0 ? 0 : Number(((metricOf(totals, metric) / whole) * 100).toFixed(2));
    case "tokens":
      return tokensOf(totals);
    case "input":
      return totals.input;
    case "output":
      return totals.output;
    case "cacheRead":
      return totals.cacheRead;
    case "cacheWrite":
      return totals.cacheWrite;
    case "cacheWriteCost":
      return Number(totals.cacheWriteUsd.toFixed(2));
    case "cached": {
      const share = cachedShare(totals);
      return share === null ? "" : Number((share * 100).toFixed(1));
    }
    case "change":
      return Number((metricOf(totals, metric) - metricOf(previous, metric)).toFixed(2));
  }
}

function threadTitle(data: UsageExplorerData, key: string): string {
  const info = data.threads.info.get(key);
  if (info?.title) return tidyTitle(info.title);
  if (info?.agent) return "Sub-agent";
  return info?.t3 ? "Untitled thread" : "Session outside T3";
}

function describeAccounts(
  accounts: ReadonlySet<string>,
  accountsOf: (provider: string) => readonly string[],
  nameOf: (dimension: BreakdownDimension, key: string) => string,
): string {
  const parts: string[] = [];
  const covered = new Set<string>();
  for (const provider of PROVIDER_ORDER) {
    const all = accountsOf(provider);
    if (all.length > 0 && all.every((account) => accounts.has(account))) {
      parts.push(nameOf("provider", provider));
      for (const account of all) covered.add(account);
    }
  }
  for (const account of accounts) if (!covered.has(account)) parts.push(nameOf("account", account));
  return parts.length === 0 ? "None" : parts.join(", ");
}

/* -------------------------------------------------------------------------- */

function Headline({
  metric,
  total,
  hiddenCount,
  previous,
}: {
  readonly metric: UsageExplorerMetric;
  readonly total: UsageTotals;
  readonly hiddenCount: number;
  readonly previous: UsageTotals | null;
}) {
  const value = metricOf(total, metric);
  const before = previous === null ? null : metricOf(previous, metric);
  const format = metric === "cost" ? formatUsd : formatTokens;
  const unpricedShare = total.records === 0 ? 0 : total.unpricedRecords / total.records;
  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs text-muted-foreground uppercase">
        {hiddenCount > 0
          ? "Visible total"
          : metric === "cost"
            ? "API-equivalent cost"
            : "Processed tokens"}
      </span>
      <span className="flex items-baseline gap-2">
        <span className="text-4xl font-semibold text-foreground tabular-nums">{format(value)}</span>
        <Popover>
          <PopoverTrigger
            openOnHover
            render={<InlineButton tone="muted" />}
            aria-label="About this total"
          >
            <InfoIcon className="size-3.5" aria-hidden />
          </PopoverTrigger>
          <PopoverPopup side="top" tooltipStyle>
            <div className="flex max-w-64 flex-col gap-1">
              <span>
                {metric === "cost"
                  ? "Full API list price, not your bill."
                  : "Input, cache and output tokens."}
              </span>
              <span>{formatCount(total.records)} requests.</span>
              {unpricedShare > 0 ? (
                <span>
                  {formatPercent(unpricedShare)} of requests have no known price and add no cost.
                </span>
              ) : null}
              {before === null ? null : (
                <span>
                  {before === 0
                    ? "Nothing in the same length of time before."
                    : `${value >= before ? "Up" : "Down"} ${formatPercent(Math.abs(value - before) / before, 0)} on the same length of time before (${format(before)}).`}
                </span>
              )}
            </div>
          </PopoverPopup>
        </Popover>
      </span>
    </div>
  );
}

function ProviderList({
  facts,
  metric,
  accounts,
  accountName,
  onAccountsChange,
}: {
  readonly facts: readonly UsageFact[];
  readonly metric: UsageExplorerMetric;
  readonly accounts: ReadonlySet<string> | null;
  readonly accountName: (account: string) => string;
  readonly onAccountsChange: (accounts: readonly string[] | null) => void;
}) {
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const byProvider = foldFacts(facts, (fact) => fact.provider);
  const byAccount = foldFacts(facts, (fact) => fact.account);
  const accountsOf = new Map<string, string[]>();
  for (const fact of facts) {
    const list = accountsOf.get(fact.provider) ?? [];
    if (!list.includes(fact.account)) list.push(fact.account);
    accountsOf.set(fact.provider, list);
  }
  const all = [...byAccount.keys()];
  const whole = metricOf(sumFacts(facts), metric);
  const selected = (account: string) => accounts === null || accounts.has(account);
  const providers = PROVIDER_ORDER.filter((provider) => {
    const totals = byProvider.get(provider);
    return totals !== undefined && (tokensOf(totals) > 0 || totals.costUsd > 0);
  });
  const toggle = (keys: readonly string[]) => {
    const current = new Set(accounts ?? all);
    const on = keys.every((key) => current.has(key));
    for (const key of keys) {
      if (on) current.delete(key);
      else current.add(key);
    }
    onAccountsChange([...current]);
  };
  const only = (keys: readonly string[]) => {
    const isOnly =
      accounts !== null && accounts.size === keys.length && keys.every((key) => accounts.has(key));
    onAccountsChange(isOnly ? null : keys);
  };
  const row = (
    keys: readonly string[],
    label: ReactNode,
    totals: UsageTotals,
    sub: ReactNode,
    nested: boolean,
  ) => {
    const on = keys.every(selected);
    const isOnly =
      accounts !== null && accounts.size === keys.length && keys.every((key) => accounts.has(key));
    return (
      <div
        className={cn(
          "group/provider relative flex flex-col gap-1",
          !on && "opacity-50",
          nested && "ps-5",
        )}
      >
        <input
          type="checkbox"
          className={cn(
            "absolute top-1 -left-5 size-3.5 opacity-0 group-hover/provider:opacity-100 focus-visible:opacity-100",
            accounts !== null && "opacity-100",
          )}
          checked={on}
          aria-label={`Include ${typeof label === "string" ? label : "this provider"}`}
          onChange={() => toggle(keys)}
        />
        <div className="flex items-baseline justify-between gap-4">
          <button
            type="button"
            className="flex min-w-0 items-center gap-2 text-left text-sm text-foreground"
            onClick={() => toggle(keys)}
            aria-pressed={on}
          >
            {label}
          </button>
          <span className="flex shrink-0 items-baseline gap-2">
            <span className="text-2xs opacity-0 group-focus-within/provider:opacity-100 group-hover/provider:opacity-100">
              <InlineButton tone="muted" onClick={() => only(keys)}>
                {isOnly ? "show all" : "only this"}
              </InlineButton>
            </span>
            <span className="text-sm font-medium text-foreground tabular-nums">
              {metric === "cost"
                ? isUnpriced(totals)
                  ? "Cost unknown"
                  : formatUsd(totals.costUsd)
                : formatTokens(tokensOf(totals))}
            </span>
          </span>
        </div>
        {sub}
      </div>
    );
  };
  return (
    <div className="flex flex-col gap-3">
      {providers.map((provider) => {
        const totals = byProvider.get(provider)!;
        const presentation = PROVIDER_PRESENTATION[provider];
        const keys = accountsOf.get(provider) ?? [];
        const shareValue = whole === 0 ? 0 : metricOf(totals, metric) / whole;
        const isExpanded = expanded.has(provider);
        return (
          <div key={provider} className="flex flex-col gap-1.5">
            {row(
              keys,
              <>
                <ProviderInstanceIcon
                  driverKind={presentation.driverKind}
                  displayName={presentation.label}
                  iconClassName="size-4"
                />
                <span className="truncate">{presentation.label}</span>
              </>,
              totals,
              <>
                <div aria-hidden className="h-0.5 rounded-full bg-muted">
                  <div
                    className="h-full rounded-full"
                    style={{ width: `${shareValue * 100}%`, backgroundColor: presentation.color }}
                  />
                </div>
                <span className="text-xs text-muted-foreground">
                  {formatShare(shareValue)} of {metric === "cost" ? "cost" : "tokens"} ·{" "}
                  {metric === "cost"
                    ? `${formatTokens(tokensOf(totals))} tokens`
                    : formatUsd(totals.costUsd)}
                  {keys.length > 1 ? (
                    <>
                      {" · "}
                      <InlineButton
                        tone="muted"
                        aria-expanded={isExpanded}
                        onClick={() =>
                          setExpanded((current) => {
                            const next = new Set(current);
                            if (next.has(provider)) next.delete(provider);
                            else next.add(provider);
                            return next;
                          })
                        }
                      >
                        {keys.length} accounts {isExpanded ? "▾" : "▸"}
                      </InlineButton>
                    </>
                  ) : null}
                </span>
              </>,
              false,
            )}
            {isExpanded
              ? keys
                  .toSorted(
                    (a, b) =>
                      metricOf(byAccount.get(b), metric) - metricOf(byAccount.get(a), metric),
                  )
                  .map((account) => (
                    <div key={account}>
                      {row(
                        [account],
                        <span className="truncate">{accountName(account)}</span>,
                        byAccount.get(account)!,
                        null,
                        true,
                      )}
                    </div>
                  ))
              : null}
          </div>
        );
      })}
    </div>
  );
}

function ColumnsMenu({
  columns,
  onChange,
  onDownload,
}: {
  readonly columns: readonly UsageColumnId[];
  readonly onChange: (columns: UsageColumnId[]) => void;
  readonly onDownload: () => void;
}) {
  return (
    <Menu>
      <MenuTrigger render={<Button size="compact" variant="outline" />}>
        <Columns3Icon aria-hidden />
        Columns
      </MenuTrigger>
      <MenuPopup align="end">
        {USAGE_COLUMNS.map((column) => (
          <MenuCheckboxItem
            key={column.id}
            checked={columns.includes(column.id)}
            closeOnClick={false}
            onCheckedChange={(checked) => {
              const next = new Set(columns);
              if (checked) next.add(column.id);
              else next.delete(column.id);
              onChange(USAGE_COLUMNS.map((entry) => entry.id).filter((id) => next.has(id)));
            }}
          >
            {column.label}
          </MenuCheckboxItem>
        ))}
        <MenuSeparator />
        <MenuItem onClick={() => onChange([...DEFAULT_COLUMNS])}>Reset to default</MenuItem>
        <MenuItem onClick={onDownload}>Download as CSV</MenuItem>
      </MenuPopup>
    </Menu>
  );
}

function ThreadFilters({
  facts,
  filters,
  accountName,
  onAccountsChange,
  onModelChange,
}: {
  readonly facts: readonly UsageFact[];
  readonly filters: UsageFilters;
  readonly accountName: (account: string) => string;
  readonly onAccountsChange: (accounts: readonly string[] | null) => void;
  readonly onModelChange: (model: string | null) => void;
}) {
  const accounts = [...new Set(facts.map((fact) => fact.account))];
  const models = [...foldFacts(facts, (fact) => modelKey(fact.provider, fact.model))]
    .sort((a, b) => b[1].costUsd - a[1].costUsd || tokensOf(b[1]) - tokensOf(a[1]))
    .map(([key]) => key);
  const selected = filters.accounts;
  const label =
    selected === null
      ? "All providers"
      : accounts.filter((account) => selected.has(account)).length === 1
        ? accountName(accounts.find((account) => selected.has(account))!)
        : `${accounts.filter((account) => selected.has(account)).length} providers`;
  return (
    <>
      <Menu>
        <MenuTrigger render={<Button size="compact" variant="outline" />}>
          {label}
          <ChevronDownIcon aria-hidden />
        </MenuTrigger>
        <MenuPopup align="end">
          {accounts.map((account) => (
            <MenuCheckboxItem
              key={account}
              checked={selected === null || selected.has(account)}
              closeOnClick={false}
              onCheckedChange={(checked) => {
                const next = new Set(selected ?? accounts);
                if (checked) next.add(account);
                else next.delete(account);
                onAccountsChange(next.size === accounts.length ? null : [...next]);
              }}
            >
              {accountName(account)}
            </MenuCheckboxItem>
          ))}
        </MenuPopup>
      </Menu>
      <Select
        value={filters.model ?? ""}
        onValueChange={(value) => onModelChange(value ? value : null)}
      >
        <SelectTrigger aria-label="Model" size="compact" className="w-auto min-w-0">
          <SelectValue>
            {filters.model === null ? "All models" : splitModelKey(filters.model).model}
          </SelectValue>
        </SelectTrigger>
        <SelectPopup align="end" alignItemWithTrigger={false}>
          <SelectItem value="">All models</SelectItem>
          {models.map((key) => (
            <SelectItem key={key} value={key}>
              {splitModelKey(key).model}
            </SelectItem>
          ))}
        </SelectPopup>
      </Select>
    </>
  );
}

/* -------------------------------------------------------------------------- */

function BreakdownTable({
  rows,
  dimension,
  columns,
  hasPrevious,
  metric,
  sort,
  onSort,
  rowName,
  threads,
  favorites,
  onToggleOpen,
  onToggleShowAll,
  onToggleHidden,
  onFocus,
  onMenu,
  onOpenThread,
  onOpenModel,
  onHoverRow,
  highlight,
  seriesOf,
}: {
  readonly rows: readonly BreakdownRow[];
  readonly dimension: UsageDimension;
  readonly columns: readonly UsageColumnId[];
  readonly hasPrevious: boolean;
  readonly metric: UsageExplorerMetric;
  readonly sort: UsageSort | null;
  readonly onSort: (column: UsageSort["column"]) => void;
  readonly rowName: (row: ItemRow) => string;
  readonly threads: UsageExplorerData;
  readonly favorites: ReadonlySet<string>;
  readonly onToggleOpen: (path: string) => void;
  readonly onToggleShowAll: (path: string) => void;
  readonly onToggleHidden: (keys: readonly string[]) => void;
  readonly onFocus: (
    dimension: BreakdownDimension,
    key: string,
    ancestors: ItemRow["ancestors"],
  ) => void;
  readonly onMenu: (row: ItemRow, position: { x: number; y: number }) => void;
  readonly onOpenThread: (key: string) => void;
  readonly onOpenModel: (modelKey: string) => void;
  readonly onHoverRow: (seriesKey: string | null) => void;
  readonly highlight: string | null;
  readonly seriesOf: (key: string) => string;
}) {
  const header = DIMENSIONS.find((entry) => entry.value === dimension)?.one ?? "";
  const sortMark = (column: UsageSort["column"]) =>
    sort?.column === column ? (sort.descending ? " ↓" : " ↑") : "";
  const span = columns.length + 1;
  return (
    <div className="overflow-x-auto" onMouseLeave={() => onHoverRow(null)}>
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border text-right text-xs text-muted-foreground">
            <th className="min-w-60 py-2 text-left font-normal">
              <button type="button" onClick={() => onSort("name")}>
                {header.charAt(0).toUpperCase() + header.slice(1)}
                {sortMark("name")}
              </button>
            </th>
            {columns.map((column) => (
              <th key={column} className="py-2 pl-6 font-normal whitespace-nowrap">
                <Hint
                  text={
                    column === "share"
                      ? `Share of ${metric === "cost" ? "cost" : "tokens"}; nested rows are a share of the row they sit under`
                      : (USAGE_COLUMNS.find((entry) => entry.id === column)?.description ?? null)
                  }
                >
                  <button type="button" onClick={() => onSort(column)}>
                    {USAGE_COLUMNS.find((entry) => entry.id === column)?.label}
                    {sortMark(column)}
                  </button>
                </Hint>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td colSpan={span} className="py-6 text-center text-muted-foreground">
                No activity in this range.
              </td>
            </tr>
          ) : (
            rows.map((row) => {
              const indent = { paddingInlineStart: `${row.depth * 1.25}rem` };
              if (row.kind === "more" || row.kind === "fewer") {
                return (
                  <tr key={row.path}>
                    <td colSpan={span} className="py-1.5" style={indent}>
                      <span className="ms-6 text-xs">
                        <InlineButton tone="muted" onClick={() => onToggleShowAll(row.target)}>
                          {row.kind === "more"
                            ? `Show ${formatCount(row.hiddenCount)} more ${row.noun} · ${formatShare(row.hiddenShare)}`
                            : "Show fewer"}
                        </InlineButton>
                      </span>
                    </td>
                  </tr>
                );
              }
              if (row.kind === "leaf") {
                return (
                  <tr
                    key={row.path}
                    className="border-b border-border/40 text-right text-muted-foreground tabular-nums"
                  >
                    <td className="py-2 text-left" style={indent}>
                      <span className="ms-6 italic">{row.label}</span>
                    </td>
                    <MetricCells
                      columns={columns}
                      totals={row.totals}
                      share={row.share}
                      shareOf={row.shareOf}
                      metric={metric}
                      hasPrevious={false}
                    />
                  </tr>
                );
              }
              if (row.kind === "other") {
                return (
                  <tr
                    key={row.path}
                    className={cn(
                      "cursor-pointer border-b border-border/50 text-right text-muted-foreground tabular-nums hover:bg-muted/50",
                      highlight === OTHER_SERIES && "bg-muted/50",
                    )}
                    onClick={(event) => {
                      // The swatch toggles chart visibility; it must not also expand the row.
                      if ((event.target as HTMLElement).closest("button, a, input")) return;
                      onToggleOpen(row.path);
                    }}
                    onMouseEnter={() => onHoverRow(OTHER_SERIES)}
                    onMouseLeave={() => onHoverRow(null)}
                  >
                    <td className="py-2.5 text-left">
                      <span className="flex items-center gap-2">
                        <Disclosure
                          open={row.open}
                          label="Other"
                          onToggle={() => onToggleOpen(row.path)}
                        />
                        <Swatch
                          color="var(--muted-foreground)"
                          hidden={row.hidden}
                          label="Other"
                          onToggle={() => onToggleHidden(row.members)}
                        />
                        <span className="text-foreground">
                          Other · {formatCount(row.members.length)}
                        </span>
                      </span>
                    </td>
                    <MetricCells
                      columns={columns}
                      totals={row.totals}
                      share={row.share}
                      shareOf="the total"
                      metric={metric}
                      hasPrevious={false}
                    />
                  </tr>
                );
              }
              const name = rowName(row);
              const info =
                row.dimension === "thread" ? threads.threads.info.get(row.key) : undefined;
              const series = row.color === null ? null : seriesOf(row.key);
              return (
                <tr
                  key={row.path}
                  className={cn(
                    "group/row border-b border-border/50 text-right text-muted-foreground tabular-nums transition-colors hover:bg-muted/50",
                    row.expandable && "cursor-pointer",
                    series !== null && highlight === series && "bg-muted/50",
                    row.hidden && "opacity-50",
                  )}
                  onClick={(event) => {
                    if ((event.target as HTMLElement).closest("button, a, input")) return;
                    if (row.expandable) onToggleOpen(row.path);
                  }}
                  onContextMenu={(event) => {
                    event.preventDefault();
                    onMenu(row, { x: event.clientX, y: event.clientY });
                  }}
                  onMouseEnter={() => onHoverRow(series)}
                  onMouseLeave={() => onHoverRow(null)}
                >
                  <td className="py-2.5 text-left" style={indent}>
                    <span className="flex min-w-0 items-center gap-2">
                      {row.expandable ? (
                        <Disclosure
                          open={row.open}
                          label={name}
                          onToggle={() => onToggleOpen(row.path)}
                        />
                      ) : (
                        <span className="w-4 shrink-0" />
                      )}
                      {row.color === null ? null : (
                        <Swatch
                          color={row.color}
                          hidden={row.hidden}
                          label={name}
                          onToggle={() => onToggleHidden([row.key])}
                        />
                      )}
                      {row.dimension === "provider" ? (
                        <ProviderInstanceIcon
                          driverKind={
                            PROVIDER_PRESENTATION[row.key as UsageProviderKind].driverKind
                          }
                          displayName={name}
                          iconClassName="size-3.5"
                        />
                      ) : row.dimension === "thread" && info?.provider ? (
                        <ProviderInstanceIcon
                          driverKind={PROVIDER_PRESENTATION[info.provider].driverKind}
                          displayName={PROVIDER_PRESENTATION[info.provider].label}
                          iconClassName="size-3"
                        />
                      ) : null}
                      {row.dimension === "model" ? (
                        // A model's name opens its detail, as the row's own click expands it.
                        <button
                          type="button"
                          className="min-w-0 truncate text-left text-foreground underline-offset-2 hover:underline"
                          onClick={() => onOpenModel(row.key)}
                        >
                          {name}
                        </button>
                      ) : (
                        <span className="min-w-0 truncate text-foreground">
                          {row.dimension === "project" && favorites.has(row.key) ? "★ " : ""}
                          {name}
                        </span>
                      )}
                      {row.subagents > 0 ? (
                        <Tag
                          hint={
                            row.allSubagents > row.subagents
                              ? `${formatCount(row.allSubagents)} counting their own sub-agents`
                              : null
                          }
                        >
                          {row.subagents} {row.subagents === 1 ? "sub-agent" : "sub-agents"}
                        </Tag>
                      ) : null}
                      {row.cacheHeavy ? (
                        <Tag
                          warn
                          hint="At least half of this thread's own cost went to writing the prompt cache, against about a third for a typical thread. The cache is rewritten when it expires between turns, when history is compacted, or when the model or tools change."
                        >
                          cache-heavy
                        </Tag>
                      ) : null}
                      {info?.agent && row.depth === 0 ? <Tag>sub-agent</Tag> : null}
                      {info?.t3 ? (
                        <span className="shrink-0 text-xs opacity-0 group-focus-within/row:opacity-100 group-hover/row:opacity-100 pointer-coarse:opacity-100">
                          <InlineButton tone="muted" onClick={() => onOpenThread(row.key)}>
                            Open
                          </InlineButton>
                        </span>
                      ) : null}
                      {row.dimension !== "thread" &&
                      !(
                        row.dimension === "project" &&
                        (row.key === OUTSIDE_PROJECTS || row.key === UNKNOWN_PROJECT) &&
                        !threads.hasThreads
                      ) ? (
                        <span className="ms-auto flex shrink-0 gap-3 text-xs opacity-0 group-focus-within/row:opacity-100 group-hover/row:opacity-100 pointer-coarse:opacity-100">
                          {row.dimension === "model" ? (
                            <InlineButton tone="muted" onClick={() => onOpenModel(row.key)}>
                              Details
                            </InlineButton>
                          ) : null}
                          <InlineButton
                            tone="muted"
                            onClick={() => onFocus(row.dimension, row.key, row.ancestors)}
                          >
                            Focus →
                          </InlineButton>
                        </span>
                      ) : null}
                    </span>
                  </td>
                  <MetricCells
                    columns={columns}
                    totals={row.totals}
                    share={row.share}
                    shareOf={row.shareOf}
                    metric={metric}
                    hasPrevious={hasPrevious && row.depth === 0}
                    previous={row.previous}
                  />
                </tr>
              );
            })
          )}
        </tbody>
      </table>
    </div>
  );
}

function MetricCells({
  columns,
  totals,
  share,
  shareOf,
  metric,
  hasPrevious,
  previous,
}: {
  readonly columns: readonly UsageColumnId[];
  readonly totals: UsageTotals;
  readonly share: number;
  readonly shareOf: string;
  readonly metric: UsageExplorerMetric;
  readonly hasPrevious: boolean;
  readonly previous?: UsageTotals | undefined;
}) {
  const unpriced = isUnpriced(totals);
  const format = metric === "cost" ? formatUsd : formatTokens;
  return (
    <>
      {columns.map((column) => {
        const cell = (content: ReactNode, hint?: string, strong = false) => (
          <td
            key={column}
            className={cn("py-2.5 pl-6 whitespace-nowrap", strong && "text-foreground")}
          >
            {hint === undefined ? content : <Hint text={hint}>{content}</Hint>}
          </td>
        );
        switch (column) {
          case "cost":
            return unpriced ? cell("Unpriced") : cell(formatUsd(totals.costUsd), undefined, true);
          case "share":
            return metric === "cost" && unpriced
              ? cell("–")
              : cell(formatShare(share), `${formatShare(share)} of ${shareOf}`);
          case "tokens":
            return cell(formatTokens(tokensOf(totals)));
          case "input":
            return cell(formatTokens(totals.input));
          case "output":
            return cell(formatTokens(totals.output));
          case "cacheRead":
            return cell(formatTokens(totals.cacheRead));
          case "cacheWrite":
            return cell(formatTokens(totals.cacheWrite));
          case "cacheWriteCost":
            return totals.costUsd > 0
              ? cell(
                  formatUsd(totals.cacheWriteUsd),
                  `${formatShare(totals.cacheWriteUsd / totals.costUsd, 0)} of this row's cost`,
                )
              : cell("–");
          case "cached": {
            const value = cachedShare(totals);
            return cell(value === null ? "–" : formatShare(value, 0));
          }
          case "change": {
            if (!hasPrevious) return cell("");
            const was = metricOf(previous, metric);
            const now = metricOf(totals, metric);
            const delta = now - was;
            return cell(
              was === 0 ? "new" : `${delta >= 0 ? "+" : "−"}${format(Math.abs(delta))}`,
              was === 0
                ? "Nothing in the same length of time before"
                : `Was ${format(was)}, ${delta >= 0 ? "up" : "down"} ${formatShare(Math.abs(delta) / was, 0)}`,
            );
          }
        }
      })}
    </>
  );
}

function Disclosure({
  open,
  label,
  onToggle,
}: {
  readonly open: boolean;
  readonly label: string;
  readonly onToggle?: () => void;
}) {
  return (
    <button
      type="button"
      className="flex size-4 shrink-0 items-center justify-center text-muted-foreground"
      aria-expanded={open}
      aria-label={`${open ? "Collapse" : "Expand"} ${label}`}
      onClick={onToggle}
    >
      {open ? (
        <ChevronDownIcon className="size-3.5" aria-hidden />
      ) : (
        <ChevronRightIcon className="size-3.5" aria-hidden />
      )}
    </button>
  );
}

/** The row's chart colour. Clicking hides or shows its series; hidden shows as an outline. */
function Swatch({
  color,
  hidden,
  label,
  onToggle,
}: {
  readonly color: string;
  readonly hidden: boolean;
  readonly label: string;
  readonly onToggle: () => void;
}) {
  return (
    <button
      type="button"
      className="size-2.5 shrink-0 rounded-xs border"
      style={{ backgroundColor: hidden ? "transparent" : color, borderColor: color }}
      aria-pressed={!hidden}
      aria-label={`${hidden ? "Show" : "Hide"} ${label} on the chart`}
      onClick={onToggle}
    />
  );
}

function Tag({
  children,
  hint = null,
  warn = false,
}: {
  readonly children: ReactNode;
  readonly hint?: string | null;
  readonly warn?: boolean;
}) {
  return (
    <Hint text={hint}>
      <span
        className={cn(
          "shrink-0 rounded-sm border px-1 text-2xs",
          warn
            ? "border-warning/50 text-warning-foreground"
            : "border-border text-muted-foreground",
        )}
      >
        {children}
      </span>
    </Hint>
  );
}

/** A tooltip on hover or focus; plain content when there is nothing to say. */
function Hint({ text, children }: { readonly text: string | null; readonly children: ReactNode }) {
  if (text === null) return children;
  return (
    <Tooltip>
      <TooltipTrigger render={<span className="cursor-default" />}>{children}</TooltipTrigger>
      <TooltipPopup className="max-w-72">{text}</TooltipPopup>
    </Tooltip>
  );
}
