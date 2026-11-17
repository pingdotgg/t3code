import { formatTokens } from "@t3tools/shared/usageFormat";
import type { DailyTotals } from "@t3tools/shared/usageMerge";
import { FlameIcon } from "lucide-react";
import { useRef, type ReactNode } from "react";

import { DitherCanvas } from "./DitherCanvas";
import { drawDitherField } from "./dither";
import { buildStreak, DEFAULT_TOKEN_GOAL, type StreakDay } from "./heroWidgets.logic";
import { GHOST, MONTH_DAY, useDebugValue, useElementSize, WidgetCard } from "./widgetChrome";

export const STREAK_SPAN_DAYS = 371;
/** Usage history keeps 92 days by default, so a few more weeks than that is all that can fill. */
const MAX_WEEKS = 18;
const GAP = 3;
const LABEL_WIDTH = 26;
const MONTH_ROW = 14;
const MONTH = new Intl.DateTimeFormat("en-US", { month: "short" });

const HEAT = ["#3b4f9e", "#4f68d8", "#6f8fff", "#a3b8ff"] as const;
const MISSED = "color-mix(in oklab, var(--warning) 45%, transparent)";
const NO_DATA = "color-mix(in oklab, var(--foreground) 5%, transparent)";

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
    >
      {daily.length === 0 ? (
        <p className="mt-3 text-xs text-muted-foreground">
          {pending ? "Reading usage history…" : "No usage recorded yet."}
        </p>
      ) : (
        <>
          <div className="mt-2.5 flex items-baseline gap-2 leading-none">
            <span className="text-3xl font-semibold tracking-tight tabular-nums">
              {streak.current}
            </span>
            <span className="text-sm text-muted-foreground">
              day{streak.current === 1 ? "" : "s"} streak
            </span>
            <span className="ms-auto text-sm tabular-nums">
              <span className="text-muted-foreground">best </span>
              <span className="font-medium">{streak.best}</span>
              <span className="text-muted-foreground"> days</span>
            </span>
          </div>
          <DitherCanvas
            className="mt-3 h-2.5"
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
          <div className="mt-1.5 flex items-baseline gap-1.5 text-xs tabular-nums">
            <span className="font-medium">{formatTokens(streak.todayTokens)}</span>
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
          <div className="mt-3 flex min-h-0 flex-1 gap-5">
            <Heatmap days={streak.days} goal={goal} />
            <dl className="flex w-40 shrink-0 flex-col justify-center gap-1.5 text-xs tabular-nums">
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
                <Record label="Best run">
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
              <div className="mt-1 flex items-center gap-2 text-3xs text-muted-foreground">
                <Swatch color={HEAT[2]} /> hit
                <Swatch color={MISSED} /> missed
                <Swatch color={NO_DATA} /> no data
              </div>
            </dl>
          </div>
        </>
      )}
    </WidgetCard>
  );
}

function Record({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="truncate">{children}</dd>
    </div>
  );
}

function Swatch({ color }: { readonly color: string }) {
  return (
    <span aria-hidden className="inline-block size-2 rounded-xs" style={{ background: color }} />
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
  const cellSize = Math.max(6, Math.floor((height - MONTH_ROW - GAP * 6) / 7));
  const weeks = Math.max(
    1,
    Math.min(MAX_WEEKS, Math.floor((width - LABEL_WIDTH + GAP) / (cellSize + GAP))),
  );
  const today = days.at(-1)!;
  // Columns end with the current week; the oldest column starts on a Sunday.
  const shown = days.slice(-((weeks - 1) * 7 + today.date.getDay() + 1));
  const peak = Math.max(goal, ...shown.map((day) => day.tokens));
  const columnOf = (index: number) => Math.floor(index / 7);
  const xOf = (index: number) => LABEL_WIDTH + columnOf(index) * (cellSize + GAP);
  const months: Array<{ x: number; label: string }> = [];
  shown.forEach((day, index) => {
    if (index % 7 !== 0) return;
    const label = MONTH.format(day.date);
    const x = xOf(index);
    if (months.at(-1)?.label === label) return;
    if (months.length > 0 && x - months.at(-1)!.x < 28) months.pop();
    months.push({ x, label });
  });
  const gridWidth = LABEL_WIDTH + weeks * (cellSize + GAP) - GAP;

  return (
    <div ref={ref} className="relative min-h-20 min-w-0 flex-1">
      <div className="absolute inset-y-0 left-0" style={{ width: gridWidth }}>
        {months.map((month) => (
          <span
            key={`${month.label}:${month.x}`}
            className="absolute top-0 text-3xs leading-none text-muted-foreground"
            style={{ left: month.x }}
          >
            {month.label}
          </span>
        ))}
        {["Mon", "Wed", "Fri"].map((label, index) => (
          <span
            key={label}
            className="absolute left-0 text-3xs leading-none text-muted-foreground"
            style={{ top: MONTH_ROW + (index * 2 + 1) * (cellSize + GAP) + cellSize / 2 - 4 }}
          >
            {label}
          </span>
        ))}
        <DitherCanvas
          className="absolute inset-0 h-full"
          label={`Daily tokens over the last ${weeks} weeks`}
          draw={(context, _size, color) => {
            const ghost = color(GHOST);
            const faint = color(NO_DATA);
            const missed = color(MISSED);
            const heat = HEAT.map((value) => color(value));
            shown.forEach((day, index) => {
              const x = xOf(index);
              const y = MONTH_ROW + (index % 7) * (cellSize + GAP);
              const rect = { x, y, width: cellSize, height: cellSize };
              if (day.state === "noData") {
                context.fillStyle = faint;
                context.fillRect(x, y, cellSize, cellSize);
                return;
              }
              if (day.state === "missed") {
                context.fillStyle = missed;
                context.fillRect(x, y, cellSize, cellSize);
                drawDitherField(context, rect, 0.5, ghost, { cell: 2 });
                return;
              }
              const isToday = day.state === "today";
              const intensity = Math.pow(Math.min(1, day.tokens / peak), 0.7);
              if (isToday && day.tokens < goal) {
                // Today fills from the bottom toward the goal.
                context.fillStyle = ghost;
                context.fillRect(x, y, cellSize, cellSize);
                const filled = Math.round(cellSize * Math.min(1, day.tokens / goal));
                context.fillStyle = heat[1]!;
                context.fillRect(x, y + cellSize - filled, cellSize, filled);
              } else {
                const level = Math.min(3, Math.floor(intensity * 4));
                context.fillStyle = heat[level]!;
                context.fillRect(x, y, cellSize, cellSize);
                drawDitherField(context, rect, 0.35 - intensity * 0.3, ghost, { cell: 2 });
              }
              if (isToday) {
                context.strokeStyle = color("var(--foreground)");
                context.lineWidth = 1;
                context.strokeRect(x - 1.5, y - 1.5, cellSize + 3, cellSize + 3);
              }
            });
          }}
        />
      </div>
    </div>
  );
}
