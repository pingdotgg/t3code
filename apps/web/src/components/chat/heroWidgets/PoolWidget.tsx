import { useAtomValue } from "@effect/atom-react";
import { isProviderAvailable, type UsageProviderKind } from "@t3tools/contracts";
import {
  collectLimitAccounts,
  collectLimitPools,
  type LimitAccount,
  type LimitPresentations,
} from "@t3tools/shared/usageLimits";
import type { DailyTotals } from "@t3tools/shared/usageMerge";
import { GaugeIcon } from "lucide-react";
import { useRef, useState, type CSSProperties, type ReactNode } from "react";

import { cn } from "~/lib/utils";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../../ui/tooltip";
import { environmentPresentations } from "../../../state/presentation";
import { PROVIDER_PRESENTATION } from "../../usage/usageProviders";
import { DitherCanvas, type ResolveColor } from "./DitherCanvas";
import { bayer, drawDottedLine } from "./dither";
import {
  addLocalDays,
  appendPoolSample,
  DAY_MS,
  estimateBurn,
  HOUR_MS,
  type Burn,
  type DrySpan,
  type PoolProjection,
  type PoolProvider,
  type ProviderDrySpan,
  type PoolSample,
  poolProviders,
  type RefillEvent,
  projectedAccountAt,
  projectedAt,
  projectPool,
  recordedSince,
  sampleAt,
  startOfLocalDay,
} from "./heroWidgets.logic";
import {
  readStored,
  useDebugValue,
  useElementSize,
  WidgetCard,
  WEEKDAY_TIME,
  writeStored,
} from "./widgetChrome";

const DRIVER_ORDER = [
  "codex",
  "claudeAgent",
  "cursor",
  "grok",
  "antigravity",
  "opencode",
  "pi",
  "muse",
];
const POOL_COLORS: Record<string, string> = {
  codex: "#6f8fff",
  claudeAgent: "#d97757",
  cursor: "#a98bf5",
  grok: "#c58af0",
  antigravity: "#8c7bd1",
  opencode: "#5b9bbd",
  pi: "#4d9f8a",
  muse: "#7f6df2",
};
const POOL_LABELS: Record<string, string> = {
  codex: "Codex",
  claudeAgent: "Claude",
  cursor: "Cursor",
  grok: "Grok",
  antigravity: "Antigravity",
  opencode: "OpenCode",
  pi: "Pi",
  muse: "Muse",
};
const USAGE_KIND_BY_DRIVER = new Map<string, UsageProviderKind>(
  Object.entries(PROVIDER_PRESENTATION).map(([kind, presentation]) => [
    String(presentation.driverKind),
    kind as UsageProviderKind,
  ]),
);

const poolColor = (driver: string) => POOL_COLORS[driver] ?? "#9b87f5";
const poolLabel = (driver: string) => POOL_LABELS[driver] ?? driver;
const driverRank = (driver: string) => DRIVER_ORDER.indexOf(driver) + 1 || 99;

/** Dry time and every runout in this widget: a red apart from Claude's orange. */
const ROSE = "#ff6b81";
const SPENT = "color-mix(in oklab, var(--foreground) 4.5%, transparent)";
/** Empty pip cells sit a little brighter than the chart's spent area so a dry account still shows. */
const PIP_EMPTY = "color-mix(in oklab, var(--foreground) 18%, transparent)";
const BASELINE = "color-mix(in oklab, var(--foreground) 14%, transparent)";
const NOW_LINE = "color-mix(in oklab, var(--foreground) 55%, transparent)";

const SAMPLES_KEY = "t3code:hero-widgets:pool-samples:v1";
const FORECAST_MS = 7 * DAY_MS;
const MAX_PAST_MS = DAY_MS;
/** Recorded history counts as unbroken while samples are at most this far apart. */
const SAMPLE_GAP_MS = 3 * HOUR_MS;
/** Below this card width the rail folds into one legend line under the chart. */
const NARROW_CARD = 760;
const CARD_PADDING = 32;
/** Refills smaller than this many points still step the chart but get no tag or headline. */
const MIN_REFILL = 5;
/** Points closer than this to the first one in a group share its tag. */
const TAG_MERGE_PX = 44;
const TAG_HEIGHT = 14;
const TAG_GAP = 4;
/** Clear space kept between neighbouring tags, and right of the NOW label. */
const TAG_SPACING = 4;
const NOW_LABEL_PX = 24;
const POOL_DRY_LABEL_MIN_PX = 72;
const PIPS_PER_ROW = 8;
const PIP_GAP = 3;
/** The rail's gap plus one text-xs line, for the "No limits" line. */
const NO_LIMITS_PX = 28;
/** Room a weekday label needs under the chart. */
const DAY_LABEL_PX = 24;

const CELL = 3;
/** Room above the full pool for NOW and refill tags. */
const TOP_GUTTER = 20;
/** Under the baseline: a gap, the 4px dry strip, a gap. */
const UNDER_BASELINE = 8;
const PAST_DENSITY = 0.85;
const FORECAST_DENSITY = { start: 0.65, end: 0.3 } as const;

const WEEKDAY_HOUR = new Intl.DateTimeFormat("en-US", { weekday: "short", hour: "numeric" });

function accountName(account: LimitAccount): string {
  if (account.displayName) return account.displayName;
  if (account.email) {
    const [local = "", domain = ""] = account.email.split("@");
    return `${local[0] ?? ""}${domain[0] ?? ""}`.toUpperCase();
  }
  return poolLabel(String(account.driver));
}

function formatPercent(value: number): string {
  return `${Math.round(value)}%`;
}

function formatRate(perDay: number): string {
  return perDay < 1 ? `${perDay.toFixed(1)}%` : `${Math.round(perDay)}%`;
}

/** Forecasts are not minute-precise, so they read to the nearest hour. */
function formatForecast(t: number): string {
  const date = new Date(t + 30 * 60 * 1000);
  date.setMinutes(0, 0, 0);
  return WEEKDAY_HOUR.format(date);
}

/** Resets are exact; minutes show unless they are zero. */
function formatReset(t: number): string {
  return new Date(t).getMinutes() === 0 ? WEEKDAY_HOUR.format(t) : WEEKDAY_TIME.format(t);
}

function formatSpan(ms: number): string {
  const hours = ms / HOUR_MS;
  if (hours < 1) return "<1h";
  if (hours < 36) return `${Math.round(hours)}h`;
  return `${Math.round(hours / 24)}d`;
}

interface PoolModel {
  /** Stack order, bottom first: the slowest burn sits at the bottom. */
  readonly providers: ReadonlyArray<PoolProvider>;
  readonly burns: ReadonlyMap<string, Burn>;
  readonly projection: PoolProjection;
  readonly capacity: number;
  readonly left: number;
  readonly start: number;
  readonly end: number;
  readonly now: number;
  readonly samples: ReadonlyArray<PoolSample>;
}

type ProviderStatus =
  | { readonly kind: "lasts" }
  | { readonly kind: "out"; readonly at: number }
  | { readonly kind: "empty"; readonly until: number | null };

function providerStatus(model: PoolModel, driver: string): ProviderStatus {
  const span = model.projection.dry.find(
    (entry) => entry.driver === driver && entry.from < model.end,
  );
  if (!span) return { kind: "lasts" };
  return span.from <= model.now
    ? { kind: "empty", until: span.to }
    : { kind: "out", at: span.from };
}

let poolSamples: ReadonlyArray<PoolSample> = readStored<PoolSample[]>(SAMPLES_KEY, []);

/** Adds the live pool to the client-side history the chart's past is drawn from. */
function recordPoolSample(providers: ReadonlyArray<PoolProvider>, now: number) {
  if (providers.length === 0) return poolSamples;
  const next = appendPoolSample(poolSamples, {
    t: now,
    p: Object.fromEntries(
      providers.map((provider) => [
        provider.driver,
        [Math.round(provider.left * 10) / 10, provider.capacity] as const,
      ]),
    ),
    a: Object.fromEntries(
      providers.flatMap((provider) =>
        provider.accounts.map((account) => [account.key, Math.round(account.left * 10) / 10]),
      ),
    ),
  });
  if (next !== poolSamples) {
    poolSamples = next;
    writeStored(SAMPLES_KEY, next);
  }
  return poolSamples;
}

/** Signed-in providers that report no subscription limits at all. */
function driversWithoutLimits(
  presentations: LimitPresentations,
  providers: ReadonlyArray<PoolProvider>,
): ReadonlyArray<string> {
  const drivers = new Set<string>();
  for (const presentation of presentations.values()) {
    for (const provider of presentation.serverConfig?.providers ?? []) {
      if (
        provider.enabled &&
        provider.installed &&
        isProviderAvailable(provider) &&
        provider.auth.status === "authenticated"
      ) {
        drivers.add(String(provider.driver));
      }
    }
  }
  return [...drivers]
    .filter((driver) => !providers.some((provider) => provider.driver === driver))
    .toSorted((left, right) => driverRank(left) - driverRank(right));
}

export function PoolWidget({
  now,
  daily,
}: {
  readonly now: number;
  readonly daily: ReadonlyArray<DailyTotals>;
}) {
  const presentations = useAtomValue(environmentPresentations.presentationsWithProvidersAtom);
  const pools = collectLimitPools(collectLimitAccounts(presentations), now);
  const unsorted = poolProviders(pools, accountName);
  const samples = recordPoolSample(unsorted, now);

  const tokensByDriver = new Map<string, Map<string, number>>();
  for (const provider of unsorted) {
    const kind = USAGE_KIND_BY_DRIVER.get(provider.driver);
    tokensByDriver.set(
      provider.driver,
      new Map(
        daily.map((day) => [day.day, kind ? (day.byProvider.get(kind)?.totalTokens ?? 0) : 0]),
      ),
    );
  }
  const burns = new Map(
    unsorted.map((provider) => [
      provider.driver,
      estimateBurn(provider, tokensByDriver.get(provider.driver)!, now),
    ]),
  );
  // The fastest burn rides on top, so the band that moves is the one that leaves the silhouette.
  const providers = unsorted.toSorted(
    (left, right) =>
      (burns.get(left.driver)?.perHour ?? 0) - (burns.get(right.driver)?.perHour ?? 0) ||
      driverRank(left.driver) - driverRank(right.driver),
  );
  const start = recordedSince(samples, now, SAMPLE_GAP_MS, MAX_PAST_MS);
  const end = now + FORECAST_MS;
  const projection = projectPool(
    providers,
    new Map([...burns].map(([driver, burn]) => [driver, burn.perHour])),
    now,
    end + FORECAST_MS,
  );
  const model: PoolModel = {
    providers,
    burns,
    projection,
    capacity: providers.reduce((sum, provider) => sum + provider.capacity, 0),
    left: providers.reduce((sum, provider) => sum + provider.left, 0),
    start,
    end,
    now,
    samples,
  };
  const noLimits = driversWithoutLimits(presentations, providers);

  const nextRefill = projection.refills.find(
    (refill) => refill.at > now && refill.amount >= MIN_REFILL,
  );
  const status = headerStatus(model, nextRefill);
  useDebugValue("pool", {
    providers,
    burns: Object.fromEntries(burns),
    dry: projection.dry,
    poolDry: projection.poolDry,
    refills: projection.refills.slice(0, 6),
    samples: samples.length,
    noLimits,
    start,
    end,
  });

  return (
    <WidgetCard
      id="pool"
      icon={GaugeIcon}
      title="Pool"
      meta={
        status?.dry ? <span style={{ color: ROSE }}>{status.text}</span> : (status?.text ?? null)
      }
    >
      {providers.length === 0 ? (
        <p className="mt-3 text-xs text-muted-foreground">
          No provider reports subscription limits yet.
        </p>
      ) : (
        <PoolBody model={model} noLimits={noLimits} nextRefill={nextRefill} />
      )}
    </WidgetCard>
  );
}

/**
 * The whole pool running dry outranks any one provider; a provider empty now outranks one that
 * runs out later. "until" is left out when the next refill already names that time.
 */
function headerStatus(
  model: PoolModel,
  nextRefill: RefillEvent | undefined,
): { readonly text: string; readonly dry: boolean } | null {
  if (model.providers.length === 0) return null;
  const emptyText = (label: string, until: number | null, refillsThen: boolean) =>
    until !== null && refillsThen
      ? `${label} empty now`
      : `${label} empty until ${until === null ? "next week" : formatReset(until)}`;
  const poolDry = model.projection.poolDry.find(
    (span) => span.from < model.end && (span.to === null || span.to > model.now),
  );
  if (poolDry) {
    return {
      dry: true,
      text:
        poolDry.from <= model.now
          ? emptyText("Pool", poolDry.to, nextRefill?.at === poolDry.to)
          : `Pool runs out ${formatForecast(poolDry.from)}`,
    };
  }
  const emptyNow = model.projection.dry.find((span) => span.from <= model.now);
  if (emptyNow) {
    return {
      dry: true,
      text: emptyText(
        poolLabel(emptyNow.driver),
        emptyNow.to,
        nextRefill?.driver === emptyNow.driver && nextRefill.at === emptyNow.to,
      ),
    };
  }
  const runsOut = model.projection.dry.find(
    (span) => span.from > model.now && span.from < model.end,
  );
  return runsOut
    ? { dry: true, text: `${poolLabel(runsOut.driver)} runs out ${formatForecast(runsOut.from)}` }
    : { dry: false, text: "Lasts the week" };
}

function PoolBody({
  model,
  noLimits,
  nextRefill,
}: {
  readonly model: PoolModel;
  readonly noLimits: ReadonlyArray<string>;
  readonly nextRefill: RefillEvent | undefined;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const { width } = useElementSize(ref);
  const narrow = width > 0 && width + CARD_PADDING < NARROW_CARD;
  const accounts = model.providers.reduce((sum, provider) => sum + provider.accounts.length, 0);
  // Top of the stack first, as the bands read from the top down.
  const listed = model.providers.toReversed();

  return (
    <div ref={ref} className="mt-2.5 flex min-h-0 flex-1 flex-col">
      <div className="flex items-baseline gap-2 leading-none whitespace-nowrap">
        <span className="text-3xl font-semibold tracking-tight tabular-nums">
          {formatPercent(model.left)}
        </span>
        <span className="truncate text-sm text-muted-foreground">
          left of {formatPercent(model.capacity)} · {accounts} account{accounts === 1 ? "" : "s"}
        </span>
        {nextRefill ? (
          <span className="ms-auto inline-flex min-w-0 items-baseline gap-1.5 ps-4 text-sm tabular-nums">
            {narrow ? null : (
              <span className="shrink-0 text-3xs tracking-wider text-muted-foreground uppercase">
                Next refill
              </span>
            )}
            <Chip driver={nextRefill.driver} className="ms-1" />
            <span className="shrink-0 font-medium">+{formatPercent(nextRefill.amount)}</span>
            <span className="flex min-w-0 text-muted-foreground">
              <span className="truncate">{poolLabel(nextRefill.driver)}</span>
              <span className="shrink-0 whitespace-pre"> · {formatReset(nextRefill.at)}</span>
            </span>
          </span>
        ) : null}
      </div>
      <div className="mt-3 flex min-h-0 flex-1 gap-6">
        <div className="flex min-w-0 flex-1 flex-col">
          <PoolChart model={model} />
          {narrow ? (
            <div className="mt-2 flex items-center gap-x-4 overflow-hidden text-xs whitespace-nowrap tabular-nums">
              {listed.map((provider) => {
                const status = providerStatus(model, provider.driver);
                return (
                  <span key={provider.driver} className="inline-flex items-center gap-1.5">
                    <Hint
                      content={<ProviderHint model={model} provider={provider} />}
                      className="inline-flex items-baseline gap-1.5"
                    >
                      <Chip driver={provider.driver} className="self-center" />
                      <span>{poolLabel(provider.driver)}</span>
                      <Capacity provider={provider} />
                    </Hint>
                    <Pips provider={provider} wrap={false} />
                    {status.kind === "lasts" ? null : <StatusText status={status} />}
                  </span>
                );
              })}
            </div>
          ) : null}
        </div>
        {narrow ? null : <Rail model={model} listed={listed} noLimits={noLimits} />}
      </div>
    </div>
  );
}

function Rail({
  model,
  listed,
  noLimits,
}: {
  readonly model: PoolModel;
  readonly listed: ReadonlyArray<PoolProvider>;
  readonly noLimits: ReadonlyArray<string>;
}) {
  const railRef = useRef<HTMLDivElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const rail = useElementSize(railRef);
  const list = useElementSize(listRef);
  const showNoLimits = noLimits.length > 0 && list.height + NO_LIMITS_PX <= rail.height;
  return (
    <div
      ref={railRef}
      className="flex w-48 shrink-0 flex-col justify-center-safe gap-3 overflow-hidden text-xs tabular-nums"
    >
      <div ref={listRef} className="flex flex-col gap-3">
        {listed.map((provider) => (
          <div key={provider.driver} className="flex flex-col gap-1.5">
            <Hint
              content={<ProviderHint model={model} provider={provider} />}
              className="flex items-baseline gap-1.5"
            >
              <Chip driver={provider.driver} className="self-center" />
              <span>{poolLabel(provider.driver)}</span>
              <Capacity provider={provider} className="ms-auto" />
            </Hint>
            <div className="flex items-start gap-3">
              <Pips provider={provider} wrap />
              <StatusText
                status={providerStatus(model, provider.driver)}
                className="ms-auto shrink-0 leading-4.5"
              />
            </div>
          </div>
        ))}
      </div>
      {showNoLimits ? (
        <div className="truncate text-muted-foreground">
          No limits: {noLimits.map(poolLabel).join(", ")}
        </div>
      ) : null}
    </div>
  );
}

/** Percent left over capacity, the same in the rail and the narrow legend. */
function Capacity({
  provider,
  className,
}: {
  readonly provider: PoolProvider;
  readonly className?: string;
}) {
  return (
    <span className={className}>
      <span className="font-semibold">{Math.round(provider.left)}</span>
      <span className="text-muted-foreground">/{provider.capacity}%</span>
    </span>
  );
}

function Hint({
  content,
  className,
  children,
}: {
  readonly content: ReactNode;
  readonly className?: string;
  readonly children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger render={<span className={className} />}>{children}</TooltipTrigger>
      <TooltipPopup side="top">{content}</TooltipPopup>
    </Tooltip>
  );
}

function ProviderHint({
  model,
  provider,
}: {
  readonly model: PoolModel;
  readonly provider: PoolProvider;
}) {
  const burn = model.burns.get(provider.driver);
  return (
    <div className="tabular-nums">
      <div>
        {poolLabel(provider.driver)} {provider.windowLabel.toLowerCase()}:{" "}
        {formatPercent(provider.left)} left of {formatPercent(provider.capacity)}
      </div>
      <div className="text-muted-foreground">
        {burn && burn.perHour > 0
          ? `Burning about ${formatRate(burn.perHour * 24)} a day, ${
              burn.source === "tokens"
                ? "from the last 3 days of tokens"
                : "from the average since the window opened"
            }`
          : "No burn measured"}
      </div>
    </div>
  );
}

function Chip({ driver, className }: { readonly driver: string; readonly className?: string }) {
  return (
    <span
      aria-hidden
      className={cn("inline-block size-2 shrink-0 rounded-xs", className)}
      style={{ background: poolColor(driver) }}
    />
  );
}

function StatusText({
  status,
  className,
}: {
  readonly status: ProviderStatus;
  readonly className?: string;
}) {
  if (status.kind === "lasts") {
    return <span className={cn("text-muted-foreground", className)}>lasts</span>;
  }
  return (
    <span className={className} style={{ color: ROSE }}>
      {status.kind === "out"
        ? `out ${formatForecast(status.at)}`
        : status.until === null
          ? "empty"
          : `back ${formatReset(status.until)}`}
    </span>
  );
}

/** One dithered mini bar per account, filled to the percent it has left; none for a lone account. */
function Pips({ provider, wrap }: { readonly provider: PoolProvider; readonly wrap: boolean }) {
  if (provider.accounts.length < 2) return null;
  return (
    <span
      className={cn("flex", wrap ? "flex-wrap" : "shrink-0")}
      style={{
        gap: PIP_GAP,
        maxWidth: wrap ? PIPS_PER_ROW * (3 * CELL + PIP_GAP) - PIP_GAP : undefined,
      }}
    >
      {provider.accounts.map((account) => (
        <Hint
          key={account.key}
          className="block"
          content={`${account.name}: ${formatPercent(account.left)} left${
            account.resetsAt === null ? "" : `, resets ${formatReset(account.resetsAt)}`
          }`}
        >
          <DitherCanvas
            className="h-[18px] w-[9px]"
            draw={(context, size, color) =>
              drawPip(context, size, color, account.left, provider.driver)
            }
          />
        </Hint>
      ))}
    </span>
  );
}

function drawPip(
  context: CanvasRenderingContext2D,
  { width, height }: { readonly width: number; readonly height: number },
  color: ResolveColor,
  left: number,
  driver: string,
) {
  const columns = Math.floor((width + 1) / CELL);
  const rows = Math.floor((height + 1) / CELL);
  const lit = (Math.max(0, Math.min(100, left)) / 100) * rows;
  const full = Math.floor(lit);
  const fill = color(poolColor(driver));
  const crest = color(`color-mix(in oklab, ${poolColor(driver)} 70%, white)`);
  const spent = color(PIP_EMPTY);
  for (let row = 0; row < rows; row += 1) {
    const fromBottom = rows - 1 - row;
    for (let column = 0; column < columns; column += 1) {
      const on = fromBottom < full || (fromBottom === full && lit - full > bayer(column, row));
      context.fillStyle = !on ? spent : fromBottom >= Math.ceil(lit) - 1 ? crest : fill;
      context.fillRect(column * CELL, row * CELL, CELL - 1, CELL - 1);
    }
  }
}

/** Percent left per provider at `t`, in stack order: recorded samples before now, the forecast after. */
function valuesAt(model: PoolModel, t: number): ReadonlyArray<number> {
  if (t < model.now) {
    const sample = sampleAt(model.samples, t, SAMPLE_GAP_MS);
    if (sample) return model.providers.map((provider) => sample.p[provider.driver]?.[0] ?? 0);
  }
  return model.providers.map(
    (provider) =>
      projectedAt(model.projection, provider.driver, Math.max(t, model.now)) ?? provider.left,
  );
}

/** Percent left per account at `t`; null where the recorded sample predates per-account history. */
function accountValuesAt(
  model: PoolModel,
  provider: PoolProvider,
  t: number,
): ReadonlyArray<number | null> {
  if (t < model.now) {
    const sample = sampleAt(model.samples, t, SAMPLE_GAP_MS);
    return provider.accounts.map((account) => sample?.a?.[account.key] ?? null);
  }
  return provider.accounts.map(
    (account) => projectedAccountAt(model.projection, account.key, t) ?? account.left,
  );
}

interface ChartGeometry {
  readonly rows: number;
  readonly columns: number;
  readonly plotTop: number;
  readonly baseline: number;
  readonly xOf: (t: number) => number;
  /** Top edge of the cell row a stacked value reaches, so overlays line up with the cells. */
  readonly yOf: (value: number) => number;
  readonly rowOf: (value: number) => number;
}

function chartGeometry(width: number, height: number, model: PoolModel): ChartGeometry {
  const rows = Math.max(1, Math.floor((height - TOP_GUTTER - UNDER_BASELINE) / CELL));
  const baseline = height - UNDER_BASELINE;
  const plotTop = baseline - rows * CELL;
  const span = model.end - model.start;
  const scale = Math.max(1, model.capacity);
  const rowOf = (value: number) =>
    rows - Math.round((Math.min(scale, Math.max(0, value)) / scale) * rows);
  return {
    rows,
    columns: Math.floor(width / CELL),
    plotTop,
    baseline,
    xOf: (t) => ((t - model.start) / span) * width,
    yOf: (value) => plotTop + rowOf(value) * CELL,
    rowOf,
  };
}

interface DayLabel {
  readonly key: string;
  readonly label: string;
  readonly x: number;
  readonly today: boolean;
}

/** One label per day at noon; a partial day at either edge is labelled mid-way when wide enough. */
function dayLabels(model: PoolModel, geometry: ChartGeometry, width: number): DayLabel[] {
  const labels: DayLabel[] = [];
  const today = startOfLocalDay(new Date(model.now)).getTime();
  for (
    let day = startOfLocalDay(new Date(model.start));
    day.getTime() < model.end;
    day = addLocalDays(day, 1)
  ) {
    const from = Math.max(day.getTime(), model.start);
    const to = Math.min(addLocalDays(day, 1).getTime(), model.end);
    const noon = day.getTime() + DAY_MS / 2;
    let x: number;
    if (noon >= model.start && noon <= model.end) x = geometry.xOf(noon);
    else if (geometry.xOf(to) - geometry.xOf(from) >= DAY_LABEL_PX) {
      x = (geometry.xOf(from) + geometry.xOf(to)) / 2;
    } else continue;
    x = Math.min(width - DAY_LABEL_PX / 2, Math.max(DAY_LABEL_PX / 2, x));
    const previous = labels.at(-1);
    if (previous && x - previous.x < DAY_LABEL_PX + 6) continue;
    labels.push({
      key: String(day.getTime()),
      label: day.toLocaleDateString("en-US", { weekday: "short" }).toUpperCase(),
      x,
      today: day.getTime() === today,
    });
  }
  return labels;
}

const sumValues = (values: ReadonlyArray<number>) => values.reduce((total, v) => total + v, 0);

/**
 * Where a step in `driver`'s band lands just after `t`: the top of the whole stack, and the top
 * of that provider's band (its zero point when it has just run dry).
 */
function stackAfter(
  model: PoolModel,
  geometry: ChartGeometry,
  driver: string,
  t: number,
): { readonly stackY: number; readonly bandY: number } {
  const after = valuesAt(model, t + model.projection.step);
  const position = model.providers.findIndex((provider) => provider.driver === driver);
  return {
    stackY: geometry.yOf(sumValues(after)),
    bandY: geometry.yOf(sumValues(after.slice(0, position + 1))),
  };
}

function runoutLength(model: PoolModel, span: ProviderDrySpan | DrySpan): string {
  return span.duration === null
    ? `${formatSpan(model.end - span.from)}+`
    : formatSpan(span.duration);
}

interface LanePoint {
  readonly id: string;
  readonly x: number;
  readonly stackY: number;
  readonly tickTo: number;
  readonly color: string;
  readonly refill?: RefillEvent;
  readonly runout?: { readonly driver: string; readonly length: string };
}

interface LaneTag {
  readonly key: string;
  readonly left: number;
  readonly width: number;
  readonly top: number;
  readonly drivers: ReadonlyArray<string>;
  readonly amount: number;
  readonly runout: string | null;
  readonly ticks: ReadonlyArray<{
    readonly id: string;
    readonly x: number;
    readonly to: number;
    readonly color: string;
  }>;
}

let measureContext: CanvasRenderingContext2D | null | undefined;

/** Width of a text-3xs medium label, for laying tags out before they render. */
function tagTextWidth(text: string): number {
  if (measureContext === undefined) {
    measureContext = document.createElement("canvas").getContext("2d");
  }
  if (!measureContext) return text.length * 6;
  measureContext.font = `500 10px ${getComputedStyle(document.body).fontFamily}`;
  return Math.ceil(measureContext.measureText(text).width) + 1;
}

/** "Claude out · 3d" alone; several runouts in one tag drop their lengths to stay short. */
function runoutText(points: ReadonlyArray<LanePoint>): string | null {
  const runouts = points.flatMap((point) => (point.runout ? [point.runout] : []));
  if (runouts.length === 0) return null;
  if (runouts.length === 1) return `${poolLabel(runouts[0]!.driver)} out · ${runouts[0]!.length}`;
  return `${[...new Set(runouts.map((runout) => poolLabel(runout.driver)))].join(", ")} out`;
}

/** One pill: border and padding, refill chips and amount, a divider, then the runouts. */
function layoutTag(points: ReadonlyArray<LanePoint>, minLeft: number, width: number): LaneTag {
  const refills = points.flatMap((point) => (point.refill ? [point.refill] : []));
  const runout = runoutText(points);
  const drivers = [...new Set(refills.map((refill) => refill.driver))];
  const amount = refills.reduce((total, refill) => total + refill.amount, 0);
  const items = [
    ...drivers.map(() => 6),
    ...(refills.length > 0 ? [tagTextWidth(`+${formatPercent(amount)}`)] : []),
    ...(runout === null ? [] : [tagTextWidth(runout) + (refills.length > 0 ? 5 : 0)]),
  ];
  const tagWidth = 10 + sumValues(items) + 4 * (items.length - 1);
  const center = sumValues(points.map((point) => point.x)) / points.length;
  const left = Math.max(minLeft, Math.min(width - tagWidth, center - tagWidth / 2));
  const top = Math.max(0, Math.min(...points.map((point) => point.stackY)) - TAG_GAP - TAG_HEIGHT);
  return {
    key: points.map((point) => point.id).join("|"),
    left,
    width: tagWidth,
    top,
    drivers,
    amount,
    runout,
    // A tick only hangs from the pill itself, never from empty space beside it.
    ticks: points
      .filter((point) => point.x >= left + 1 && point.x <= left + tagWidth - 1)
      .map((point) => ({
        id: point.id,
        x: Math.round(point.x),
        to: point.tickTo,
        color: point.color,
      })),
  };
}

/**
 * One lane of tags above the pool's silhouette: each refill where it lands, with a tick down to
 * the step in its provider's band, and each runout where a band reaches zero. Points within
 * TAG_MERGE_PX of a group's first point share a tag, and a tag that would still overlap the one
 * before it merges into it.
 */
function laneTags(
  model: PoolModel,
  geometry: ChartGeometry,
  width: number,
  minLeft: number,
): LaneTag[] {
  const refills = model.projection.refills
    .filter(
      (refill) => refill.at > model.now && refill.at <= model.end && refill.amount >= MIN_REFILL,
    )
    .map((refill): LanePoint => {
      const { stackY, bandY } = stackAfter(model, geometry, refill.driver, refill.at);
      return {
        id: `refill:${refill.account}:${refill.at}`,
        x: geometry.xOf(refill.at),
        stackY,
        tickTo: bandY,
        color: poolColor(refill.driver),
        refill,
      };
    });
  const runouts = model.projection.dry
    .filter((span) => span.from > model.now && span.from < model.end)
    .map((span): LanePoint => {
      const { stackY, bandY } = stackAfter(model, geometry, span.driver, span.from);
      return {
        id: `runout:${span.driver}:${span.from}`,
        x: geometry.xOf(span.from),
        stackY,
        tickTo: bandY,
        color: ROSE,
        runout: { driver: span.driver, length: runoutLength(model, span) },
      };
    });
  const points = [...refills, ...runouts].toSorted((left, right) => left.x - right.x);
  const groups: LanePoint[][] = [];
  for (const point of points) {
    const group = groups.at(-1);
    if (group && point.x - group[0]!.x < TAG_MERGE_PX) group.push(point);
    else groups.push([point]);
  }
  const placed: Array<{ points: LanePoint[]; tag: LaneTag }> = [];
  for (const group of groups) {
    let merged = group;
    let tag = layoutTag(merged, minLeft, width);
    let previous = placed.at(-1);
    while (previous && tag.left < previous.tag.left + previous.tag.width + TAG_SPACING) {
      placed.pop();
      merged = previous.points.concat(merged);
      tag = layoutTag(merged, minLeft, width);
      previous = placed.at(-1);
    }
    placed.push({ points: merged, tag });
  }
  return placed.map((entry) => entry.tag);
}

function PoolChart({ model }: { readonly model: PoolModel }) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const { width, height } = useElementSize(containerRef);
  const geometry = chartGeometry(width, height, model);
  const nowX = geometry.xOf(model.now);
  const days = dayLabels(model, geometry, width);
  const poolDryLabels = model.projection.poolDry.flatMap((span) => {
    const from = Math.max(model.start, span.from);
    const to = Math.min(model.end, span.to ?? model.end);
    const x = geometry.xOf(from);
    if (geometry.xOf(to) - x < POOL_DRY_LABEL_MIN_PX) return [];
    return [{ key: String(span.from), x, text: `Pool dry · ${runoutLength(model, span)}` }];
  });

  return (
    <>
      <div ref={containerRef} className="relative min-h-0 flex-1">
        <DitherCanvas
          className="absolute inset-0 h-full"
          label={`Pool: ${formatPercent(model.left)} left of ${formatPercent(model.capacity)}`}
          draw={(context, size, color) => drawPool(context, size, color, model)}
        />
        <span
          className={cn(
            "pointer-events-none absolute top-0 text-3xs leading-3 tracking-wider text-muted-foreground",
            nowX >= 14 && "-translate-x-1/2",
          )}
          style={{ left: nowX >= 14 ? nowX : 0 }}
        >
          NOW
        </span>
        {poolDryLabels.map((label) => (
          <span
            key={label.key}
            className="pointer-events-none absolute text-3xs leading-3.5 font-medium"
            style={{ left: label.x + 4, top: geometry.plotTop + 3, color: ROSE }}
          >
            {label.text}
          </span>
        ))}
        {width > 0 ? (
          <ChartHover
            model={model}
            geometry={geometry}
            width={width}
            minTagLeft={(nowX >= 14 ? nowX + NOW_LABEL_PX / 2 : NOW_LABEL_PX) + TAG_SPACING}
          />
        ) : null}
      </div>
      <div className="relative mt-1 h-3 text-3xs leading-3 tracking-wider text-muted-foreground">
        {days.map((day) => (
          <span
            key={day.key}
            className={cn("absolute -translate-x-1/2", day.today && "text-foreground/85")}
            style={{ left: day.x }}
          >
            {day.label}
          </span>
        ))}
      </div>
    </>
  );
}

/** Lane tags, the crosshair and its readout; kept apart so hovering never repaints the canvas. */
function ChartHover({
  model,
  geometry,
  width,
  minTagLeft,
}: {
  readonly model: PoolModel;
  readonly geometry: ChartGeometry;
  readonly width: number;
  readonly minTagLeft: number;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const tags = laneTags(model, geometry, width, minTagLeft);
  const span = model.end - model.start;
  const hoverX = hover === null ? 0 : geometry.xOf(hover);

  return (
    <div
      data-pool-chart
      className="absolute inset-0 cursor-crosshair"
      onPointerMove={(event) => {
        const rect = event.currentTarget.getBoundingClientRect();
        const fraction = (event.clientX - rect.left) / rect.width;
        setHover(model.start + Math.max(0, Math.min(1, fraction)) * span);
      }}
      onPointerLeave={() => setHover(null)}
    >
      <div
        className={cn(
          "pointer-events-none absolute inset-0 transition-opacity duration-150",
          hover !== null && "opacity-30",
        )}
      >
        {tags.map((tag) => (
          <div key={tag.key}>
            {tag.ticks.map((tick) =>
              tick.to > tag.top + TAG_HEIGHT ? (
                <span
                  key={tick.id}
                  aria-hidden
                  className="absolute w-px"
                  style={{
                    left: tick.x,
                    top: tag.top + TAG_HEIGHT,
                    height: tick.to - tag.top - TAG_HEIGHT,
                    background: tick.color,
                  }}
                />
              ) : null,
            )}
            <span
              className="absolute inline-flex items-center justify-center gap-1 rounded-sm border bg-popover/90 px-1 text-3xs font-medium whitespace-nowrap tabular-nums"
              style={{
                left: tag.left,
                top: tag.top,
                width: tag.width,
                height: TAG_HEIGHT,
                borderColor:
                  tag.drivers.length === 0
                    ? `color-mix(in oklab, ${ROSE} 45%, transparent)`
                    : undefined,
              }}
            >
              {tag.drivers.map((driver) => (
                <Chip key={driver} driver={driver} className="size-1.5" />
              ))}
              {tag.drivers.length > 0 ? `+${formatPercent(tag.amount)}` : null}
              {tag.runout !== null && tag.drivers.length > 0 ? (
                <span aria-hidden className="h-2 w-px bg-border" />
              ) : null}
              {tag.runout === null ? null : <span style={{ color: ROSE }}>{tag.runout}</span>}
            </span>
          </div>
        ))}
      </div>
      {hover !== null ? (
        <>
          <span
            aria-hidden
            className="pointer-events-none absolute w-px bg-foreground/50"
            style={{
              left: Math.round(hoverX),
              top: geometry.plotTop,
              height: geometry.baseline - geometry.plotTop,
            }}
          />
          <HoverReadout
            model={model}
            t={hover}
            style={hoverX > width / 2 ? { right: width - hoverX + 10 } : { left: hoverX + 10 }}
          />
        </>
      ) : null}
    </div>
  );
}

/** Per-account rows only while the whole pool has this few accounts. */
const HOVER_ACCOUNT_ROWS_MAX = 4;

function HoverReadout({
  model,
  t,
  style,
}: {
  readonly model: PoolModel;
  readonly t: number;
  readonly style: CSSProperties;
}) {
  const recorded = t < model.now;
  const values = valuesAt(model, t);
  const totalAccounts = model.providers.reduce(
    (sum, provider) => sum + provider.accounts.length,
    0,
  );
  return (
    <div
      className="pointer-events-none absolute top-0 z-10 min-w-40 rounded-md border bg-popover/95 px-2.5 py-1.5 text-2xs leading-4 text-popover-foreground shadow-lg backdrop-blur-sm"
      style={style}
    >
      <div className="flex items-baseline justify-between gap-3">
        <span className="font-medium tabular-nums">
          {recorded ? WEEKDAY_TIME.format(t) : formatForecast(t)}
        </span>
        <span className="text-3xs tracking-wider text-muted-foreground uppercase">
          {recorded ? "recorded" : "forecast"}
        </span>
      </div>
      {model.providers
        .map((provider, index) => ({ provider, value: values[index] ?? 0 }))
        .toReversed()
        .map(({ provider, value }) => {
          const accounts = accountValuesAt(model, provider, t);
          const dry = accounts.filter((left) => left !== null && left < 0.5).length;
          return (
            <div key={provider.driver} className="tabular-nums">
              <div className="flex items-baseline justify-between gap-4">
                <span className="inline-flex items-baseline gap-1.5">
                  <Chip driver={provider.driver} className="self-center" />
                  {poolLabel(provider.driver)}
                </span>
                <DryValue left={value} suffix=" left" />
              </div>
              {totalAccounts <= HOVER_ACCOUNT_ROWS_MAX ? (
                provider.accounts.length > 1 ? (
                  provider.accounts.map((account, index) => {
                    const left = accounts[index];
                    if (left === null || left === undefined) return null;
                    return (
                      <div
                        key={account.key}
                        className="flex items-baseline justify-between gap-4 ps-3.5 text-muted-foreground"
                      >
                        <span className="truncate">{account.name}</span>
                        <DryValue left={left} />
                      </div>
                    );
                  })
                ) : null
              ) : dry > 0 ? (
                <div className="ps-3.5 text-muted-foreground">
                  {dry} of {accounts.length} dry
                </div>
              ) : null}
            </div>
          );
        })}
      <div className="mt-1 flex items-baseline justify-between gap-4 border-t pt-1 tabular-nums">
        <span className="text-muted-foreground">Pool</span>
        <span>
          {formatPercent(sumValues(values))}
          <span className="text-muted-foreground"> of {formatPercent(model.capacity)}</span>
        </span>
      </div>
    </div>
  );
}

function DryValue({ left, suffix = "" }: { readonly left: number; readonly suffix?: string }) {
  return left < 0.5 ? (
    <span style={{ color: ROSE }}>empty</span>
  ) : (
    <span>
      {formatPercent(left)}
      {suffix}
    </span>
  );
}

function forecastDensity(model: PoolModel, t: number): number {
  const progress = Math.max(0, Math.min(1, (t - model.now) / FORECAST_MS));
  return FORECAST_DENSITY.start + (FORECAST_DENSITY.end - FORECAST_DENSITY.start) * progress;
}

function drawPool(
  context: CanvasRenderingContext2D,
  { width, height }: { readonly width: number; readonly height: number },
  color: ResolveColor,
  model: PoolModel,
) {
  const geometry = chartGeometry(width, height, model);
  const { rows, columns, plotTop, baseline, xOf, rowOf } = geometry;
  const span = model.end - model.start;
  const rose = color(ROSE);

  // The whole pool dry at once: a wash over the full height.
  for (const dry of model.projection.poolDry) {
    const from = Math.max(model.start, dry.from);
    const to = Math.min(model.end, dry.to ?? model.end);
    if (to <= from) continue;
    context.fillStyle = color(`color-mix(in oklab, ${ROSE} 14%, transparent)`);
    context.fillRect(Math.round(xOf(from)), plotTop, Math.round(xOf(to) - xOf(from)), rows * CELL);
  }

  const spent = color(SPENT);
  const palette = model.providers.map((provider) => ({
    fill: color(poolColor(provider.driver)),
    crest: color(`color-mix(in oklab, ${poolColor(provider.driver)} 70%, white)`),
  }));
  const bands: Array<{ index: number; top: number; bottom: number }> = [];
  for (let column = 0; column < columns; column += 1) {
    const t = model.start + ((column * CELL + CELL / 2) / width) * span;
    const values = valuesAt(model, t);
    const density = t < model.now ? PAST_DENSITY : forecastDensity(model, t);
    bands.length = 0;
    let stacked = 0;
    values.forEach((value, index) => {
      if (value <= 0) return;
      const low = stacked;
      stacked += value;
      const top = rowOf(stacked);
      const bottom = rowOf(low);
      if (bottom > top) bands.push({ index, top, bottom });
    });
    for (let row = 0; row < rows; row += 1) {
      const band = bands.find((entry) => row >= entry.top && row < entry.bottom);
      let fill = spent;
      if (band) {
        const colors = palette[band.index]!;
        if (row - band.top < 2) fill = colors.crest;
        else if (density > bayer(column, row)) fill = colors.fill;
      }
      context.fillStyle = fill;
      context.fillRect(column * CELL, plotTop + row * CELL, CELL - 1, CELL - 1);
    }
  }

  context.fillStyle = color(BASELINE);
  context.fillRect(0, baseline, width, 1);

  for (const dry of model.projection.dry) {
    const from = Math.max(model.start, dry.from);
    const to = Math.min(model.end, dry.to ?? model.end);
    if (to <= from) continue;
    const x0 = Math.round(xOf(from));
    const x1 = Math.round(xOf(to));
    if (dry.from > model.now) {
      // From where the dying band reaches zero on the stack down to the baseline.
      const { bandY } = stackAfter(model, geometry, dry.driver, dry.from);
      if (bandY < baseline - 1)
        drawDottedLine(context, [x0, bandY], [x0, baseline - 1], rose, 3, 1);
    }
    // A checkered 4px strip under the baseline for as long as the provider stays dry. The
    // checker is phased to the canvas, so two providers dry at once share one strip.
    context.fillStyle = rose;
    for (let cell = Math.floor(x0 / 2); cell * 2 < x1; cell += 1) {
      const left = Math.max(x0, cell * 2);
      const right = Math.min(x1, cell * 2 + 2);
      if (right <= left) continue;
      context.fillRect(left, baseline + 2 + (cell % 2) * 2, right - left, 2);
    }
  }

  const nowX = Math.round(xOf(model.now));
  drawDottedLine(context, [nowX, plotTop], [nowX, baseline - 1], color(NOW_LINE), 3, 1);
}
