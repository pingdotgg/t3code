import { useAtomValue } from "@effect/atom-react";
import type { UsageProviderKind } from "@t3tools/contracts";
import {
  collectLimitAccounts,
  collectLimitPools,
  type LimitAccount,
} from "@t3tools/shared/usageLimits";
import type { DailyTotals } from "@t3tools/shared/usageMerge";
import { GaugeIcon } from "lucide-react";
import { useRef, useState } from "react";

import { cn } from "~/lib/utils";
import { environmentPresentations } from "../../../state/presentation";
import { PROVIDER_PRESENTATION } from "../../usage/usageProviders";
import { DitherCanvas } from "./DitherCanvas";
import { bayer, drawDottedLine } from "./dither";
import {
  addLocalDays,
  appendPoolSample,
  DAY_MS,
  estimateBurn,
  HOUR_MS,
  type Burn,
  type PoolProjection,
  type PoolProvider,
  type PoolSample,
  poolProviders,
  projectedAt,
  projectPool,
  sampleAt,
  startOfLocalDay,
} from "./heroWidgets.logic";
import {
  FAINT,
  readStored,
  useDebugValue,
  useElementSize,
  WidgetCard,
  WEEKDAY_TIME,
  writeStored,
} from "./widgetChrome";

const STACK_ORDER = [
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

const SAMPLES_KEY = "t3code:hero-widgets:pool-samples:v1";
const CHART_SPAN_MS = 7 * DAY_MS;
const MIN_PAST_MS = 6 * HOUR_MS;
const MAX_PAST_MS = 2 * DAY_MS;
/** Past columns draw only when a recorded sample is at most this old. */
const SAMPLE_GAP_MS = 3 * HOUR_MS;

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

interface PoolModel {
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
  });
  if (next !== poolSamples) {
    poolSamples = next;
    writeStored(SAMPLES_KEY, next);
  }
  return poolSamples;
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
  const providers = poolProviders(pools, accountName).toSorted(
    (left, right) =>
      (STACK_ORDER.indexOf(left.driver) + 1 || 99) - (STACK_ORDER.indexOf(right.driver) + 1 || 99),
  );
  const samples = recordPoolSample(providers, now);

  const tokensByDriver = new Map<string, Map<string, number>>();
  for (const provider of providers) {
    const kind = USAGE_KIND_BY_DRIVER.get(provider.driver);
    tokensByDriver.set(
      provider.driver,
      new Map(
        daily.map((day) => [day.day, kind ? (day.byProvider.get(kind)?.totalTokens ?? 0) : 0]),
      ),
    );
  }
  const burns = new Map(
    providers.map((provider) => [
      provider.driver,
      estimateBurn(provider, tokensByDriver.get(provider.driver)!, now),
    ]),
  );
  const firstSample = samples.find((sample) => now - sample.t <= MAX_PAST_MS)?.t ?? now;
  const past = Math.min(MAX_PAST_MS, Math.max(MIN_PAST_MS, now - firstSample));
  const start = now - past;
  const end = start + CHART_SPAN_MS;
  const projection = projectPool(
    providers,
    new Map([...burns].map(([driver, burn]) => [driver, burn.perHour])),
    now,
    end + CHART_SPAN_MS,
  );
  const capacity = providers.reduce((sum, provider) => sum + provider.capacity, 0);
  const left = providers.reduce((sum, provider) => sum + provider.left, 0);
  const model: PoolModel = {
    providers,
    burns,
    projection,
    capacity,
    left,
    start,
    end,
    now,
    samples,
  };

  const emptyNow = projection.bands.find((band) => band.from <= now);
  const runsOut = projection.bands.find((band) => band.from > now && band.from < end);
  const nextRefill = projection.refills.find((refill) => refill.amount >= 1);
  useDebugValue("pool", {
    providers,
    burns: Object.fromEntries(burns),
    bands: projection.bands,
    refills: projection.refills.slice(0, 6),
    samples: samples.length,
    start,
    end,
  });

  const status = emptyNow
    ? `${poolLabel(emptyNow.driver)} empty until ${emptyNow.to ? WEEKDAY_TIME.format(emptyNow.to) : "later"}`
    : runsOut
      ? `${poolLabel(runsOut.driver)} runs out ${WEEKDAY_TIME.format(runsOut.from)}`
      : providers.length > 0
        ? "Lasts the week"
        : null;

  return (
    <WidgetCard
      id="pool"
      icon={GaugeIcon}
      title="Pool"
      meta={status}
      metaTone={emptyNow || runsOut ? "warning" : undefined}
    >
      {providers.length === 0 ? (
        <p className="mt-3 text-xs text-muted-foreground">
          No provider reports subscription limits yet.
        </p>
      ) : (
        <>
          <div className="mt-2.5 flex flex-wrap items-baseline gap-x-2 gap-y-1 leading-none">
            <span className="text-3xl font-semibold tracking-tight tabular-nums">
              {formatPercent(left)}
            </span>
            <span className="text-sm text-muted-foreground">left of {formatPercent(capacity)}</span>
            <PoolLegend model={model} />
            {nextRefill ? (
              <span className="ms-auto inline-flex items-baseline gap-1.5 text-sm tabular-nums">
                <span
                  aria-hidden
                  className="size-2 self-center rounded-xs"
                  style={{ background: poolColor(nextRefill.driver) }}
                />
                <span className="font-medium">+{formatPercent(nextRefill.amount)}</span>
                <span className="text-muted-foreground">{WEEKDAY_TIME.format(nextRefill.at)}</span>
              </span>
            ) : null}
          </div>
          <PoolChart model={model} />
        </>
      )}
    </WidgetCard>
  );
}

function PoolLegend({ model }: { readonly model: PoolModel }) {
  return (
    <span className="ms-3 inline-flex flex-wrap items-baseline gap-x-3.5 gap-y-1 text-xs">
      {model.providers.map((provider) => {
        const burn = model.burns.get(provider.driver);
        return (
          <span key={provider.driver} className="inline-flex items-baseline gap-1.5 tabular-nums">
            <span
              aria-hidden
              className="size-2 self-center rounded-xs"
              style={{ background: poolColor(provider.driver) }}
            />
            <span>{poolLabel(provider.driver)}</span>
            <span className="text-muted-foreground">
              {formatPercent(provider.left)}/{formatPercent(provider.capacity)}
              {burn && burn.perHour > 0 ? ` · −${formatRate(burn.perHour * 24)}/day` : ""}
            </span>
          </span>
        );
      })}
    </span>
  );
}

/** Percent left per provider at `t`: recorded samples before now, the projection after. */
function valuesAt(model: PoolModel, t: number): ReadonlyArray<number> | null {
  if (t < model.now) {
    const sample = sampleAt(model.samples, t, SAMPLE_GAP_MS);
    if (!sample) return null;
    return model.providers.map((provider) => sample.p[provider.driver]?.[0] ?? 0);
  }
  return model.providers.map(
    (provider) => projectedAt(model.projection, provider.driver, t) ?? provider.left,
  );
}

const TAG_WIDTH = 46;

function PoolChart({ model }: { readonly model: PoolModel }) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const { width } = useElementSize(containerRef);
  const [hover, setHover] = useState<number | null>(null);
  const span = model.end - model.start;
  const xOf = (t: number) => ((t - model.start) / span) * width;
  const nowX = xOf(model.now);

  const days: Array<{ label: string; x: number; today: boolean }> = [];
  for (
    let day = startOfLocalDay(new Date(model.start));
    day.getTime() < model.end;
    day = addLocalDays(day, 1)
  ) {
    const noon = day.getTime() + DAY_MS / 2;
    if (noon < model.start || noon > model.end) continue;
    days.push({
      label: day.toLocaleDateString("en-US", { weekday: "short" }).toUpperCase(),
      x: xOf(noon),
      today: day.getTime() === startOfLocalDay(new Date(model.now)).getTime(),
    });
  }

  const tags: Array<{ key: string; x: number; row: number; text: string; color: string }> = [];
  for (const refill of model.projection.refills) {
    if (refill.at < model.start || refill.at > model.end || refill.amount < 1) continue;
    const x = Math.min(width - TAG_WIDTH / 2, Math.max(TAG_WIDTH / 2, xOf(refill.at)));
    const row = tags.some((tag) => tag.row === 0 && Math.abs(tag.x - x) < TAG_WIDTH + 4) ? 1 : 0;
    tags.push({
      key: `${refill.driver}:${refill.account}:${refill.at}`,
      x,
      row,
      text: `+${formatPercent(refill.amount)}`,
      color: poolColor(refill.driver),
    });
  }

  const hoverValues = hover === null ? null : valuesAt(model, hover);
  const hoverX = hover === null ? 0 : xOf(hover);

  return (
    <div className="mt-2 flex min-h-0 flex-1 flex-col">
      <div
        ref={containerRef}
        data-pool-chart
        className="relative min-h-0 flex-1 cursor-crosshair pt-5"
        onPointerMove={(event) => {
          const rect = event.currentTarget.getBoundingClientRect();
          const fraction = (event.clientX - rect.left) / rect.width;
          setHover(model.start + Math.max(0, Math.min(1, fraction)) * span);
        }}
        onPointerLeave={() => setHover(null)}
      >
        <span
          className="pointer-events-none absolute top-0 -translate-x-1/2 text-3xs tracking-wider text-muted-foreground"
          style={{ left: nowX }}
        >
          NOW
        </span>
        {tags.map((tag) => (
          <span
            key={tag.key}
            className="pointer-events-none absolute -translate-x-1/2 rounded-sm border border-white/10 bg-background/80 px-1 text-3xs leading-4 font-medium tabular-nums"
            style={{ left: tag.x, top: 18 + tag.row * 18, color: tag.color }}
          >
            {tag.text}
          </span>
        ))}
        <DitherCanvas
          className="h-full"
          label={`Pool: ${formatPercent(model.left)} left of ${formatPercent(model.capacity)}`}
          draw={(context, size, color) => drawPool(context, size, color, model)}
        />
        {hover !== null ? (
          <>
            <span
              aria-hidden
              className="pointer-events-none absolute top-5 bottom-0 w-px bg-foreground/50"
              style={{ left: hoverX }}
            />
            <div
              className="pointer-events-none absolute top-6 z-10 min-w-36 rounded-md border bg-popover/95 px-2.5 py-2 text-xs text-popover-foreground shadow-lg backdrop-blur-sm"
              style={hoverX > width * 0.6 ? { right: width - hoverX + 8 } : { left: hoverX + 8 }}
            >
              <div className="mb-1 flex items-baseline justify-between gap-3">
                <span className="font-medium tabular-nums">{WEEKDAY_TIME.format(hover)}</span>
                <span className="text-3xs tracking-wider text-muted-foreground uppercase">
                  {hover < model.now ? "recorded" : "projected"}
                </span>
              </div>
              {hoverValues === null ? (
                <span className="text-muted-foreground">No history recorded here yet.</span>
              ) : (
                model.providers.map((provider, index) => {
                  const value = hoverValues[index] ?? 0;
                  return (
                    <div
                      key={provider.driver}
                      className="flex items-baseline justify-between gap-4 tabular-nums"
                    >
                      <span className="inline-flex items-baseline gap-1.5">
                        <span
                          aria-hidden
                          className="size-2 self-center rounded-xs"
                          style={{ background: poolColor(provider.driver) }}
                        />
                        {poolLabel(provider.driver)}
                      </span>
                      <span className={cn(value < 0.5 && "text-warning")}>
                        {value < 0.5 ? "empty" : `${formatPercent(value)} left`}
                      </span>
                    </div>
                  );
                })
              )}
            </div>
          </>
        ) : null}
      </div>
      <div className="relative mt-1.5 h-3 text-3xs tracking-wider text-muted-foreground">
        {days.map((day) => (
          <span
            key={`${day.label}:${day.x}`}
            className={cn("absolute -translate-x-1/2", day.today && "text-foreground/80")}
            style={{ left: day.x }}
          >
            {day.label}
          </span>
        ))}
      </div>
    </div>
  );
}

function drawPool(
  context: CanvasRenderingContext2D,
  { width, height }: { readonly width: number; readonly height: number },
  color: (css: string) => string,
  model: PoolModel,
) {
  const cell = 3;
  const span = model.end - model.start;
  const xOf = (t: number) => ((t - model.start) / span) * width;
  const rows = Math.floor(height / cell);
  const columns = Math.floor(width / cell);
  const scale = Math.max(1, model.capacity);

  for (const band of model.projection.bands) {
    const from = Math.max(model.start, band.from);
    const to = Math.min(model.end, band.to ?? model.end);
    if (to <= from) continue;
    context.fillStyle = color(`color-mix(in oklab, ${poolColor(band.driver)} 15%, transparent)`);
    context.fillRect(Math.round(xOf(from)), 0, Math.round(xOf(to) - xOf(from)), rows * cell);
  }

  const grid = color(FAINT);
  for (const share of [0.5]) {
    drawDottedLine(
      context,
      [0, Math.round(rows * cell * (1 - share))],
      [width, Math.round(rows * cell * (1 - share))],
      grid,
      6,
      1,
    );
  }
  context.fillStyle = color("color-mix(in oklab, var(--foreground) 14%, transparent)");
  context.fillRect(0, rows * cell - 1, width, 1);

  const palette = model.providers.map((provider) => ({
    fill: color(poolColor(provider.driver)),
    crest: color(`color-mix(in oklab, ${poolColor(provider.driver)} 70%, white)`),
  }));
  for (let column = 0; column < columns; column += 1) {
    const t = model.start + ((column * cell + cell / 2) / width) * span;
    const values = valuesAt(model, t);
    if (!values) continue;
    const past = t < model.now;
    let stacked = 0;
    values.forEach((value, index) => {
      if (value <= 0) return;
      const low = stacked;
      stacked += value;
      const top = rows - Math.round((Math.min(scale, stacked) / scale) * rows);
      const bottom = rows - Math.round((Math.min(scale, low) / scale) * rows);
      const segment = Math.max(1, bottom - top);
      for (let row = top; row < bottom; row += 1) {
        const depth = (row - top) / segment;
        const crest = row - top < 2;
        const density = crest ? 1 : past ? 0.78 - 0.3 * depth : 0.46 - 0.34 * depth;
        if (density <= bayer(column, row)) continue;
        context.fillStyle = crest ? palette[index]!.crest : palette[index]!.fill;
        context.fillRect(column * cell, row * cell, cell - 1, cell - 1);
      }
    });
  }

  const nowX = Math.round(xOf(model.now));
  drawDottedLine(
    context,
    [nowX, 0],
    [nowX, rows * cell],
    color("color-mix(in oklab, var(--foreground) 55%, transparent)"),
    3,
    1,
  );
}
