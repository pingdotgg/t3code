import type { ThreadStructureTurnItem } from "@t3tools/client-runtime/state/models";
import {
  listThreadTurnTokenUsageByRun,
  summarizeThreadTurnTokenUsage,
  threadTurnTokenUsageTotals,
  type ThreadTurnTokenUsageRow,
  type ThreadTurnTokenUsageSummary,
} from "@t3tools/client-runtime/state/thread-turn-token-usage";
import type {
  RunId,
  ScopedThreadRef,
  UsageCostSource,
  UsagePriceItemInput,
  UsagePriceItemResult,
} from "@t3tools/contracts";
import {
  deriveContextOccupancySeries,
  type ContextOccupancySeries,
} from "@t3tools/shared/contextOccupancySeries";
import { formatDuration } from "@t3tools/shared/orchestrationTiming";
import {
  buildCompressedTimingAxis,
  clampTimingViewWindow,
  deriveThreadTimingTrace,
  layoutThreadFlameChart,
  timingViewZoomAt,
  type CompressedTimingAxis,
  type FlameChartNode,
  type ThreadTimingSpan,
  type ThreadTimingTrace,
  type ThreadTimingTurn,
  type TimingSpanKind,
} from "@t3tools/shared/threadTimingTrace";
import { formatTokens, formatUsd } from "@t3tools/shared/usageFormat";
import { ChartNoAxesGantt, Focus, Minus, Plus, Scan } from "lucide-react";
import {
  useId,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from "react";

import { useNowSecond } from "~/hooks/useNowSecond";
import { useStableCallback } from "~/hooks/useStableCallback";
import { cn } from "~/lib/utils";
import { useQuietThreadProjection } from "~/state/entities";
import { useEnvironmentQuery } from "~/state/query";
import { serverEnvironment } from "~/state/server";
import { Button } from "./ui/button";
import { ScrollArea } from "./ui/scroll-area";
import { tokenTypeSegments } from "./usage/usageBreakdown";
import { UsageShareBar, type ShareSegment } from "./usage/UsageShareBar";

const SPAN_BAR_CLASS: Record<TimingSpanKind, string> = {
  queue: "border-border/60 bg-foreground/10 text-foreground",
  reasoning: "border-border/60 bg-foreground/35 text-foreground",
  assistant: "border-black/10 bg-foreground/70 text-background",
  tool: "border-black/10 bg-foreground/85 text-background",
  subagent: "border-black/10 bg-foreground/85 text-background",
  wait: "border-black/10 bg-warning text-black",
  other: "border-border/60 bg-foreground/20 text-foreground",
};

const TURN_ROW_HEIGHT = 28;
const SPAN_ROW_HEIGHT = 20;
const ROW_GAP = 2;
const RULER_HEIGHT = 22;
const MIN_VIEW_MS = 50;

/**
 * Paper-tear silhouettes (viewBox 0 0 100 200).
 * Flaps stay inside the idle gap: jagged edges face the void, never into turns.
 * Void is punched through the chart paper to the page background.
 */
const PAPER_TEAR_LEFT_FLAP =
  "M0 0 L22 0 L14 9 L24 18 L11 29 L26 41 L13 52 L25 64 L10 75 L23 87 L12 99 L27 111 L14 122 L24 134 L11 145 L26 157 L13 168 L25 180 L15 191 L22 200 L0 200 Z";
const PAPER_TEAR_RIGHT_FLAP =
  "M100 0 L78 0 L86 9 L76 18 L89 29 L74 41 L87 52 L75 64 L90 75 L77 87 L88 99 L73 111 L86 122 L76 134 L89 145 L74 157 L87 168 L75 180 L85 191 L78 200 L100 200 Z";
const PAPER_TEAR_LEFT_EDGE =
  "M22 0 L14 9 L24 18 L11 29 L26 41 L13 52 L25 64 L10 75 L23 87 L12 99 L27 111 L14 122 L24 134 L11 145 L26 157 L13 168 L25 180 L15 191 L22 200";
const PAPER_TEAR_RIGHT_EDGE =
  "M78 0 L86 9 L76 18 L89 29 L74 41 L87 52 L75 64 L90 75 L77 87 L88 99 L73 111 L86 122 L76 134 L89 145 L74 157 L87 168 L75 180 L85 191 L78 200";

type Selection =
  | { readonly type: "turn"; readonly runId: ThreadTimingTurn["runId"] }
  | { readonly type: "span"; readonly runId: ThreadTimingTurn["runId"]; readonly spanId: string };

type ViewWindow = {
  readonly startMs: number;
  readonly durationMs: number;
};

type TurnCostEstimate = {
  readonly costUsd: number;
  readonly costSource: UsageCostSource;
  /** True when the priced sum omits turns (partial counts, unpriced, or mixed model). */
  readonly incomplete: boolean;
};

function priceItemsForRows(
  rows: readonly ThreadTurnTokenUsageRow[],
): readonly UsagePriceItemInput[] {
  return rows.flatMap((row) => {
    if (row.priceModel === null) return [];
    const totals = threadTurnTokenUsageTotals(row.usage);
    if (totals === null) return [];
    return [{ id: row.runId, model: row.priceModel, totals }];
  });
}

function measurableTurnCount(rows: readonly ThreadTurnTokenUsageRow[]): number {
  let count = 0;
  for (const row of rows) {
    if (threadTurnTokenUsageTotals(row.usage) !== null) count += 1;
  }
  return count;
}

function costByRunId(
  items: readonly UsagePriceItemResult[] | null,
  rows: readonly ThreadTurnTokenUsageRow[],
): ReadonlyMap<string, TurnCostEstimate> {
  const usageByRun = new Map<string, ThreadTurnTokenUsageRow["usage"]>();
  for (const row of rows) {
    usageByRun.set(row.runId, row.usage);
  }
  const map = new Map<string, TurnCostEstimate>();
  for (const item of items ?? []) {
    map.set(item.id, {
      costUsd: item.costUsd,
      costSource: item.costSource,
      incomplete: usageByRun.get(item.id)?.usageStatus === "partial",
    });
  }
  return map;
}

/** Sum priced turns only; all-unpriced stays unknown so we never show a fake $0. */
function threadCostEstimate(
  costs: ReadonlyMap<string, TurnCostEstimate>,
  measurableTurns: number,
): TurnCostEstimate | null {
  let costUsd = 0;
  let priced = 0;
  let incomplete = false;
  for (const cost of costs.values()) {
    if (cost.costSource === "unpriced") continue;
    costUsd += cost.costUsd;
    priced += 1;
    if (cost.incomplete) incomplete = true;
  }
  if (priced === 0) return null;
  return {
    costUsd,
    costSource: "modelPriced",
    incomplete: incomplete || priced < measurableTurns,
  };
}

function formatCostEstimate(cost: TurnCostEstimate | null | undefined): string | null {
  if (cost === null || cost === undefined || cost.costSource === "unpriced") return null;
  return cost.incomplete ? `${formatUsd(cost.costUsd)} · partial` : formatUsd(cost.costUsd);
}

/** Right-panel Insights: zoomable flame-chart overview with turn boundaries and drill-down. */
export function InsightsPanel({
  threadRef,
  visible,
}: {
  readonly threadRef: ScopedThreadRef;
  readonly visible: boolean;
}) {
  const projection = useQuietThreadProjection(visible ? threadRef : null);
  const nowMs = useNowSecond();
  const trace =
    projection === null
      ? null
      : deriveThreadTimingTrace({
          runs: projection.projection.runs,
          turnItems: projection.projection.turnItems,
          messages: projection.projection.messages,
          nowMs,
        });
  const tokenUsage =
    projection === null ? null : summarizeThreadTurnTokenUsage(projection.projection.providerTurns);
  const turnRows =
    projection === null
      ? []
      : listThreadTurnTokenUsageByRun({
          runs: projection.projection.runs,
          attempts: projection.projection.attempts,
          providerTurns: projection.projection.providerTurns,
        });
  const priceItems = priceItemsForRows(turnRows);
  const priced = useEnvironmentQuery(
    !visible || priceItems.length === 0
      ? null
      : serverEnvironment.priceUsage({
          environmentId: threadRef.environmentId,
          input: { items: [...priceItems] },
        }),
  );
  const costs = costByRunId(priced.data?.items ?? null, turnRows);
  const threadCost = threadCostEstimate(costs, measurableTurnCount(turnRows));
  const pricingPending = priceItems.length > 0 && priced.isPending && priced.data === null;
  const pricingError =
    priceItems.length > 0 && priced.error !== null && priced.data === null ? priced.error : null;
  const occupancy =
    projection === null
      ? null
      : deriveContextOccupancySeries({
          attempts: projection.projection.attempts,
          providerTurns: projection.projection.providerTurns,
          turnItems: projection.projection.turnItems,
        });
  const costLabel = formatCostEstimate(threadCost);
  const headerBits = [
    trace !== null ? formatDuration(trace.totalMs) : null,
    trace !== null ? `${trace.turns.length} ${trace.turns.length === 1 ? "turn" : "turns"}` : null,
    tokenUsage?.totalTokens != null ? `${formatTokens(tokenUsage.totalTokens)} tokens` : null,
    costLabel,
  ].filter((bit): bit is string => bit !== null);

  return (
    <div className="@container flex h-full min-w-0 flex-col bg-background">
      <div
        className="flex h-10 min-h-10 shrink-0 items-center gap-2 border-b border-border/60 px-3"
        data-surface-subheader
      >
        <ChartNoAxesGantt className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
        <h2 className="shrink-0 text-sm font-medium">Insights</h2>
        {headerBits.length > 0 ? (
          <span className="ml-auto min-w-0 truncate text-xs tabular-nums text-muted-foreground">
            {headerBits.join(" · ")}
          </span>
        ) : null}
      </div>

      {projection === null || (trace === null && tokenUsage?.usageStatus === "unavailable") ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
          <ChartNoAxesGantt className="size-8 text-muted-foreground/50" aria-hidden />
          <p className="text-sm text-muted-foreground">No timed turns in this thread yet.</p>
          <p className="text-xs text-muted-foreground/80">
            Send a message and Insights will chart a zoomable timeline of queue, model, tool, and
            wait time, plus this thread's token totals when the provider reports them.
          </p>
        </div>
      ) : trace === null ? (
        <ScrollArea className="min-h-0 flex-1">
          <div className="flex flex-col gap-4 p-3">
            <TokenUsageSummary
              usage={tokenUsage}
              cost={threadCost}
              pricingPending={pricingPending}
              pricingError={pricingError}
            />
            <ContextOccupancyChart series={occupancy} selectedRunId={null} />
            <TurnTokenBreakdown
              rows={turnRows}
              costs={costs}
              selectedRunId={null}
              onSelect={() => undefined}
            />
            <p className="text-2xs text-muted-foreground">
              Timing appears after the first turn starts. Token totals update as the provider
              reports them.
            </p>
          </div>
        </ScrollArea>
      ) : (
        <FlameChartPanel
          trace={trace}
          turnItems={projection.projection.turnItems}
          tokenUsage={tokenUsage}
          turnRows={turnRows}
          costs={costs}
          threadCost={threadCost}
          pricingPending={pricingPending}
          pricingError={pricingError}
          occupancy={occupancy}
        />
      )}
    </div>
  );
}

function FlameChartPanel({
  trace,
  turnItems,
  tokenUsage,
  turnRows,
  costs,
  threadCost,
  pricingPending,
  pricingError,
  occupancy,
}: {
  readonly trace: ThreadTimingTrace;
  readonly turnItems: ReadonlyArray<ThreadStructureTurnItem>;
  readonly tokenUsage: ThreadTurnTokenUsageSummary | null;
  readonly turnRows: readonly ThreadTurnTokenUsageRow[];
  readonly costs: ReadonlyMap<string, TurnCostEstimate>;
  readonly threadCost: TurnCostEstimate | null;
  readonly pricingPending: boolean;
  readonly pricingError: string | null;
  readonly occupancy: ContextOccupancySeries | null;
}) {
  const layout = layoutThreadFlameChart(trace);
  const axis = buildCompressedTimingAxis(trace.turns);
  const fitView = {
    startMs: 0,
    durationMs: Math.max(MIN_VIEW_MS, axis.displayTotalMs),
  };
  // Keep zoom/pan across live totalMs updates; only reset when the turn set changes.
  const traceKey = `${trace.originMs}:${trace.turns.map((turn) => turn.runId).join("\0")}`;
  const [viewByKey, setViewByKey] = useState<{ key: string; view: ViewWindow }>(() => ({
    key: traceKey,
    view: fitView,
  }));
  const view =
    viewByKey.key === traceKey
      ? clampTimingViewWindow(
          viewByKey.view.startMs,
          viewByKey.view.durationMs,
          0,
          Math.max(1, axis.displayTotalMs),
          MIN_VIEW_MS,
        )
      : fitView;

  const [selection, setSelection] = useState<Selection | null>(null);
  const selectedTurn =
    selection === null
      ? null
      : (trace.turns.find((turn) => turn.runId === selection.runId) ?? null);
  const selectedSpan =
    selection?.type === "span"
      ? (selectedTurn?.spans.find((span) => span.id === selection.spanId) ?? null)
      : null;
  const selectedItem =
    selectedSpan === null ? null : (turnItems.find((item) => item.id === selectedSpan.id) ?? null);
  const selectedUsage =
    selectedTurn === null
      ? null
      : (turnRows.find((row) => row.runId === selectedTurn.runId) ?? null);

  const zoomFactor = Math.max(1, Math.max(MIN_VIEW_MS, axis.displayTotalMs) / view.durationMs);

  function commitView(next: ViewWindow) {
    setViewByKey({ key: traceKey, view: next });
  }

  function setClampedView(startMs: number, durationMs: number) {
    commitView(
      clampTimingViewWindow(startMs, durationMs, 0, Math.max(1, axis.displayTotalMs), MIN_VIEW_MS),
    );
  }

  function zoomBy(factor: number, anchorMs?: number) {
    const anchor = anchorMs ?? view.startMs + view.durationMs / 2;
    commitView(
      timingViewZoomAt(
        view.startMs,
        view.durationMs,
        0,
        Math.max(1, axis.displayTotalMs),
        anchor,
        factor,
        MIN_VIEW_MS,
      ),
    );
  }

  function focusRange(realStartMs: number, realEndMs: number) {
    const start = axis.realToDisplay(realStartMs);
    const end = axis.realToDisplay(realEndMs);
    const duration = Math.max(MIN_VIEW_MS, end - start);
    const pad = duration * 0.08;
    setClampedView(start - pad, duration + pad * 2);
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Timeline stays fixed; only DetailCard content may scroll when tall. */}
      <div className="flex shrink-0 flex-col gap-2 border-b border-border/40 p-3">
        <section aria-label="Timeline" className="flex shrink-0 flex-col gap-1.5">
          <div className="flex min-w-0 items-center gap-1">
            <h3 className="shrink-0 text-sm font-medium text-foreground">Timeline</h3>
            <p className="mr-auto min-w-0 truncate text-2xs text-muted-foreground">
              Scroll to zoom · drag to pan
            </p>
            <Button
              type="button"
              variant="ghost-muted"
              size="icon-xs"
              aria-label="Zoom out"
              onClick={() => zoomBy(0.7)}
            >
              <Minus />
            </Button>
            <span className="min-w-9 text-center text-2xs tabular-nums text-muted-foreground">
              {zoomFactor.toFixed(zoomFactor >= 10 ? 0 : 1)}×
            </span>
            <Button
              type="button"
              variant="ghost-muted"
              size="icon-xs"
              aria-label="Zoom in"
              onClick={() => zoomBy(1.4)}
            >
              <Plus />
            </Button>
            <Button
              type="button"
              variant="ghost-muted"
              size="icon-xs"
              aria-label="Fit timeline"
              onClick={() => commitView(fitView)}
            >
              <Scan />
            </Button>
          </div>
          <FlameViewport
            trace={trace}
            axis={axis}
            nodes={layout.nodes}
            maxDepth={layout.maxDepth}
            view={view}
            selection={selection}
            onViewChange={setClampedView}
            onSelect={setSelection}
            onFocusRange={focusRange}
          />
        </section>
        {selection !== null && selectedTurn !== null ? (
          <DetailCard
            turn={selectedTurn}
            span={selectedSpan}
            item={selectedItem}
            usage={selectedUsage}
            cost={costs.get(selectedTurn.runId) ?? null}
            onClear={() => setSelection(null)}
            onFocus={() => {
              if (selectedSpan !== null) focusRange(selectedSpan.startMs, selectedSpan.endMs);
              else focusRange(selectedTurn.requestedAtMs, selectedTurn.endMs);
            }}
          />
        ) : (
          <p className="text-2xs text-muted-foreground">
            Click a turn or span to inspect it.
            {axis.collapsedIdleMs > 0
              ? ` Idle between turns collapsed: ${formatDuration(axis.collapsedIdleMs)}.`
              : ""}
          </p>
        )}
      </div>

      <ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col gap-4 p-3">
          <Summary
            trace={trace}
            tokenUsage={tokenUsage}
            threadCost={threadCost}
            pricingPending={pricingPending}
            pricingError={pricingError}
          />
          <ContextOccupancyChart series={occupancy} selectedRunId={selection?.runId ?? null} />
          <TurnTokenBreakdown
            rows={turnRows}
            costs={costs}
            selectedRunId={selection?.runId ?? null}
            onSelect={(runId) => setSelection({ type: "turn", runId })}
          />
        </div>
      </ScrollArea>
    </div>
  );
}

const OCCUPANCY_CHART = {
  width: 320,
  height: 64,
  padLeft: 4,
  padRight: 4,
  padTop: 6,
  padBottom: 6,
} as const;

function ContextOccupancyChart({
  series,
  selectedRunId,
}: {
  readonly series: ContextOccupancySeries | null;
  readonly selectedRunId: RunId | null;
}) {
  // One point is a lone dot, not a series — skip until compaction or another turn exists.
  if (series === null || series.points.length < 2) return null;

  const { width, height, padLeft, padRight, padTop, padBottom } = OCCUPANCY_CHART;
  const plotWidth = width - padLeft - padRight;
  const plotHeight = height - padTop - padBottom;
  const dataPeak = Math.max(
    1,
    series.peakUsedTokens,
    ...series.points.map((point) => point.usedTokens),
  );
  const windowMax = series.maxTokens;
  // Scale to peak unless fill is near the window; the meta label still shows absolute %.
  const ceiling =
    windowMax !== null && windowMax > 0 && dataPeak >= windowMax * 0.5
      ? Math.max(windowMax, dataPeak)
      : dataPeak;
  const lastIndex = Math.max(0, series.points.length - 1);
  const xForIndex = (index: number) =>
    padLeft + (lastIndex === 0 ? 0 : (index / lastIndex) * plotWidth);
  const yFor = (tokens: number) => padTop + (1 - tokens / ceiling) * plotHeight;
  const linePoints = series.points
    .map((point, index) => `${xForIndex(index).toFixed(2)},${yFor(point.usedTokens).toFixed(2)}`)
    .join(" ");
  const areaPath = [
    `M ${xForIndex(0).toFixed(2)} ${yFor(0).toFixed(2)}`,
    ...series.points.map(
      (point, index) => `L ${xForIndex(index).toFixed(2)} ${yFor(point.usedTokens).toFixed(2)}`,
    ),
    `L ${xForIndex(lastIndex).toFixed(2)} ${yFor(0).toFixed(2)}`,
    "Z",
  ].join(" ");
  const peakLabel = formatTokens(series.peakUsedTokens);
  const maxLabel = series.maxTokens === null ? null : formatTokens(series.maxTokens);
  const fillPct =
    windowMax !== null && windowMax > 0
      ? Math.round((series.peakUsedTokens / windowMax) * 100)
      : null;
  const meta =
    maxLabel === null
      ? `Peak ${peakLabel}`
      : fillPct === null
        ? `Peak ${peakLabel} of ${maxLabel}`
        : `Peak ${peakLabel} of ${maxLabel} · ${fillPct}%`;

  return (
    <section aria-label="Context over time" className="flex min-w-0 shrink-0 flex-col gap-1">
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="text-sm font-medium text-foreground">Context</h3>
        <span className="min-w-0 truncate text-2xs tabular-nums text-muted-foreground">{meta}</span>
      </div>
      <svg
        role="img"
        aria-label={`Context occupancy ${meta}`}
        viewBox={`0 0 ${width} ${height}`}
        className="h-16 w-full overflow-hidden rounded-md border border-border/50 bg-muted/15"
        preserveAspectRatio="none"
      >
        <path d={areaPath} className="fill-foreground/10" />
        <polyline
          points={linePoints}
          fill="none"
          className="stroke-foreground/70"
          strokeWidth={1.5}
          strokeLinejoin="round"
          strokeLinecap="round"
          vectorEffect="non-scaling-stroke"
        />
        {/* Markers omitted: preserveAspectRatio=none stretches circles into ovals. */}
        {selectedRunId !== null
          ? series.points.map((point, index) => {
              if (point.runId !== selectedRunId) return null;
              return (
                <line
                  key={`sel:${point.kind}:${point.atMs}`}
                  x1={xForIndex(index)}
                  x2={xForIndex(index)}
                  y1={padTop}
                  y2={height - padBottom}
                  className="stroke-foreground/50"
                  strokeWidth={1}
                  vectorEffect="non-scaling-stroke"
                />
              );
            })
          : null}
      </svg>
    </section>
  );
}

const TIMING_SHARE_COLORS = {
  work: "color-mix(in oklab, var(--foreground) 80%, var(--background))",
  wait: "var(--warning)",
  queue: "color-mix(in oklab, var(--muted-foreground) 55%, var(--background))",
} as const;

function timingPhaseSegments(trace: ThreadTimingTrace): readonly ShareSegment[] {
  return [
    { label: "Working", value: trace.workMs, color: TIMING_SHARE_COLORS.work },
    { label: "Waiting on you", value: trace.waitMs, color: TIMING_SHARE_COLORS.wait },
    { label: "Queued", value: trace.queueWaitMs, color: TIMING_SHARE_COLORS.queue },
  ];
}

function Summary({
  trace,
  tokenUsage,
  threadCost,
  pricingPending,
  pricingError,
}: {
  readonly trace: ThreadTimingTrace;
  readonly tokenUsage: ThreadTurnTokenUsageSummary | null;
  readonly threadCost: TurnCostEstimate | null;
  readonly pricingPending: boolean;
  readonly pricingError: string | null;
}) {
  const showTokens =
    tokenUsage !== null &&
    tokenUsage.usageStatus !== "unavailable" &&
    ((tokenUsage.totalTokens ?? 0) > 0 ||
      (tokenUsage.uncachedInputTokens ?? 0) > 0 ||
      (tokenUsage.cachedInputTokens ?? 0) > 0 ||
      (tokenUsage.cacheCreationTokens ?? 0) > 0 ||
      (tokenUsage.outputTokens ?? 0) > 0);
  return (
    <div
      className={cn(
        "grid shrink-0 gap-4",
        showTokens ? "grid-cols-1 @[28rem]:grid-cols-2" : "grid-cols-1",
      )}
    >
      <TimingSummary trace={trace} />
      {showTokens ? (
        <TokenUsageSummary
          usage={tokenUsage}
          cost={threadCost}
          pricingPending={pricingPending}
          pricingError={pricingError}
        />
      ) : null}
    </div>
  );
}

function TimingSummary({ trace }: { readonly trace: ThreadTimingTrace }) {
  const segments = timingPhaseSegments(trace);
  const phaseTotal = segments.reduce((sum, segment) => sum + segment.value, 0);
  return (
    <section aria-label="Thread timing summary" className="flex min-w-0 flex-col gap-2">
      {phaseTotal > 0 ? (
        <UsageShareBar
          label="Time by phase"
          segments={segments}
          format={formatDuration}
          aside={
            <span className="text-xs tabular-nums text-muted-foreground">
              {formatDuration(trace.totalMs)} total
            </span>
          }
        />
      ) : (
        <>
          <div className="flex items-baseline justify-between gap-3">
            <h3 className="text-sm font-medium text-foreground">Time by phase</h3>
            <span className="text-xs tabular-nums text-muted-foreground">
              {formatDuration(trace.totalMs)} total
            </span>
          </div>
          <p className="text-xs text-muted-foreground">No working, waiting, or queue time yet.</p>
        </>
      )}
    </section>
  );
}

function tokenUsageAside(
  usage: ThreadTurnTokenUsageSummary,
  cost: TurnCostEstimate | null,
): string | null {
  const total = usage.totalTokens;
  const costLabel = formatCostEstimate(cost);
  if (total === null && costLabel === null) return null;
  const bits = [
    total === null
      ? null
      : `${formatTokens(total)}${usage.usageStatus === "partial" ? " · partial" : ""}`,
    costLabel,
  ].filter((bit): bit is string => bit !== null);
  return bits.length === 0 ? null : `${bits.join(" · ")} total`;
}

function TokenUsageSummary({
  usage,
  cost,
  pricingPending = false,
  pricingError = null,
}: {
  readonly usage: ThreadTurnTokenUsageSummary | null;
  readonly cost: TurnCostEstimate | null;
  readonly pricingPending?: boolean;
  readonly pricingError?: string | null;
}) {
  if (usage === null || usage.usageStatus === "unavailable") {
    return (
      <section aria-label="Thread token usage" className="flex min-w-0 flex-col gap-2">
        <h3 className="text-sm font-medium text-foreground">Tokens by type</h3>
        <p className="text-xs text-muted-foreground">
          Unavailable. Providers that report per-turn usage fill this in for the current thread.
        </p>
      </section>
    );
  }

  const segments = tokenTypeSegments({
    uncachedInputTokens: usage.uncachedInputTokens ?? 0,
    cachedInputTokens: usage.cachedInputTokens ?? 0,
    cacheCreationTokens: usage.cacheCreationTokens ?? 0,
    outputTokens: usage.outputTokens ?? 0,
  });
  const otherTokens = (usage.otherInputTokens ?? 0) + (usage.otherOutputTokens ?? 0);
  const withOther =
    otherTokens > 0
      ? [
          ...segments,
          {
            label: "Other",
            value: otherTokens,
            color: "color-mix(in oklab, var(--foreground) 44%, var(--background))",
          },
        ]
      : segments;
  const aside = tokenUsageAside(usage, cost);
  const bar = withOther.some((segment) => segment.value > 0) ? (
    <UsageShareBar
      label="Tokens by type"
      segments={withOther}
      format={formatTokens}
      aside={
        aside === null ? undefined : (
          <span className="text-xs tabular-nums text-muted-foreground">{aside}</span>
        )
      }
    />
  ) : (
    <>
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="text-sm font-medium text-foreground">Tokens by type</h3>
        {aside !== null ? (
          <span className="text-xs tabular-nums text-muted-foreground">{aside}</span>
        ) : null}
      </div>
      <p className="text-xs text-muted-foreground">No token counts to chart yet.</p>
    </>
  );

  const pricingNote =
    cost !== null ||
    ((usage.totalTokens ?? 0) <= 0 &&
      (usage.uncachedInputTokens ?? 0) <= 0 &&
      (usage.cachedInputTokens ?? 0) <= 0 &&
      (usage.cacheCreationTokens ?? 0) <= 0 &&
      (usage.outputTokens ?? 0) <= 0)
      ? null
      : pricingPending
        ? "Estimating API cost…"
        : pricingError !== null
          ? "Could not estimate API cost."
          : null;

  return (
    <section aria-label="Thread token usage" className="flex min-w-0 flex-col gap-2">
      {bar}
      {pricingNote !== null ? (
        <p className="text-2xs text-muted-foreground">{pricingNote}</p>
      ) : null}
    </section>
  );
}

function TurnTokenBreakdown({
  rows,
  costs,
  selectedRunId,
  onSelect,
}: {
  readonly rows: readonly ThreadTurnTokenUsageRow[];
  readonly costs: ReadonlyMap<string, TurnCostEstimate>;
  readonly selectedRunId: ThreadTimingTurn["runId"] | null;
  readonly onSelect: (runId: ThreadTimingTurn["runId"]) => void;
}) {
  const visible = rows.filter(
    (row) =>
      row.usage.usageStatus !== "unavailable" ||
      (row.usage.totalTokens ?? 0) > 0 ||
      costs.has(row.runId),
  );
  if (visible.length === 0) return null;

  return (
    <section aria-label="Token usage by turn" className="flex min-w-0 shrink-0 flex-col gap-1.5">
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="text-sm font-medium text-foreground">By turn</h3>
        <span className="text-2xs text-muted-foreground">Estimated API cost</span>
      </div>
      <ul className="divide-y divide-border/40 overflow-x-hidden rounded-md border border-border/50">
        {visible.map((row) => {
          const cost = formatCostEstimate(costs.get(row.runId) ?? null);
          const tokens =
            row.usage.totalTokens === null ? "Unknown" : formatTokens(row.usage.totalTokens);
          const selected = selectedRunId === row.runId;
          return (
            <li key={row.runId}>
              <button
                type="button"
                className={cn(
                  "flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-xs transition-colors",
                  selected ? "bg-muted/60" : "hover:bg-muted/35",
                )}
                onClick={() => onSelect(row.runId)}
              >
                <span className="min-w-14 shrink-0 font-medium text-foreground">
                  Turn {row.ordinal}
                </span>
                <span className="min-w-0 flex-1 truncate text-muted-foreground">
                  {row.model ?? "Unknown model"}
                </span>
                <span className="shrink-0 tabular-nums text-muted-foreground">{tokens}</span>
                <span className="w-14 shrink-0 text-right tabular-nums text-muted-foreground">
                  {cost ?? "Unknown"}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function FlameViewport({
  trace,
  axis,
  nodes,
  maxDepth,
  view,
  selection,
  onViewChange,
  onSelect,
  onFocusRange,
}: {
  readonly trace: ThreadTimingTrace;
  readonly axis: CompressedTimingAxis;
  readonly nodes: ReadonlyArray<FlameChartNode>;
  readonly maxDepth: number;
  readonly view: ViewWindow;
  readonly selection: Selection | null;
  readonly onViewChange: (startMs: number, durationMs: number) => void;
  readonly onSelect: (selection: Selection | null) => void;
  readonly onFocusRange: (startMs: number, endMs: number) => void;
}) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{
    pointerId: number;
    x: number;
    startMs: number;
    moved: boolean;
  } | null>(null);
  const suppressClickRef = useRef(false);

  const chartHeight =
    RULER_HEIGHT + TURN_ROW_HEIGHT + Math.max(0, maxDepth) * (SPAN_ROW_HEIGHT + ROW_GAP) + 8;

  const onWheel = useStableCallback((event: WheelEvent) => {
    const viewport = viewportRef.current;
    if (viewport === null) return;
    event.preventDefault();
    const rect = viewport.getBoundingClientRect();
    const ratio = rect.width > 0 ? (event.clientX - rect.left) / rect.width : 0.5;
    const anchorMs = view.startMs + ratio * view.durationMs;
    if (event.ctrlKey || event.metaKey || Math.abs(event.deltaY) > Math.abs(event.deltaX)) {
      const factor = Math.exp(-event.deltaY * 0.0015);
      const next = timingViewZoomAt(
        view.startMs,
        view.durationMs,
        0,
        Math.max(1, axis.displayTotalMs),
        anchorMs,
        factor,
        MIN_VIEW_MS,
      );
      onViewChange(next.startMs, next.durationMs);
      return;
    }
    const deltaMs = (event.deltaX / Math.max(1, rect.width)) * view.durationMs;
    onViewChange(view.startMs + deltaMs, view.durationMs);
  });

  const attachViewport = (node: HTMLDivElement | null) => {
    viewportRef.current = node;
    if (node === null) return;
    // React's onWheel is passive and cannot stop the panel from scrolling.
    node.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      node.removeEventListener("wheel", onWheel);
      if (viewportRef.current === node) viewportRef.current = null;
    };
  };

  function positionForDisplay(displayStartMs: number, displayEndMs: number) {
    const left = ((displayStartMs - view.startMs) / view.durationMs) * 100;
    const width =
      ((Math.max(displayEndMs, displayStartMs) - displayStartMs) / view.durationMs) * 100;
    return {
      left: `${left}%`,
      width: `${Math.max(width, 0.35)}%`,
    };
  }

  function handlePointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    if (event.target instanceof Element && event.target.closest("[data-flame-node]")) return;
    suppressClickRef.current = false;
    dragRef.current = {
      pointerId: event.pointerId,
      x: event.clientX,
      startMs: view.startMs,
      moved: false,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function handlePointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    const drag = dragRef.current;
    if (drag === null || drag.pointerId !== event.pointerId) return;
    const viewport = viewportRef.current;
    if (viewport === null) return;
    const dx = event.clientX - drag.x;
    if (!drag.moved && Math.abs(dx) < 3) return;
    drag.moved = true;
    suppressClickRef.current = true;
    const deltaMs = -(dx / Math.max(1, viewport.clientWidth)) * view.durationMs;
    onViewChange(drag.startMs + deltaMs, view.durationMs);
  }

  function handlePointerUp(event: ReactPointerEvent<HTMLDivElement>) {
    const drag = dragRef.current;
    if (drag === null || drag.pointerId !== event.pointerId) return;
    dragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    if (!drag.moved) suppressClickRef.current = false;
  }

  function selectNode(node: FlameChartNode) {
    if (suppressClickRef.current) {
      suppressClickRef.current = false;
      return;
    }
    if (node.kind === "turn") onSelect({ type: "turn", runId: node.runId });
    else onSelect({ type: "span", runId: node.runId, spanId: node.spanId });
  }

  const viewEndMs = view.startMs + view.durationMs;
  const visibleNodes = nodes.filter((node) => {
    const start = axis.realToDisplay(node.startMs);
    const end = axis.realToDisplay(node.endMs);
    return end >= view.startMs && start <= viewEndMs;
  });
  const visibleBreaks = axis.breaks.filter(
    (item) => item.displayEndMs >= view.startMs && item.displayStartMs <= viewEndMs,
  );
  const ticks = buildTimeTicks(view.startMs, viewEndMs, (displayMs) =>
    formatDuration(Math.max(0, axis.displayToReal(displayMs) - trace.originMs)),
  );

  return (
    <div className="flex shrink-0 flex-col gap-2">
      <div
        ref={attachViewport}
        role="application"
        aria-label="Thread timing flame chart"
        className="relative cursor-grab overflow-hidden rounded-lg border border-border/60 bg-muted/25 active:cursor-grabbing"
        style={{ height: chartHeight }}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
      >
        <div className="absolute inset-x-0 top-0 z-[1] h-[22px] border-b border-border/40 bg-muted/40">
          {ticks.map((tick) => {
            const left = ((tick.ms - view.startMs) / view.durationMs) * 100;
            return (
              <div
                key={tick.ms}
                className="absolute top-0 h-full border-l border-border/50"
                style={{ left: `${left}%` }}
              >
                <span className="absolute top-1 left-1 text-2xs tabular-nums text-muted-foreground">
                  {tick.label}
                </span>
              </div>
            );
          })}
        </div>

        {trace.turns.map((turn) => {
          const start = axis.realToDisplay(turn.requestedAtMs);
          const end = axis.realToDisplay(turn.endMs);
          if (end < view.startMs || start > viewEndMs) return null;
          const style = positionForDisplay(start, end);
          return (
            <div
              key={`band:${turn.runId}`}
              aria-hidden
              className="pointer-events-none absolute top-[22px] bottom-0 z-[1] border-l-2 border-foreground/35 bg-foreground/[0.03]"
              style={style}
            />
          );
        })}

        {visibleNodes.map((node) => {
          const top =
            node.kind === "turn"
              ? RULER_HEIGHT
              : RULER_HEIGHT + TURN_ROW_HEIGHT + (node.depth - 1) * (SPAN_ROW_HEIGHT + ROW_GAP);
          const height = node.kind === "turn" ? TURN_ROW_HEIGHT - 4 : SPAN_ROW_HEIGHT;
          const style = positionForDisplay(
            axis.realToDisplay(node.startMs),
            axis.realToDisplay(node.endMs),
          );
          const selected =
            node.kind === "turn"
              ? selection?.type === "turn" && selection.runId === node.runId
              : selection?.type === "span" && selection.spanId === node.spanId;
          return (
            <button
              key={node.id}
              type="button"
              data-flame-node={node.id}
              aria-label={
                node.kind === "turn"
                  ? `Turn ${node.ordinal}: ${node.label}, ${formatDuration(node.durationMs)}`
                  : `${node.label}, ${formatDuration(node.durationMs)}`
              }
              aria-pressed={selected}
              className={cn(
                "absolute overflow-hidden rounded-sm border px-1 text-left text-2xs leading-4.5 transition-shadow",
                "cursor-pointer hover:brightness-110",
                node.kind === "turn"
                  ? "border-foreground/40 bg-card/90 font-medium text-foreground"
                  : SPAN_BAR_CLASS[node.kind],
                selected && "ring-2 ring-ring ring-offset-1 ring-offset-background",
              )}
              style={{
                top,
                height,
                left: style.left,
                width: style.width,
                zIndex: selected ? 30 : 10 + node.depth,
              }}
              onPointerDown={(event) => {
                suppressClickRef.current = false;
                event.stopPropagation();
              }}
              onClick={(event) => {
                event.stopPropagation();
                selectNode(node);
              }}
              onDoubleClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                suppressClickRef.current = false;
                onFocusRange(node.startMs, node.endMs);
                selectNode(node);
              }}
            >
              <span className="block truncate">
                {node.kind === "turn" ? `T${node.ordinal} · ${node.label}` : node.label}
              </span>
            </button>
          );
        })}

        {/* Above bars so the void covers any subpixel bleed into the idle gap. */}
        {visibleBreaks.map((idleBreak) => (
          <IdlePaperTear
            key={idleBreak.id}
            style={positionForDisplay(idleBreak.displayStartMs, idleBreak.displayEndMs)}
            label={formatDuration(idleBreak.idleMs)}
          />
        ))}
      </div>

      <OverviewStrip
        trace={trace}
        axis={axis}
        view={view}
        onViewChange={onViewChange}
        onSeek={(startMs) => onViewChange(startMs, view.durationMs)}
      />
    </div>
  );
}

function OverviewStrip({
  trace,
  axis,
  view,
  onViewChange,
  onSeek,
}: {
  readonly trace: ThreadTimingTrace;
  readonly axis: CompressedTimingAxis;
  readonly view: ViewWindow;
  readonly onViewChange: (startMs: number, durationMs: number) => void;
  readonly onSeek: (startMs: number) => void;
}) {
  const totalMs = Math.max(1, axis.displayTotalMs);
  const windowLeft = (view.startMs / totalMs) * 100;
  const windowWidth = (view.durationMs / totalMs) * 100;
  const dragRef = useRef<{ pointerId: number } | null>(null);

  function handlePointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const ratio = rect.width > 0 ? (event.clientX - rect.left) / rect.width : 0;
    const clickMs = ratio * totalMs;
    onSeek(clickMs - view.durationMs / 2);
    dragRef.current = { pointerId: event.pointerId };
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function handlePointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    const drag = dragRef.current;
    if (drag === null || drag.pointerId !== event.pointerId) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const ratio = rect.width > 0 ? (event.clientX - rect.left) / rect.width : 0;
    const centerMs = ratio * totalMs;
    onViewChange(centerMs - view.durationMs / 2, view.durationMs);
  }

  function handlePointerUp(event: ReactPointerEvent<HTMLDivElement>) {
    if (dragRef.current?.pointerId !== event.pointerId) return;
    dragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }

  return (
    <div
      role="slider"
      aria-label="Timeline overview"
      aria-valuemin={0}
      aria-valuemax={totalMs}
      aria-valuenow={view.startMs}
      tabIndex={0}
      className="relative h-8 shrink-0 cursor-pointer overflow-hidden rounded-md border border-border/50 bg-muted/30"
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
    >
      {trace.turns.map((turn) => {
        const start = axis.realToDisplay(turn.requestedAtMs);
        const end = axis.realToDisplay(turn.endMs);
        const left = (start / totalMs) * 100;
        const width = (Math.max(1, end - start) / totalMs) * 100;
        return (
          <div
            key={turn.runId}
            className="absolute inset-y-1 rounded-sm border border-foreground/25 bg-foreground/15"
            style={{ left: `${left}%`, width: `${width}%` }}
          />
        );
      })}
      {axis.breaks.map((idleBreak) => {
        const left = (idleBreak.displayStartMs / totalMs) * 100;
        const width = ((idleBreak.displayEndMs - idleBreak.displayStartMs) / totalMs) * 100;
        return (
          <div
            key={idleBreak.id}
            aria-hidden
            className="pointer-events-none absolute inset-y-0 overflow-hidden bg-background"
            style={{ left: `${left}%`, width: `${Math.max(width, 0.6)}%` }}
          >
            <svg className="size-full" preserveAspectRatio="none" viewBox="0 0 100 200">
              <path d={PAPER_TEAR_LEFT_FLAP} className="fill-muted/25" />
              <path d={PAPER_TEAR_RIGHT_FLAP} className="fill-muted/25" />
            </svg>
          </div>
        );
      })}
      <div
        className="pointer-events-none absolute inset-y-0 rounded-sm border border-ring bg-ring/15"
        style={{ left: `${windowLeft}%`, width: `${Math.max(windowWidth, 1.5)}%` }}
      />
    </div>
  );
}

function IdlePaperTear({
  style,
  label,
}: {
  readonly style: CSSProperties;
  readonly label: string;
}) {
  const reactId = useId().replaceAll(":", "");
  const leftShadowId = `${reactId}-tear-left`;
  const rightShadowId = `${reactId}-tear-right`;

  return (
    <div
      aria-hidden
      className="pointer-events-none absolute inset-y-0 z-40 overflow-hidden bg-background"
      style={style}
    >
      <svg className="absolute inset-0 size-full" preserveAspectRatio="none" viewBox="0 0 100 200">
        <defs>
          <filter
            id={leftShadowId}
            x="-20%"
            y="-5%"
            width="140%"
            height="110%"
            colorInterpolationFilters="sRGB"
          >
            <feDropShadow dx="2.5" dy="0" stdDeviation="1.4" floodOpacity="0.22" />
          </filter>
          <filter
            id={rightShadowId}
            x="-20%"
            y="-5%"
            width="140%"
            height="110%"
            colorInterpolationFilters="sRGB"
          >
            <feDropShadow dx="-2.5" dy="0" stdDeviation="1.4" floodOpacity="0.22" />
          </filter>
        </defs>
        <path d={PAPER_TEAR_LEFT_FLAP} className="fill-muted/25" filter={`url(#${leftShadowId})`} />
        <path
          d={PAPER_TEAR_RIGHT_FLAP}
          className="fill-muted/25"
          filter={`url(#${rightShadowId})`}
        />
        <path
          d={PAPER_TEAR_LEFT_EDGE}
          fill="none"
          className="stroke-border/70"
          strokeWidth="1.5"
          vectorEffect="non-scaling-stroke"
        />
        <path
          d={PAPER_TEAR_RIGHT_EDGE}
          fill="none"
          className="stroke-border/70"
          strokeWidth="1.5"
          vectorEffect="non-scaling-stroke"
        />
      </svg>
      <span className="absolute inset-x-0 top-1/2 -translate-y-1/2 truncate px-1 text-center text-2xs font-medium text-muted-foreground/80">
        {label}
      </span>
    </div>
  );
}

function DetailCard({
  turn,
  span,
  item,
  usage,
  cost,
  onClear,
  onFocus,
}: {
  readonly turn: ThreadTimingTurn;
  readonly span: ThreadTimingSpan | null;
  readonly item: ThreadStructureTurnItem | null;
  readonly usage: ThreadTurnTokenUsageRow | null;
  readonly cost: TurnCostEstimate | null;
  readonly onClear: () => void;
  readonly onFocus: () => void;
}) {
  const facts = span === null ? null : spanDetailFacts(turn, span, item);
  const preview = item === null ? null : spanDetailPreview(item);
  const costLabel = formatCostEstimate(cost);
  const tokenLabel =
    usage?.usage.totalTokens == null ? null : formatTokens(usage.usage.totalTokens);

  return (
    <section
      aria-label="Selection detail"
      className="flex max-h-[min(18rem,32vh)] shrink-0 flex-col gap-2 overflow-hidden rounded-lg border border-border/60 bg-card/40 p-2.5"
    >
      <header className="flex shrink-0 items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-2xs font-medium tracking-wide text-muted-foreground uppercase">
            {span === null
              ? `Turn ${turn.ordinal}`
              : `Turn ${turn.ordinal} · ${itemTypeLabel(item?.type ?? span.kind)}`}
          </p>
          <h3 className="truncate text-sm font-medium text-foreground">
            {span === null ? turn.label : span.label}
          </h3>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Button
            type="button"
            variant="ghost-muted"
            size="icon-xs"
            aria-label="Focus selection"
            onClick={onFocus}
          >
            <Focus />
          </Button>
          <Button type="button" variant="ghost-muted" size="xs" onClick={onClear}>
            Clear
          </Button>
        </div>
      </header>

      <div className="flex min-h-0 flex-col gap-2 overflow-y-auto">
        {span === null ? (
          <div className="grid grid-cols-2 gap-2 text-2xs @[22rem]:grid-cols-3">
            <span className="text-muted-foreground">
              Duration{" "}
              <span className="tabular-nums text-foreground/80">
                {formatDuration(turn.durationMs)}
              </span>
            </span>
            <span className="text-muted-foreground">
              Work{" "}
              <span className="tabular-nums text-foreground/80">{formatDuration(turn.workMs)}</span>
            </span>
            <span className="text-muted-foreground">
              Wait{" "}
              <span className="tabular-nums text-foreground/80">{formatDuration(turn.waitMs)}</span>
            </span>
            {tokenLabel !== null ? (
              <span className="text-muted-foreground">
                Tokens <span className="tabular-nums text-foreground/80">{tokenLabel}</span>
              </span>
            ) : null}
            {costLabel !== null ? (
              <span className="text-muted-foreground">
                Est. cost <span className="tabular-nums text-foreground/80">{costLabel}</span>
              </span>
            ) : null}
            {usage?.model != null ? (
              <span className="min-w-0 truncate text-muted-foreground">
                Model <span className="text-foreground/80">{usage.model}</span>
              </span>
            ) : null}
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-2xs @[22rem]:grid-cols-3">
            {facts?.map((fact) => (
              <div key={fact.label} className="min-w-0">
                <p className="text-muted-foreground">{fact.label}</p>
                <p className="truncate tabular-nums text-foreground/85">{fact.value}</p>
              </div>
            ))}
          </div>
        )}

        {preview !== null ? (
          <pre className="rounded-md bg-muted/40 px-2 py-1.5 font-mono text-2xs leading-4.5 whitespace-pre-wrap text-muted-foreground">
            {preview}
          </pre>
        ) : null}

        {span === null ? (
          <ol className="flex flex-col gap-1" aria-label={`Spans in turn ${turn.ordinal}`}>
            {turn.spans.map((entry) => (
              <li
                key={entry.id}
                className="flex items-center justify-between gap-2 text-xs text-muted-foreground"
              >
                <span className="min-w-0 truncate">{entry.label}</span>
                <span className="shrink-0 tabular-nums">{formatDuration(entry.durationMs)}</span>
              </li>
            ))}
          </ol>
        ) : null}
      </div>
    </section>
  );
}

function itemTypeLabel(type: string): string {
  return type.replaceAll("_", " ");
}

function truncateDetail(text: string, max = 280): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, Math.max(1, max - 1))}…`;
}

function spanDetailFacts(
  turn: ThreadTimingTurn,
  span: ThreadTimingSpan,
  item: ThreadStructureTurnItem | null,
): ReadonlyArray<{ readonly label: string; readonly value: string }> {
  const turnShare =
    turn.durationMs > 0
      ? `${Math.max(1, Math.round((span.durationMs / turn.durationMs) * 100))}%`
      : "-";
  const facts: Array<{ label: string; value: string }> = [
    { label: "Duration", value: formatDuration(span.durationMs) },
    { label: "Of turn", value: turnShare },
    {
      label: "Starts",
      value: `+${formatDuration(Math.max(0, span.startMs - turn.requestedAtMs))}`,
    },
    { label: "Status", value: span.status },
  ];

  if (item === null) return facts;

  switch (item.type) {
    case "command_execution":
      if (item.exitCode !== undefined) {
        facts.push({ label: "Exit", value: String(item.exitCode) });
      }
      break;
    case "file_change": {
      facts.push({ label: "File", value: item.fileName });
      if (item.additions !== undefined || item.deletions !== undefined) {
        facts.push({
          label: "Diff",
          value: `+${item.additions ?? 0} / −${item.deletions ?? 0}`,
        });
      }
      break;
    }
    case "file_search":
      if (item.pattern?.trim()) facts.push({ label: "Pattern", value: item.pattern.trim() });
      facts.push({ label: "Hits", value: String(item.results?.length ?? 0) });
      break;
    case "web_search":
      if (item.patterns?.length) {
        facts.push({ label: "Query", value: item.patterns.filter(Boolean).join(", ") });
      }
      facts.push({ label: "Results", value: String(item.results?.length ?? 0) });
      break;
    case "dynamic_tool":
      if (item.toolName) facts.push({ label: "Tool", value: item.toolName });
      break;
    case "approval_request":
      facts.push({ label: "Kind", value: item.requestKind });
      break;
    case "user_input_request":
      facts.push({ label: "Questions", value: String(item.questions.length) });
      break;
    case "secret_request":
      facts.push({ label: "Secret", value: item.label });
      break;
    case "subagent":
      facts.push({ label: "Driver", value: item.driver });
      break;
    case "compaction":
      if (item.beforeTokenCount !== undefined || item.afterTokenCount !== undefined) {
        facts.push({
          label: "Tokens",
          value: `${item.beforeTokenCount ?? "?"} → ${item.afterTokenCount ?? "?"}`,
        });
      }
      break;
    default:
      break;
  }

  return facts;
}

function spanDetailPreview(item: ThreadStructureTurnItem): string | null {
  switch (item.type) {
    case "command_execution":
      return item.input.trim() ? truncateDetail(item.input, 360) : null;
    case "reasoning":
    case "assistant_message":
      return "text" in item && typeof item.text === "string" && item.text.trim()
        ? truncateDetail(item.text, 360)
        : null;
    case "approval_request":
      return truncateDetail([item.reason, item.prompt].filter(Boolean).join(": "), 360) || null;
    case "secret_request":
      return item.reason.trim() ? truncateDetail(item.reason, 280) : null;
    case "link_request":
      return item.reason.trim() ? truncateDetail(item.reason, 280) : null;
    case "subagent":
      return truncateDetail(item.progress?.trim() || item.prompt, 360) || null;
    case "dynamic_tool": {
      if (typeof item.input === "string" && item.input.trim()) {
        return truncateDetail(item.input, 360);
      }
      try {
        return truncateDetail(JSON.stringify(item.input), 360);
      } catch {
        return null;
      }
    }
    case "file_search":
      return item.results?.length
        ? truncateDetail(
            item.results
              .slice(0, 6)
              .map((result) => result.fileName)
              .join("\n"),
            360,
          )
        : null;
    case "web_search":
      return item.results?.length
        ? truncateDetail(
            item.results
              .slice(0, 5)
              .map((result) => result.title?.trim() || result.url)
              .filter(Boolean)
              .join("\n"),
            360,
          )
        : null;
    case "error":
      return truncateDetail(item.failure.message, 360);
    default:
      return null;
  }
}

function buildTimeTicks(
  viewStartMs: number,
  viewEndMs: number,
  labelFor: (displayMs: number) => string,
): ReadonlyArray<{ readonly ms: number; readonly label: string }> {
  const duration = Math.max(1, viewEndMs - viewStartMs);
  const rough = duration / 5;
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  const residual = rough / magnitude;
  const step = residual >= 5 ? 5 * magnitude : residual >= 2 ? 2 * magnitude : magnitude;
  const first = Math.ceil(viewStartMs / step) * step;
  const ticks: Array<{ ms: number; label: string }> = [];
  for (let ms = first; ms <= viewEndMs + step / 2; ms += step) {
    ticks.push({
      ms,
      label: labelFor(ms),
    });
    if (ticks.length > 12) break;
  }
  return ticks;
}
