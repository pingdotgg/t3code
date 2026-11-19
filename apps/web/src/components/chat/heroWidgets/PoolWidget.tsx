import { useAtomValue } from "@effect/atom-react";
import {
  isProviderAvailable,
  PROVIDER_DISPLAY_NAMES,
  type UsageProviderKind,
} from "@t3tools/contracts";
import {
  collectLimitAccounts,
  collectLimitPools,
  type LimitAccount,
  type LimitPresentations,
} from "@t3tools/shared/usageLimits";
import type { DailyTotals } from "@t3tools/shared/usageMerge";
import { msg, T, useGT, useMessages, Var } from "gt-react";
import { GaugeIcon } from "lucide-react";
import { useRef, useState, type CSSProperties, type ReactNode } from "react";

import { m, type MessageResolver } from "~/i18n/messages";
import { cn } from "~/lib/utils";
import { Text } from "../../ui/text";
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
  HeadlineFigure,
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
/** Below this card width, or when the rail is taller than the chart, it folds into a wrapping legend. */
const NARROW_CARD = 760;
const CARD_PADDING = 32;
/** Refills smaller than this many points still step the chart but get no tag or headline. */
const MIN_REFILL = 5;
/** Events of one kind this close to the first in a group, in time or on screen, share its tag. */
const TAG_MERGE_MS = 2 * HOUR_MS;
const TAG_MERGE_PX = 16;
const TAG_HEIGHT = 14;
/** A tag that would collide with another steps up by this much. */
const TAG_ROW = TAG_HEIGHT + 2;
const TAG_GAP = 4;
/** The rows a tag may step down into when there is no room above it. */
const TAG_ROWS_DOWN = 4;
/** Room kept between a pill's edge and another event's tick. */
const TAG_TICK_CLEAR = 3;
/** Clear space kept between neighbouring tags, and right of the Now label. */
const TAG_SPACING = 4;
const NOW_LABEL_PX = 24;
const NOW_LABEL_HEIGHT = 12;
const POOL_DRY_LABEL_MIN_PX = 72;
const PIPS_PER_ROW = 8;
const PIP_GAP = 4;
/** Height of the rose bar an empty account's pip sits on. */
const PIP_EMPTY_BAR = 2;
/** The rail's gap plus one text-meta line, for the "No limits" line. */
const NO_LIMITS_PX = 28;
/** A rail entry with one row of pips, plus the gap above the next entry, in rem like the rail. */
const RAIL_ENTRY_REM = 3.25;
const RAIL_GAP_REM = 0.75;
/** Room a weekday label needs under the chart. */
const DAY_LABEL_PX = 24;

const CELL = 3;
/** Room above the full pool for the Now label and refill tags. */
const TOP_GUTTER = 20;
/** Under the baseline: a gap, the 4px dry strip, a gap. */
const UNDER_BASELINE = 8;
const PAST_DENSITY = 0.85;
const FORECAST_DENSITY = { start: 0.65, end: 0.3 } as const;

const WEEKDAY_HOUR = new Intl.DateTimeFormat("en-US", { weekday: "short", hour: "numeric" });

/**
 * An account named only after its provider (the driver's default instance) is the provider's
 * default sign-in, so it never repeats the provider's label under it.
 */
function accountName(account: LimitAccount, resolve: MessageResolver = m): string {
  const providerNames = [PROVIDER_DISPLAY_NAMES[account.driver], poolLabel(String(account.driver))];
  const name = account.displayName;
  if (name && !providerNames.some((other) => other?.toLowerCase() === name.toLowerCase())) {
    return name;
  }
  if (account.email) {
    const [local = "", domain = ""] = account.email.split("@");
    return `${local[0] ?? ""}${domain[0] ?? ""}`.toUpperCase();
  }
  return resolve(msg("Default", { $context: "name of a provider's default account" }));
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
  const gt = useGT();
  const resolve = useMessages();
  const presentations = useAtomValue(environmentPresentations.presentationsWithProvidersAtom);
  const pools = collectLimitPools(collectLimitAccounts(presentations), now);
  const unsorted = poolProviders(pools, (account) => accountName(account, resolve));
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
    // The sum of the rounded per-provider values the rail shows, so the headline adds up.
    left: providers.reduce((sum, provider) => sum + Math.round(provider.left), 0),
    start,
    end,
    now,
    samples,
  };
  const noLimits = driversWithoutLimits(presentations, providers);

  const nextRefill = projection.refills.find(
    (refill) => refill.at > now && refill.amount >= MIN_REFILL,
  );
  const status = headerStatus(model, nextRefill, resolve);
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
      title={gt("Pool", { $context: "noun, the usage limits of every provider combined" })}
      meta={
        status?.dry ? <span style={{ color: ROSE }}>{status.text}</span> : (status?.text ?? null)
      }
    >
      {providers.length === 0 ? (
        <p className="mt-3 text-meta text-muted-foreground">
          <T>No provider reports subscription limits yet.</T>
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
  resolve: MessageResolver = m,
): { readonly text: string; readonly dry: boolean } | null {
  if (model.providers.length === 0) return null;
  // A null driver is the whole pool.
  const emptyText = (driver: string | null, until: number | null, refillsThen: boolean) => {
    if (driver === null) {
      if (until !== null && refillsThen) return resolve(msg("Pool empty now"));
      return until === null
        ? resolve(msg("Pool empty until next week"))
        : resolve(msg("Pool empty until {time}", { time: formatReset(until) }));
    }
    const provider = poolLabel(driver);
    if (until !== null && refillsThen) return resolve(msg("{provider} empty now", { provider }));
    return until === null
      ? resolve(msg("{provider} empty until next week", { provider }))
      : resolve(msg("{provider} empty until {time}", { provider, time: formatReset(until) }));
  };
  const poolDry = model.projection.poolDry.find(
    (span) => span.from < model.end && (span.to === null || span.to > model.now),
  );
  if (poolDry) {
    return {
      dry: true,
      text:
        poolDry.from <= model.now
          ? emptyText(null, poolDry.to, nextRefill?.at === poolDry.to)
          : resolve(msg("Pool runs out {time}", { time: formatForecast(poolDry.from) })),
    };
  }
  const emptyNow = model.projection.dry.find((span) => span.from <= model.now);
  if (emptyNow) {
    return {
      dry: true,
      text: emptyText(
        emptyNow.driver,
        emptyNow.to,
        nextRefill?.driver === emptyNow.driver && nextRefill.at === emptyNow.to,
      ),
    };
  }
  const runsOut = model.projection.dry.find(
    (span) => span.from > model.now && span.from < model.end,
  );
  return runsOut
    ? {
        dry: true,
        text: resolve(
          msg("{provider} runs out {time}", {
            provider: poolLabel(runsOut.driver),
            time: formatForecast(runsOut.from),
          }),
        ),
      }
    : { dry: false, text: resolve(msg("Lasts the week")) };
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
  const gt = useGT();
  const ref = useRef<HTMLDivElement | null>(null);
  const rowRef = useRef<HTMLDivElement | null>(null);
  const { width } = useElementSize(ref);
  const row = useElementSize(rowRef);
  const narrow = width > 0 && width + CARD_PADDING < NARROW_CARD;
  const accounts = model.providers.reduce((sum, provider) => sum + provider.accounts.length, 0);
  // Top of the stack first, as the bands read from the top down.
  const listed = model.providers.toReversed();
  const rem = Number.parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
  const legend =
    narrow ||
    (row.height > 0 && row.height < (listed.length * RAIL_ENTRY_REM - RAIL_GAP_REM) * rem);

  return (
    <div ref={ref} className="mt-2.5 flex min-h-0 flex-1 flex-col">
      <div className="flex items-baseline gap-2 leading-none whitespace-nowrap">
        <HeadlineFigure>{formatPercent(model.left)}</HeadlineFigure>
        <span className="truncate text-body text-muted-foreground">
          {gt(
            "{count, plural, one {left of {capacity} across {count} account} other {left of {capacity} across {count} accounts}}",
            { count: accounts, capacity: formatPercent(model.capacity) },
          )}
        </span>
        {nextRefill ? (
          <span className="ms-auto inline-flex min-w-0 items-baseline gap-1.5 ps-4 text-body tabular-nums">
            {narrow ? null : (
              <span className="shrink-0 text-micro text-muted-foreground">
                <T>Next refill</T>
              </span>
            )}
            <Chip driver={nextRefill.driver} className="ms-1" />
            <span className="shrink-0 text-label">+{formatPercent(nextRefill.amount)}</span>
            <span className="flex min-w-0 gap-2 text-muted-foreground">
              <span className="truncate">{poolLabel(nextRefill.driver)}</span>
              <span className="shrink-0">{formatReset(nextRefill.at)}</span>
            </span>
          </span>
        ) : null}
      </div>
      <div ref={rowRef} className="mt-3 flex min-h-0 flex-1 gap-6">
        <div className="flex min-w-0 flex-1 flex-col">
          <PoolChart model={model} />
          {legend ? (
            <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 overflow-hidden text-meta whitespace-nowrap tabular-nums">
              {listed.map((provider) => {
                const status = providerStatus(model, provider.driver);
                return (
                  <span key={provider.driver} className="inline-flex items-center gap-1.5">
                    <Hint
                      content={<ProviderHint model={model} provider={provider} status={status} />}
                      className="inline-flex items-baseline gap-1.5"
                    >
                      <Chip driver={provider.driver} className="self-center" />
                      {/* The dotted underline marks the hover details; rose when this provider runs dry. */}
                      <span
                        className="underline decoration-dotted underline-offset-3"
                        style={{
                          textDecorationColor:
                            status.kind === "lasts"
                              ? "color-mix(in oklab, var(--foreground) 35%, transparent)"
                              : ROSE,
                        }}
                      >
                        {poolLabel(provider.driver)}
                      </span>
                      <Capacity provider={provider} />
                    </Hint>
                    <Pips provider={provider} wrap={false} />
                  </span>
                );
              })}
            </div>
          ) : null}
        </div>
        {legend ? null : <Rail model={model} listed={listed} noLimits={noLimits} />}
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
      className="flex w-48 shrink-0 flex-col justify-center-safe gap-3 overflow-hidden text-meta tabular-nums"
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
          <T>
            No limits: <Var>{noLimits.map(poolLabel).join(", ")}</Var>
          </T>
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
      <Text variant="meta" tone="inherit" emphasis>
        {Math.round(provider.left)}
      </Text>
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
  status,
}: {
  readonly model: PoolModel;
  readonly provider: PoolProvider;
  /** Shown where the entry itself has no room for it. */
  readonly status?: ProviderStatus;
}) {
  const gt = useGT();
  const burn = model.burns.get(provider.driver);
  return (
    <div className="tabular-nums">
      <div>
        <T>
          <Var>{poolLabel(provider.driver)}</Var> <Var>{provider.windowLabel.toLowerCase()}</Var>:{" "}
          <Var>{formatPercent(provider.left)}</Var> left of{" "}
          <Var>{formatPercent(provider.capacity)}</Var>
        </T>
      </div>
      <div className="text-muted-foreground">
        {burn && burn.perHour > 0
          ? burn.source === "tokens"
            ? gt("Burning about {rate} a day, from the last 3 days of tokens", {
                rate: formatRate(burn.perHour * 24),
              })
            : gt("Burning about {rate} a day, from the average since the window opened", {
                rate: formatRate(burn.perHour * 24),
              })
          : gt("No burn measured")}
      </div>
      {status && status.kind !== "lasts" ? <StatusText status={status} /> : null}
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
  const spent = color(PIP_EMPTY);
  if (left < 0.5) {
    // An empty account: spent cells over a solid rose bar, so it never reads as a dim partial.
    context.fillStyle = spent;
    for (let row = 0; row < rows - 1; row += 1) {
      for (let column = 0; column < columns; column += 1) {
        context.fillRect(column * CELL, row * CELL, CELL - 1, CELL - 1);
      }
    }
    context.fillStyle = color(ROSE);
    context.fillRect(0, rows * CELL - 1 - PIP_EMPTY_BAR, columns * CELL - 1, PIP_EMPTY_BAR);
    return;
  }
  // Anything left lights at least the bottom row, so a few percent never looks empty.
  const lit = Math.max(1, (Math.min(100, left) / 100) * rows);
  const full = Math.floor(lit);
  const fill = color(poolColor(driver));
  const crest = color(`color-mix(in oklab, ${poolColor(driver)} 70%, white)`);
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
      label: day.toLocaleDateString("en-US", { weekday: "short" }),
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
  readonly t: number;
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
  /** Refills in time order; back-to-back refills of one provider share a chip. */
  readonly refills: ReadonlyArray<{
    readonly id: string;
    readonly driver: string;
    readonly amount: number;
  }>;
  readonly runout: string | null;
  readonly ticks: ReadonlyArray<{
    readonly id: string;
    readonly x: number;
    readonly to: number;
    readonly color: string;
  }>;
}

interface TagBox {
  readonly left: number;
  readonly right: number;
  readonly top: number;
  readonly bottom: number;
}

let measureContext: CanvasRenderingContext2D | null | undefined;

/** Width of a label in the text-micro role (500 weight), for laying tags out before they render. */
function tagTextWidth(text: string): number {
  if (measureContext === undefined) {
    measureContext = document.createElement("canvas").getContext("2d");
  }
  if (!measureContext) return text.length * 6;
  // The role's size steps up on phones, so read it rather than assume 10px.
  const root = getComputedStyle(document.documentElement);
  const size =
    Number.parseFloat(root.getPropertyValue("--type-micro")) * Number.parseFloat(root.fontSize);
  measureContext.font = `500 ${size || 10}px ${getComputedStyle(document.body).fontFamily}`;
  return Math.ceil(measureContext.measureText(text).width) + 1;
}

/** "Claude out for 3d" alone; several runouts in one tag drop their lengths to stay short. */
function runoutText(points: ReadonlyArray<LanePoint>): string | null {
  const runouts = points.flatMap((point) => (point.runout ? [point.runout] : []));
  if (runouts.length === 0) return null;
  if (runouts.length === 1) {
    return `${poolLabel(runouts[0]!.driver)} out for ${runouts[0]!.length}`;
  }
  return `${[...new Set(runouts.map((runout) => poolLabel(runout.driver)))].join(", ")} out`;
}

function tagRefills(points: ReadonlyArray<LanePoint>): LaneTag["refills"] {
  const refills: Array<{ id: string; driver: string; amount: number }> = [];
  for (const point of points) {
    if (!point.refill) continue;
    const last = refills.at(-1);
    if (last?.driver === point.refill.driver) last.amount += point.refill.amount;
    else refills.push({ id: point.id, driver: point.refill.driver, amount: point.refill.amount });
  }
  return refills;
}

const overlaps = (a: TagBox, b: TagBox) =>
  a.left < b.right + TAG_SPACING &&
  b.left < a.right + TAG_SPACING &&
  a.top < b.bottom &&
  b.top < a.bottom;

/**
 * Places one group's pill over its own events: centred on them where it can be, sliding no
 * further than keeps every event inside its middle half, and stepping up a row (down only when
 * the top is reached) until it clears every pill placed before it and the Now label.
 */
function placeTag(
  points: ReadonlyArray<LanePoint>,
  width: number,
  taken: ReadonlyArray<TagBox>,
  otherTicks: ReadonlyArray<number>,
): LaneTag {
  const refills = tagRefills(points);
  const runout = runoutText(points);
  const items = [
    ...refills.map((refill) => 6 + 4 + tagTextWidth(`+${formatPercent(refill.amount)}`)),
    ...(runout === null ? [] : [tagTextWidth(runout)]),
  ];
  const tagWidth = 10 + sumValues(items) + 6 * (items.length - 1);
  const xs = points.map((point) => point.x);
  const first = Math.min(...xs);
  const last = Math.max(...xs);
  const inset = Math.max(4, tagWidth / 4);
  let low = Math.max(0, last + inset - tagWidth);
  let high = Math.min(width - tagWidth, first - inset);
  if (low > high) {
    low = Math.max(0, last + 2 - tagWidth);
    high = Math.min(width - tagWidth, first - 2);
  }
  if (low > high)
    low = high = Math.max(0, Math.min(width - tagWidth, (first + last - tagWidth) / 2));
  const ideal = Math.max(low, Math.min(high, (first + last - tagWidth) / 2));
  const baseTop = Math.max(
    0,
    Math.min(...points.map((point) => point.stackY)) - TAG_GAP - TAG_HEIGHT,
  );
  const tops: number[] = [];
  for (let top = baseTop; top >= 0; top -= TAG_ROW) tops.push(top);
  for (let row = 1; row <= TAG_ROWS_DOWN; row += 1) tops.push(baseTop + row * TAG_ROW);

  const lefts = [
    ideal,
    ...taken.flatMap((other) => [other.right + TAG_SPACING, other.left - TAG_SPACING - tagWidth]),
    ...otherTicks.flatMap((x) => [x + TAG_TICK_CLEAR, x - TAG_TICK_CLEAR - tagWidth]),
  ]
    .filter((candidate) => candidate >= low && candidate <= high)
    .toSorted((a, b) => Math.abs(a - ideal) - Math.abs(b - ideal));
  const fits = (left: number, top: number) => {
    const box = { left, right: left + tagWidth, top, bottom: top + TAG_HEIGHT };
    return taken.every((other) => !overlaps(box, other));
  };
  // Another event's tick may have to rise past this pill, so the pill keeps clear of it where it can.
  const clearOfTicks = (left: number) =>
    otherTicks.every((x) => x <= left - TAG_TICK_CLEAR || x >= left + tagWidth + TAG_TICK_CLEAR);
  let left = ideal;
  let top = baseTop;
  for (const candidateTop of tops) {
    const fitting = lefts.filter((candidate) => fits(candidate, candidateTop));
    const chosen = fitting.find(clearOfTicks) ?? fitting[0];
    if (chosen !== undefined) {
      left = chosen;
      top = candidateTop;
      break;
    }
  }
  return {
    key: points.map((point) => point.id).join("|"),
    left,
    width: tagWidth,
    top,
    refills,
    runout,
    ticks: points.map((point) => ({
      id: point.id,
      x: Math.round(point.x),
      to: point.tickTo,
      color: point.color,
    })),
  };
}

/**
 * Tags above the pool's silhouette: each refill where it lands, with a tick down to the step in
 * its provider's band, and each runout where a band reaches zero. Refills and runouts never share
 * a tag; events of one kind share one only when they fall within TAG_MERGE_MS or TAG_MERGE_PX of
 * the first in the group, listed in time order. Any other collision stacks the later tag a row up.
 */
function laneTags(
  model: PoolModel,
  geometry: ChartGeometry,
  width: number,
  nowLabel: { readonly left: number; readonly right: number },
): LaneTag[] {
  const refills = model.projection.refills
    .filter(
      (refill) => refill.at > model.now && refill.at <= model.end && refill.amount >= MIN_REFILL,
    )
    .map((refill): LanePoint => {
      const { stackY, bandY } = stackAfter(model, geometry, refill.driver, refill.at);
      return {
        id: `refill:${refill.account}:${refill.at}`,
        t: refill.at,
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
        t: span.from,
        x: geometry.xOf(span.from),
        stackY,
        tickTo: bandY,
        color: ROSE,
        runout: { driver: span.driver, length: runoutLength(model, span) },
      };
    });
  const groups: LanePoint[][] = [];
  for (const points of [refills, runouts]) {
    let group: LanePoint[] | null = null;
    for (const point of points.toSorted((left, right) => left.t - right.t)) {
      const head = group?.[0];
      if (group && head && (point.t - head.t <= TAG_MERGE_MS || point.x - head.x < TAG_MERGE_PX)) {
        group.push(point);
      } else {
        group = [point];
        groups.push(group);
      }
    }
  }
  const taken: TagBox[] = [{ ...nowLabel, top: 0, bottom: NOW_LABEL_HEIGHT }];
  const tags: LaneTag[] = [];
  for (const group of groups.toSorted((left, right) => left[0]!.t - right[0]!.t)) {
    const otherTicks = [...refills, ...runouts]
      .filter((point) => !group.includes(point))
      .map((point) => point.x);
    const tag = placeTag(group, width, taken, otherTicks);
    tags.push(tag);
    taken.push({
      left: tag.left,
      right: tag.left + tag.width,
      top: tag.top,
      bottom: tag.top + TAG_HEIGHT,
    });
  }
  return tags;
}

function PoolChart({ model }: { readonly model: PoolModel }) {
  const gt = useGT();
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
    return [
      {
        key: String(span.from),
        x,
        text: gt("Pool dry for {length}", { length: runoutLength(model, span) }),
      },
    ];
  });

  return (
    <>
      <div ref={containerRef} className="relative min-h-0 flex-1">
        <DitherCanvas
          className="absolute inset-0 h-full"
          label={gt("Pool: {left} left of {capacity}", {
            left: formatPercent(model.left),
            capacity: formatPercent(model.capacity),
          })}
          draw={(context, size, color) => drawPool(context, size, color, model)}
        />
        <span
          className={cn(
            "pointer-events-none absolute top-0 text-micro leading-3 text-muted-foreground",
            nowX >= 14 && "-translate-x-1/2",
          )}
          style={{ left: nowX >= 14 ? nowX : 0 }}
        >
          <T>Now</T>
        </span>
        {poolDryLabels.map((label) => (
          <span
            key={label.key}
            className="pointer-events-none absolute text-micro leading-3.5"
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
            nowLabel={{
              left: nowX >= 14 ? nowX - NOW_LABEL_PX / 2 : 0,
              right: nowX >= 14 ? nowX + NOW_LABEL_PX / 2 : NOW_LABEL_PX,
            }}
          />
        ) : null}
      </div>
      <div className="relative mt-1 h-3 text-micro leading-3 text-muted-foreground">
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
  nowLabel,
}: {
  readonly model: PoolModel;
  readonly geometry: ChartGeometry;
  readonly width: number;
  readonly nowLabel: { readonly left: number; readonly right: number };
}) {
  const [hover, setHover] = useState<number | null>(null);
  const tags = laneTags(model, geometry, width, nowLabel);
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
        {/* Every tick first, so a pill stepped above another never has a tick drawn over it. */}
        {tags.flatMap((tag) =>
          tag.ticks.map((tick) =>
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
          ),
        )}
        {tags.map((tag) => (
          <span
            key={tag.key}
            className="absolute inline-flex items-center justify-center gap-1.5 rounded-sm border bg-popover/90 px-1 text-micro whitespace-nowrap tabular-nums"
            style={{
              left: tag.left,
              top: tag.top,
              width: tag.width,
              height: TAG_HEIGHT,
              borderColor:
                tag.runout === null ? undefined : `color-mix(in oklab, ${ROSE} 45%, transparent)`,
            }}
          >
            {tag.refills.map((refill) => (
              <span key={refill.id} className="inline-flex items-center gap-1">
                <Chip driver={refill.driver} className="size-1.5" />+{formatPercent(refill.amount)}
              </span>
            ))}
            {tag.runout === null ? null : <span style={{ color: ROSE }}>{tag.runout}</span>}
          </span>
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
  const gt = useGT();
  const recorded = t < model.now;
  const values = valuesAt(model, t);
  const totalAccounts = model.providers.reduce(
    (sum, provider) => sum + provider.accounts.length,
    0,
  );
  const accountRows = totalAccounts <= HOVER_ACCOUNT_ROWS_MAX;
  // Every figure is rounded once and each total is the sum of the figures shown above it.
  const rows = model.providers.map((provider, index) => {
    const accounts = accountValuesAt(model, provider, t).map((left) =>
      left === null ? null : Math.round(left),
    );
    const listed = accountRows && provider.accounts.length > 1;
    const known = accounts.filter((left): left is number => left !== null);
    return {
      provider,
      accounts,
      listed,
      value:
        listed && known.length === accounts.length
          ? sumValues(known)
          : Math.round(values[index] ?? 0),
    };
  });
  return (
    <div
      className="pointer-events-none absolute top-0 z-10 min-w-40 rounded-md border bg-popover/95 px-2.5 py-1.5 text-caption leading-4 text-popover-foreground shadow-lg backdrop-blur-sm"
      style={style}
    >
      <div className="flex items-baseline justify-between gap-3">
        <Text variant="caption" tone="inherit" emphasis numeric>
          {recorded ? WEEKDAY_TIME.format(t) : formatForecast(t)}
        </Text>
        <span className="text-micro text-muted-foreground">
          {recorded
            ? gt("Recorded", { $context: "a chart point from recorded history" })
            : gt("Forecast", { $context: "a chart point from the projection" })}
        </span>
      </div>
      {rows.toReversed().map(({ provider, accounts, listed, value }) => {
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
            {accountRows ? (
              listed ? (
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
        <span className="text-muted-foreground">
          {gt("Pool", { $context: "noun, the usage limits of every provider combined" })}
        </span>
        <span>
          {formatPercent(sumValues(rows.map((row) => row.value)))}
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
