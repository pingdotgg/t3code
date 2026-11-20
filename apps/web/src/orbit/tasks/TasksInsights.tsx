import {
  formatInsightValue,
  INSIGHTS,
  insightChangeTone,
  insightResults,
  insightTrend,
  type InsightId,
  type InsightResult,
  type InsightSpec,
  type OrbitTaskInsights,
  type OrbitTaskInsightsPeriod,
  type OrbitTasksResult,
  type TrendPoint,
} from "@t3tools/client-runtime/orbit-gateway";
import { msg, useGT, useMessages } from "gt-react";
import { TrendingDownIcon, TrendingUpIcon, XIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { Button } from "~/components/ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { m } from "~/i18n/messages";
import { observeResize } from "~/lib/observeResize";
import { cn } from "~/lib/utils";

import { Sparkline, TrendChart } from "./InsightCharts";
import { loadOrbitTasksClient } from "./orbitTasksClient";
import { insightByProvider, insightProviderName } from "./tasksInsights.logic";
import { useTasksBoardSettings } from "./tasksPanelStore";

const FADE_PX = 32;

/** Sets each edge fade's strength on the section: full once 32px of content is hidden on that side. */
function updateFades(scroller: HTMLElement) {
  const reach = scroller.scrollWidth - scroller.clientWidth;
  const section = scroller.parentElement;
  if (!section) return;
  section.style.setProperty("--fade-start", String(Math.min(1, scroller.scrollLeft / FADE_PX)));
  section.style.setProperty(
    "--fade-end",
    String(Math.min(1, Math.max(0, reach - scroller.scrollLeft - 1) / FADE_PX)),
  );
}

/** Keeps the fades right when the strip or its content resizes (ref callback: returns its cleanup). */
function watchFades(scroller: HTMLDivElement | null) {
  if (!scroller) return;
  updateFades(scroller);
  return observeResize(
    scroller.firstElementChild ? [scroller, scroller.firstElementChild] : scroller,
    () => updateFades(scroller),
  );
}

/** Orbit's numbers move slowly; the strip re-reads every few minutes, like Orbit's own board. */
const INSIGHTS_POLL_MS = 300_000;

type InsightsState = { readonly status: "loading" } | OrbitTasksResult<OrbitTaskInsights>;

function useOrbitTaskInsights(period: OrbitTaskInsightsPeriod, project: number | null) {
  const [state, setState] = useState<InsightsState>({ status: "loading" });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads Orbit's insights for the board's period and Project, and re-reads on a slow poll
  useEffect(() => {
    let disposed = false;
    const read = () =>
      void loadOrbitTasksClient().then(async (client) => {
        const value: InsightsState = client
          ? await client.getTaskInsights(project === null ? { period } : { period, project })
          : { status: "error", reason: "unreachable", message: m(msg("No Orbit Gateway here.")) };
        // A failed re-read turns the numbers into dashes; stale numbers would read as current.
        if (!disposed) setState(value);
      });
    read();
    const timer = window.setInterval(read, INSIGHTS_POLL_MS);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [period, project]);
  // A new period or Project keeps the previous numbers on screen until Orbit answers, then replaces
  // them; dashes in between would flash the tiles empty.
  return state;
}

/**
 * Two rows whatever the panel's width, the last cell spanning the gap on an odd count. Cells keep
 * a readable width; a narrow panel scrolls the strip sideways instead of adding rows.
 */
function insightGrid(count: number) {
  const columns = count <= 2 ? 3 : Math.ceil(count / 2);
  const rows = count <= 2 ? 1 : 2;
  return {
    columns,
    rows,
    gridTemplateColumns: `repeat(${columns}, minmax(10rem, 1fr))`,
    lastSpan: rows === 2 ? columns * 2 - count + 1 : 1,
  };
}

/**
 * Card style: only the group's four outer corners are round (12px, like the lanes); a corner that faces another
 * block (beside or below) is square. Order: top-left, top-right, bottom-right, bottom-left.
 */
function blockRadius(
  grid: { columns: number; rows: number; lastSpan: number },
  index: number,
  count: number,
) {
  const row = Math.floor(index / grid.columns);
  const start = index % grid.columns;
  const end = start + (index === count - 1 ? grid.lastSpan : 1);
  const full = "12px";
  const half = "0px";
  const top = row === 0;
  const bottom = row === grid.rows - 1;
  // One row of one or two numbers keeps three columns; its last block is still the right edge.
  const right = end === grid.columns || (grid.rows === 1 && index === count - 1);
  return [top && start === 0, top && right, bottom && right, bottom && start === 0]
    .map((outer) => (outer ? full : half))
    .join(" ");
}

/**
 * A number's block: the card fill, no border. The border stays transparent so sizes do not change;
 * only the top row shows its lighter top edge (INSIGHT_TOP_EDGE).
 */
const INSIGHT_BLOCK =
  "border border-transparent! bg-(--shell-card) px-3 pt-2.5 pb-2 dark:bg-(--shell-highlight)/70";
const INSIGHT_TOP_EDGE = "border-t-(--shell-card-edge)!";

/** The overall line in the expanded chart; per-provider lines need a per-provider history. */
const TREND_COLOR = "var(--info)";

function InsightChange(props: { spec: InsightSpec; result: InsightResult }) {
  const gt = useGT();
  const { change, value } = props.result;
  if (value === null) return null;
  const tone = insightChangeTone(props.spec, change);
  const Trend = change !== null && change < 0 ? TrendingDownIcon : TrendingUpIcon;
  return (
    <span
      className={cn(
        "flex shrink-0 items-baseline gap-1 text-ui tabular-nums",
        tone === "good"
          ? "text-success-foreground"
          : tone === "bad"
            ? "text-destructive-foreground"
            : "text-muted-foreground",
      )}
    >
      {change === null ? (
        <span className="text-muted-foreground/70">{gt("No earlier data")}</span>
      ) : (
        <>
          {change === 0 ? null : <Trend aria-hidden className="size-3.5 shrink-0 self-center" />}
          {change > 0 ? "+" : change < 0 ? "−" : "±"}
          {Math.abs(change)}
          {props.spec.unit === "pts"
            ? ` ${gt("pts", { $context: "share points" })}`
            : props.spec.unit}
        </>
      )}
    </span>
  );
}

/** What each number means, with the parts Orbit does not report yet. */
function useInsightHint() {
  const gt = useGT();
  return (id: InsightId, insights: OrbitTaskInsights | null) => {
    switch (id) {
      case "completed":
        return insights?.period === "24h"
          ? gt(
              "Tasks that merged in the period. The line counts the merges in the hours up to each point.",
            )
          : gt(
              "Tasks that merged in the period. The line counts the merges in the days up to each point.",
            );
      case "spent":
        return gt(
          "All agent tokens of the tasks that ended, replaced threads included. More tasks spend more, so a change is neither good nor bad.",
        );
      case "tokens":
        return gt(
          "All agent tokens of ended tasks, divided by the tasks that merged (one task, one PR). The line shows each week.",
        );
      case "wasted":
        return gt(
          "Share of tokens spent on tasks that did not merge and on implementer threads that were replaced.",
        );
      case "delivery":
        return insights?.current.deliveryTimeMs != null
          ? gt("Median time from ready to deployed.")
          : gt(
              "Median time from ready to merged. Once Orbit records deploys per task, this runs to deployed.",
            );
      case "firstPass":
        return gt("Merged tasks that needed no fixup subtask.");
      case "mergeWait":
        return insights?.current.prMergeWaitMs != null
          ? gt("Median time from PR opened to merged: CI, review and fixups.")
          : gt("Median time from PR opened to merged. Orbit does not report it yet.");
      case "reviewRounds":
        return gt("Mean review verdicts per reviewed subtask.");
    }
  };
}

function InsightCard(props: {
  spec: InsightSpec;
  label: string;
  result: InsightResult;
  trend: ReadonlyArray<TrendPoint> | null;
  hint: string;
  scope: string;
  onExpand: () => void;
  /** Columns this cell spans, for the last cell on an odd count. */
  span: number;
  /** Each corner's radius; a corner that faces another block is square. */
  radius: string;
  topRow: boolean;
}) {
  const gt = useGT();
  const messages = useMessages();
  const { spec, result } = props;
  const value = result.value === null ? null : formatInsightValue(spec.id, result.value, messages);
  return (
    <Tooltip>
      <TooltipTrigger
        delay={400}
        render={
          <button
            type="button"
            onClick={props.onExpand}
            style={{
              borderRadius: props.radius,
              ...(props.span > 1 ? { gridColumn: `span ${props.span}` } : {}),
            }}
            aria-label={gt("{label}: {value}. Show chart", {
              label: props.label,
              value: value ?? gt("not reported"),
            })}
            className={cn(
              "flex min-w-0 cursor-pointer flex-col gap-1 text-left transition-colors outline-none hover:bg-(--shell-card)/70 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset dark:hover:bg-(--shell-highlight)",
              INSIGHT_BLOCK,
              props.topRow && INSIGHT_TOP_EDGE,
            )}
          />
        }
      >
        <span className="truncate text-ui text-muted-foreground">{props.label}</span>
        <span className="flex min-w-0 items-baseline gap-2">
          <span
            className={cn(
              "text-lg leading-6 font-medium whitespace-nowrap tabular-nums",
              value === null ? "text-muted-foreground/60" : "text-foreground",
            )}
          >
            {value ?? "–"}
          </span>
          <InsightChange spec={spec} result={result} />
        </span>
        <Sparkline points={props.trend ?? []} className="mt-1" />
      </TooltipTrigger>
      <TooltipPopup side="bottom" className="max-w-64">
        {props.hint} {props.scope}
      </TooltipPopup>
    </Tooltip>
  );
}

/**
 * One insight at full width in the grid's own box: the number where its card had it, the chart
 * below, and each provider's value. The box keeps the grid's height, so nothing below moves.
 */
function InsightDetail(props: {
  spec: InsightSpec;
  label: string;
  result: InsightResult;
  insights: OrbitTaskInsights | null;
  height: number;
  onBack: () => void;
}) {
  const gt = useGT();
  const messages = useMessages();
  const { spec } = props;
  const format = (value: number) => formatInsightValue(spec.id, value, messages);
  const trend = insightTrend(props.insights, spec.id);
  const providers = insightByProvider(props.insights, spec.id);
  // Each provider's number for the period. No colour key: the chart has one line until Orbit
  // reports each provider's history.
  const legend = providers.map((entry) => (
    <li key={entry.provider} className="flex items-baseline gap-1.5 whitespace-nowrap">
      <span className="text-foreground">{insightProviderName(entry.provider)}</span>
      <span className="text-muted-foreground tabular-nums">
        {entry.value === null ? "–" : format(entry.value)}
      </span>
    </li>
  ));
  return (
    <div
      className={cn("relative flex flex-col gap-1 rounded-xl", INSIGHT_BLOCK, INSIGHT_TOP_EDGE)}
      style={{ height: props.height }}
      onKeyDown={(event) => {
        if (event.key === "Escape") props.onBack();
      }}
    >
      <Button
        autoFocus
        size="icon-xs"
        variant="ghost"
        aria-label={gt("Close {label} chart", { label: props.label })}
        onClick={props.onBack}
        className="absolute top-1 right-1"
      >
        <XIcon className="size-4" />
      </Button>
      <span className="truncate pe-8 text-ui text-muted-foreground">{props.label}</span>
      <span className="flex min-w-0 items-baseline gap-2">
        <span className="text-lg leading-6 font-medium text-foreground tabular-nums">
          {props.result.value === null ? "–" : format(props.result.value)}
        </span>
        <InsightChange spec={spec} result={props.result} />
        {/* Beside the number when the panel is wide; under the chart when it is narrow. */}
        <ul className="ms-auto hidden list-none items-center gap-x-5 p-0 text-ui @xl:flex">
          {legend}
        </ul>
      </span>
      <div className="mt-5 min-h-0 flex-1">
        {trend ? (
          <TrendChart
            series={[{ name: gt("All providers"), color: TREND_COLOR, points: trend }]}
            format={format}
            label={gt("{label} over the period", { label: props.label })}
            total={{ label: gt("Total"), points: trend }}
          />
        ) : (
          <p className="m-0 flex h-full items-center justify-center text-ui text-muted-foreground">
            {gt("Orbit reports no history for this number yet.")}
          </p>
        )}
      </div>
      <ul className="m-0 flex list-none flex-wrap items-center gap-x-5 gap-y-1 p-0 text-ui @xl:hidden">
        {legend}
      </ul>
    </div>
  );
}

/**
 * The board's insight strip, for the board's Project. Orbit's insights take no search, so a
 * search narrows the lanes but not these numbers; the tooltips say so.
 */
export function TasksInsightsStrip(props: { orbitProjectId: number | null; query: string }) {
  const gt = useGT();
  const messages = useMessages();
  const hint = useInsightHint();
  const hidden = useTasksBoardSettings((state) => state.hiddenInsights);
  const period = useTasksBoardSettings((state) => state.insightPeriod);
  const state = useOrbitTaskInsights(period, props.orbitProjectId);
  const insights = state.status === "ok" ? state.value : null;
  const results = insightResults(insights);
  const shown = INSIGHTS.filter((spec) => !hidden.includes(spec.id));
  const [expanded, setExpanded] = useState<InsightId | null>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const [gridHeight, setGridHeight] = useState(0);
  if (shown.length === 0) return null;
  const open = shown.find((spec) => spec.id === expanded);
  const grid = insightGrid(shown.length);
  const days = period === "7d" ? 7 : 30;
  const periodScope =
    period === "24h"
      ? gt("Last 24 hours against the 24 before.")
      : gt("Last {days} days against the {days} before.", { days });
  const searching = props.query.trim().length > 0;
  const scope =
    state.status === "error"
      ? gt("Orbit did not answer: {message}", { message: state.message })
      : [periodScope, searching ? gt("The search does not narrow these numbers.") : null]
          .filter((part) => part !== null)
          .join(" ");
  return (
    <section
      aria-label={
        period === "24h"
          ? gt("Task insights, last 24 hours")
          : gt("Task insights, last {days} days", { days })
      }
      className="@container relative shrink-0 [--fade-end:0] [--fade-start:0]"
    >
      {/* No scrollbar: the edges fade out while there is more to scroll to. */}
      <div
        ref={(scroller) => watchFades(scroller)}
        onScroll={(event) => updateFades(event.currentTarget)}
        className="overflow-x-auto overflow-y-hidden px-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        {open ? (
          <InsightDetail
            spec={open}
            label={messages(open.label)}
            result={results[open.id]}
            insights={insights}
            // The chart takes the grid's height, so nothing below moves; one row of cards is too short.
            height={Math.max(gridHeight, 168)}
            onBack={() => setExpanded(null)}
          />
        ) : (
          <div
            ref={gridRef}
            className="grid min-w-min gap-0.5"
            style={{ gridTemplateColumns: grid.gridTemplateColumns }}
          >
            {shown.map((spec, index) => (
              <InsightCard
                key={spec.id}
                spec={spec}
                label={messages(spec.label)}
                result={results[spec.id]}
                trend={insightTrend(insights, spec.id)}
                hint={hint(spec.id, insights)}
                scope={scope}
                span={index === shown.length - 1 ? grid.lastSpan : 1}
                radius={blockRadius(grid, index, shown.length)}
                topRow={Math.floor(index / grid.columns) === 0}
                onExpand={() => {
                  setGridHeight(gridRef.current?.offsetHeight ?? 0);
                  setExpanded(spec.id);
                }}
              />
            ))}
          </div>
        )}
      </div>
      <div
        aria-hidden
        className="pointer-events-none absolute inset-y-0 bottom-px left-0 w-8 bg-linear-to-r from-background to-transparent opacity-(--fade-start)"
      />
      <div
        aria-hidden
        className="pointer-events-none absolute inset-y-0 bottom-px right-0 w-8 bg-linear-to-l from-background to-transparent opacity-(--fade-end)"
      />
    </section>
  );
}
