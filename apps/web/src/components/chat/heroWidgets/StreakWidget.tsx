import { formatTokens } from "@t3tools/shared/usageFormat";
import type { DailyTotals } from "@t3tools/shared/usageMerge";
import { FlameIcon } from "lucide-react";
import { useRef, useState, type ReactNode } from "react";

import { cn } from "~/lib/utils";

import { Text } from "../../ui/text";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../../ui/tooltip";
import { DitherCanvas, type ResolveColor } from "./DitherCanvas";
import { drawDitherField } from "./dither";
import { buildStreak, DEFAULT_TOKEN_GOAL, type StreakDay } from "./heroWidgets.logic";
import {
  GHOST,
  HeadlineFigure,
  MONTH_DAY,
  useDebugValue,
  useElementSize,
  WidgetCard,
} from "./widgetChrome";

export const STREAK_SPAN_DAYS = 371;
/** Usage history keeps 92 days by default, so a few more weeks than that is all that can fill. */
const MAX_WEEKS = 18;
/** The widgets' dither lattice: 2px dots on a 3px pitch. */
const DOT = 3;
/** Days sit one dark dot column apart, so the lattice runs unbroken across the grid. */
const GAP = DOT + 1;
const LABEL_WIDTH = 26;
const MONTH_ROW = 14;
const MONTH = new Intl.DateTimeFormat("en-US", { month: "short" });
const DAY = new Intl.DateTimeFormat("en-US", { weekday: "short", month: "short", day: "numeric" });

const HEAT = ["#3b4f9e", "#4f68d8", "#6f8fff", "#a3b8ff"] as const;
const MISSED = "color-mix(in oklab, var(--warning) 75%, transparent)";
/** Unlit dots of a tracked day, so its square still reads at low density. */
const UNLIT = "color-mix(in oklab, var(--foreground) 11%, transparent)";
const NO_DATA = "color-mix(in oklab, var(--foreground) 7%, transparent)";

export function StreakWidget({
  now,
  daily,
  pending,
}: {
  readonly now: number;
  readonly daily: ReadonlyArray<DailyTotals>;
  readonly pending: boolean;
}) {
  const goal = DEFAULT_TOKEN_GOAL;
  const streak = buildStreak(
    new Date(now),
    new Map(daily.map((day) => [day.day, day.totalTokens])),
    goal,
    STREAK_SPAN_DAYS,
  );
  const toGo = Math.max(0, goal - streak.todayTokens);
  const progress = Math.min(1, streak.todayTokens / goal);
  useDebugValue("streak", {
    current: streak.current,
    best: streak.best,
    bestRun: streak.bestRun,
    today: streak.todayTokens,
    bestDay: streak.bestDay,
    medianDay: streak.medianDay,
    trackedDays: streak.trackedDays,
    metDays: streak.metDays,
    firstTracked: streak.firstTrackedKey,
    dailyDays: daily.length,
  });

  return (
    <WidgetCard
      id="streak"
      icon={FlameIcon}
      title="Streak"
      meta={`goal ${formatTokens(goal)} tokens a day`}
      className="[container:streak/size]"
    >
      {daily.length === 0 ? (
        <p className="mt-3 text-meta text-muted-foreground">
          {pending ? "Reading usage history…" : "No usage recorded yet."}
        </p>
      ) : (
        <>
          <div className="mt-2.5 flex items-baseline gap-2 leading-none [@container_streak_(height<12rem)]:mt-1.5">
            <HeadlineFigure>{streak.current}</HeadlineFigure>
            <span className="text-body text-muted-foreground">
              day{streak.current === 1 ? "" : "s"} streak
            </span>
            <span className="ms-auto text-body tabular-nums">
              <span className="text-muted-foreground">best </span>
              <span className="text-label">{streak.best}</span>
              <span className="text-muted-foreground"> days</span>
            </span>
          </div>
          <DitherCanvas
            className="mt-3 h-2.5 [@container_streak_(height<12rem)]:mt-2"
            label={`${formatTokens(streak.todayTokens)} of ${formatTokens(goal)} tokens today`}
            draw={(context, { width, height }, color) => {
              const columns = Math.floor(width / 3);
              drawDitherField(
                context,
                { x: 0, y: 0, width, height },
                (column) => (column < columns * progress ? 1 - (column / columns) * 0.35 : 0),
                color(streak.todayMet ? "var(--success)" : HEAT[2]),
                { ghost: color(GHOST) },
              );
            }}
          />
          <div className="mt-1.5 flex items-baseline gap-1.5 text-meta tabular-nums">
            <Text variant="meta" tone="inherit" emphasis>
              {formatTokens(streak.todayTokens)}
            </Text>
            <span className="text-muted-foreground">of {formatTokens(goal)} today</span>
            <span className="ms-auto text-muted-foreground">
              {streak.todayMet ? (
                <span className="text-success">goal hit, streak extended</span>
              ) : (
                <>
                  <span className="text-warning">{formatTokens(toGo)}</span>
                  {streak.current > 0 ? " to keep the streak" : " to start a streak"}
                </>
              )}
            </span>
          </div>
          <div className="mt-3 flex min-h-0 flex-1 gap-5 [@container_streak_(height<12rem)]:mt-2">
            <Heatmap days={streak.days} goal={goal} />
            <dl className="flex w-40 shrink-0 flex-col justify-center-safe gap-1.5 text-meta tabular-nums [container:streak-stats/size]">
              {streak.bestDay ? (
                <Record label="Best day">
                  {formatTokens(streak.bestDay.tokens)}
                  <span className="text-muted-foreground">
                    {" "}
                    {MONTH_DAY.format(streak.bestDay.date)}
                  </span>
                </Record>
              ) : null}
              {streak.bestRun ? (
                <Record
                  label="Best run"
                  className="[@container_streak-stats_(height<6.82em)]:hidden"
                >
                  {streak.best}d
                  <span className="text-muted-foreground">
                    {" "}
                    to {MONTH_DAY.format(streak.bestRun.to)}
                  </span>
                </Record>
              ) : null}
              <Record label="Median day">{formatTokens(streak.medianDay)}</Record>
              <Record label="Goal hit">
                {streak.metDays}
                <span className="text-muted-foreground"> of {streak.trackedDays} days</span>
              </Record>
              <div className="mt-1 flex items-center gap-2 text-micro text-muted-foreground [@container_streak-stats_(height<8.82em)]:hidden">
                <Swatch kind="met" /> hit
                <Swatch kind="missed" /> missed
                <Swatch kind="noData" /> no data
              </div>
            </dl>
          </div>
        </>
      )}
    </WidgetCard>
  );
}

function Record({
  label,
  className,
  children,
}: {
  readonly label: string;
  readonly className?: string;
  readonly children: ReactNode;
}) {
  return (
    <div className={cn("flex items-baseline justify-between gap-2", className)}>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="truncate">{children}</dd>
    </div>
  );
}

/** A legend key drawn as a three-dot day, in the heatmap's own dither. */
function Swatch({ kind }: { readonly kind: "met" | "missed" | "noData" }) {
  return (
    <DitherCanvas
      className="size-2 shrink-0"
      draw={(context, { width, height }, color) => {
        const rect = { x: 0, y: 0, width, height };
        if (kind === "noData") {
          drawDitherField(context, rect, 0, color(NO_DATA), { cell: DOT, ghost: color(NO_DATA) });
          return;
        }
        drawDitherField(
          context,
          rect,
          kind === "met" ? 0.6 : 0.5,
          color(kind === "met" ? HEAT[2] : MISSED),
          { cell: DOT, ghost: color(UNLIT) },
        );
      }}
    />
  );
}

interface HeatmapGeometry {
  /** Dots along a day's side. */
  readonly dots: number;
  readonly cellSize: number;
  /** From one day's left edge to the next. */
  readonly pitch: number;
  readonly weeks: number;
}

function heatmapGeometry(width: number, height: number): HeatmapGeometry {
  const dots = Math.max(2, Math.floor((height - MONTH_ROW + GAP) / (7 * DOT)) - 1);
  const pitch = (dots + 1) * DOT;
  const weeks = Math.max(1, Math.min(MAX_WEEKS, Math.floor((width - LABEL_WIDTH + GAP) / pitch)));
  return { dots, cellSize: dots * DOT - 1, pitch, weeks };
}

/**
 * One day as a square of dots. Tokens set how many light (Bayer order) and, for goal days, how
 * bright; today below the goal fills from the bottom like a pool pip.
 */
function drawDay(
  context: CanvasRenderingContext2D,
  rect: { readonly x: number; readonly y: number; readonly width: number; readonly height: number },
  day: StreakDay,
  scale: { readonly goal: number; readonly peak: number; readonly dots: number },
  colors: {
    readonly heat: ReadonlyArray<string>;
    readonly missed: string;
    readonly unlit: string;
    readonly noData: string;
  },
) {
  const options = { cell: DOT, ghost: colors.unlit };
  if (day.state === "noData") {
    drawDitherField(context, rect, 0, colors.noData, { cell: DOT, ghost: colors.noData });
    return;
  }
  if (day.state === "missed") {
    // Any shortfall keeps a few amber dots, so a zero day never reads as no data.
    const density = 0.2 + 0.55 * Math.min(1, day.tokens / scale.goal);
    drawDitherField(context, rect, density, colors.missed, options);
    return;
  }
  if (day.state === "today" && day.tokens < scale.goal) {
    const lit = day.tokens > 0 ? Math.max(1, (day.tokens / scale.goal) * scale.dots) : 0;
    const full = Math.floor(lit);
    drawDitherField(
      context,
      rect,
      (_column, row) => {
        const fromBottom = scale.dots - 1 - row;
        return fromBottom < full ? 1 : fromBottom === full ? lit - full : 0;
      },
      colors.heat[1]!,
      options,
    );
    return;
  }
  const intensity = Math.pow(Math.min(1, day.tokens / scale.peak), 0.7);
  drawDitherField(
    context,
    rect,
    0.4 + 0.6 * intensity,
    colors.heat[Math.min(3, Math.floor(intensity * 4))]!,
    options,
  );
}

function Heatmap({
  days,
  goal,
}: {
  readonly days: ReadonlyArray<StreakDay>;
  readonly goal: number;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const { width, height } = useElementSize(ref);
  const geometry = heatmapGeometry(width, height);
  const { dots, cellSize, pitch, weeks } = geometry;
  const today = days.at(-1)!;
  // Columns end with the current week; the oldest column starts on a Sunday.
  const shown = days.slice(-((weeks - 1) * 7 + today.date.getDay() + 1));
  const peak = Math.max(goal, ...shown.map((day) => day.tokens));
  const xOf = (index: number) => LABEL_WIDTH + Math.floor(index / 7) * pitch;
  const yOf = (index: number) => MONTH_ROW + (index % 7) * pitch;
  const months: Array<{ x: number; label: string }> = [];
  shown.forEach((day, index) => {
    if (index % 7 !== 0) return;
    const label = MONTH.format(day.date);
    const x = xOf(index);
    if (months.at(-1)?.label === label) return;
    if (months.length > 0 && x - months.at(-1)!.x < 28) months.pop();
    months.push({ x, label });
  });
  const gridWidth = LABEL_WIDTH + weeks * pitch - GAP;

  return (
    <div ref={ref} className="relative min-h-19 min-w-0 flex-1">
      <div className="absolute inset-y-0 left-0" style={{ width: gridWidth }}>
        {months.map((month) => (
          <span
            key={`${month.label}:${month.x}`}
            className="absolute top-0 text-micro leading-none text-muted-foreground"
            style={{ left: month.x }}
          >
            {month.label}
          </span>
        ))}
        {["Mon", "Wed", "Fri"].map((label, index) => (
          <span
            key={label}
            className="absolute left-0 text-micro leading-none text-muted-foreground"
            style={{ top: MONTH_ROW + (index * 2 + 1) * pitch + cellSize / 2 - 4 }}
          >
            {label}
          </span>
        ))}
        <DitherCanvas
          className="absolute inset-0 h-full"
          label={`Daily tokens over the last ${weeks} weeks`}
          draw={(context, _size, color) => {
            const colors = heatmapColors(color);
            shown.forEach((day, index) => {
              const x = xOf(index);
              const y = yOf(index);
              drawDay(
                context,
                { x, y, width: cellSize, height: cellSize },
                day,
                { goal, peak, dots },
                colors,
              );
              if (day.state === "today") {
                context.strokeStyle = color("var(--foreground)");
                context.lineWidth = 1;
                context.strokeRect(x - 1.5, y - 1.5, cellSize + 3, cellSize + 3);
              }
            });
          }}
        />
        <HeatmapHover shown={shown} goal={goal} geometry={geometry} xOf={xOf} yOf={yOf} />
      </div>
    </div>
  );
}

function heatmapColors(color: ResolveColor) {
  return {
    heat: HEAT.map((value) => color(value)),
    missed: color(MISSED),
    unlit: color(UNLIT),
    noData: color(NO_DATA),
  };
}

function daySummary(day: StreakDay, goal: number): string {
  const tokens = `${formatTokens(day.tokens)} tokens`;
  switch (day.state) {
    case "noData":
      return "Before usage tracking";
    case "missed":
      return `${tokens}, goal missed`;
    case "met":
      return `${tokens}, goal hit`;
    case "today":
      return day.tokens >= goal
        ? `${tokens} so far, goal hit`
        : `${tokens} so far, ${formatTokens(goal - day.tokens)} to go`;
  }
}

/** The hovered day's tooltip; kept apart so hovering never repaints the canvas. */
function HeatmapHover({
  shown,
  goal,
  geometry,
  xOf,
  yOf,
}: {
  readonly shown: ReadonlyArray<StreakDay>;
  readonly goal: number;
  readonly geometry: HeatmapGeometry;
  readonly xOf: (index: number) => number;
  readonly yOf: (index: number) => number;
}) {
  const [hovered, setHovered] = useState<number | null>(null);
  const [anchor, setAnchor] = useState<HTMLSpanElement | null>(null);
  const day = hovered === null ? undefined : shown[hovered];

  return (
    <Tooltip open={day !== undefined && anchor !== null}>
      <TooltipTrigger
        render={
          <div
            className="absolute inset-0"
            onPointerMove={(event) => {
              const rect = event.currentTarget.getBoundingClientRect();
              const x = event.clientX - rect.left - LABEL_WIDTH;
              const y = event.clientY - rect.top - MONTH_ROW;
              const column = Math.floor(x / geometry.pitch);
              const row = Math.floor(y / geometry.pitch);
              const index = column * 7 + row;
              setHovered(x >= 0 && y >= 0 && row < 7 && index < shown.length ? index : null);
            }}
            onPointerLeave={() => setHovered(null)}
          />
        }
      />
      {day === undefined || hovered === null ? null : (
        <span
          key={hovered}
          ref={setAnchor}
          aria-hidden
          className="pointer-events-none absolute ring-1 ring-foreground/45 ring-inset"
          // Where today's outline sits: two pixels out, inside the gap between days.
          style={{
            left: xOf(hovered) - 2,
            top: yOf(hovered) - 2,
            width: geometry.cellSize + 4,
            height: geometry.cellSize + 4,
          }}
        />
      )}
      {day === undefined ? null : (
        <TooltipPopup anchor={anchor}>
          <div className="tabular-nums">
            <div>{day.state === "today" ? "Today" : DAY.format(day.date)}</div>
            <div className="text-muted-foreground">{daySummary(day, goal)}</div>
          </div>
        </TooltipPopup>
      )}
    </Tooltip>
  );
}
