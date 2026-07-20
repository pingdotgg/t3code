import type { OrchestrationThreadActivity } from "@t3tools/contracts";
import {
  ActivityIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  Clock3Icon,
  PanelRightCloseIcon,
} from "lucide-react";
import { memo, useEffect, useMemo, useState } from "react";

import {
  deriveInsights,
  formatInsightDuration,
  type InsightCategory,
  type InsightToolCall,
} from "~/insights";
import { cn } from "~/lib/utils";
import { Button } from "./ui/button";
import { ScrollArea } from "./ui/scroll-area";
import { ToggleGroup, ToggleGroupItem } from "./ui/toggle-group";

interface InsightsPanelProps {
  readonly activities: ReadonlyArray<OrchestrationThreadActivity>;
  readonly mode?: "sheet" | "sidebar";
  readonly onClose: () => void;
}

interface MetricRow {
  readonly label: string;
  readonly durationMs: number;
  readonly calls?: number;
}

const CATEGORY_ORDER: ReadonlyArray<InsightCategory> = [
  "Thinking",
  "Waiting",
  "Read",
  "Shell",
  "Edit",
  "Search",
  "Other",
];

function metricRowsByType(
  thinkingMs: number,
  waitingMs: number,
  tools: ReadonlyArray<InsightToolCall>,
): ReadonlyArray<MetricRow> {
  const rows = new Map<string, MetricRow>([
    ["Thinking", { label: "Thinking", durationMs: thinkingMs }],
    ["Waiting", { label: "Waiting", durationMs: waitingMs }],
  ]);
  for (const tool of tools) {
    const durationMs = tool.endedAt - tool.startedAt;
    const current = rows.get(tool.category);
    rows.set(tool.category, {
      label: tool.category,
      durationMs: (current?.durationMs ?? 0) + durationMs,
      calls: (current?.calls ?? 0) + 1,
    });
  }
  return CATEGORY_ORDER.flatMap((category) => {
    const row = rows.get(category);
    return row && (row.durationMs > 0 || row.calls) ? [row] : [];
  });
}

function metricRowsByTool(tools: ReadonlyArray<InsightToolCall>): ReadonlyArray<MetricRow> {
  const rows = new Map<string, MetricRow>();
  for (const tool of tools) {
    const current = rows.get(tool.name);
    rows.set(tool.name, {
      label: tool.name,
      durationMs: (current?.durationMs ?? 0) + tool.endedAt - tool.startedAt,
      calls: (current?.calls ?? 0) + 1,
    });
  }
  return [...rows.values()].toSorted(
    (left, right) => right.durationMs - left.durationMs || left.label.localeCompare(right.label),
  );
}

const Metrics = memo(function Metrics({
  rows,
  totalMs,
}: {
  readonly rows: ReadonlyArray<MetricRow>;
  readonly totalMs: number;
}) {
  return (
    <div className="space-y-3">
      {rows.map((row) => (
        <div key={row.label} className="space-y-1">
          <div className="flex items-center justify-between gap-3 text-xs">
            <span className="truncate text-foreground/80">{row.label}</span>
            <span className="shrink-0 tabular-nums text-muted-foreground">
              {formatInsightDuration(row.durationMs)}
              {row.calls ? ` · ${row.calls} ${row.calls === 1 ? "call" : "calls"}` : ""}
            </span>
          </div>
          <div className="h-1 overflow-hidden rounded-full bg-muted">
            <div
              className="h-full rounded-full bg-primary/70"
              style={{ width: `${Math.max(2, (row.durationMs / Math.max(1, totalMs)) * 100)}%` }}
            />
          </div>
        </div>
      ))}
    </div>
  );
});

export const InsightsPanel = memo(function InsightsPanel({
  activities,
  mode = "sidebar",
  onClose,
}: InsightsPanelProps) {
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [grouping, setGrouping] = useState<"tool" | "type">("type");
  const [expandedTurns, setExpandedTurns] = useState<ReadonlySet<string>>(() => new Set());
  const insights = useMemo(() => deriveInsights(activities, nowMs), [activities, nowMs]);
  const hasRunningTurn = insights.turns.some((turn) => turn.status === "running");

  useEffect(() => {
    if (!hasRunningTurn) return;
    const timer = window.setInterval(() => setNowMs(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [hasRunningTurn]);

  const allTools = useMemo(() => insights.turns.flatMap((turn) => turn.tools), [insights.turns]);
  const rows = useMemo(
    () =>
      grouping === "type"
        ? metricRowsByType(insights.thinkingMs, insights.waitingMs, allTools)
        : metricRowsByTool(allTools),
    [allTools, grouping, insights.thinkingMs, insights.waitingMs],
  );

  return (
    <div
      className={cn(
        "flex min-h-0 flex-col bg-card/50",
        mode === "sidebar"
          ? "h-full w-[400px] shrink-0 border-l border-border/70"
          : "h-full w-full",
      )}
    >
      <div className="flex h-12 shrink-0 items-center justify-between border-b border-border/60 px-3">
        <div className="flex items-center gap-2">
          <ActivityIcon className="size-4 text-primary" />
          <span className="text-sm font-medium">Insights</span>
        </div>
        <Button
          size="icon-xs"
          variant="ghost"
          className="text-muted-foreground/60 hover:text-foreground"
          aria-label="Close insights"
          onClick={onClose}
        >
          <PanelRightCloseIcon className="size-4" />
        </Button>
      </div>

      {insights.turns.length === 0 ? (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 p-8 text-center">
          <Clock3Icon className="size-6 text-muted-foreground/40" />
          <p className="text-sm font-medium">No timing data recorded</p>
          <p className="max-w-64 text-xs text-muted-foreground">
            Insights are available for turns started after this feature was enabled.
          </p>
        </div>
      ) : (
        <ScrollArea className="min-h-0 flex-1">
          <div className="space-y-6 p-4">
            <div className="grid grid-cols-2 gap-2">
              <div className="rounded-lg border border-border/60 bg-background/50 p-3">
                <div className="text-[11px] text-muted-foreground">Agent activity</div>
                <div className="mt-1 text-lg font-semibold tabular-nums">
                  {formatInsightDuration(insights.durationMs)}
                </div>
              </div>
              <div className="rounded-lg border border-border/60 bg-background/50 p-3">
                <div className="text-[11px] text-muted-foreground">Tool calls</div>
                <div className="mt-1 text-lg font-semibold tabular-nums">
                  {insights.toolCallCount}
                </div>
              </div>
            </div>

            <section className="space-y-3">
              <div className="flex items-center justify-between">
                <h3 className="text-xs font-medium">Time by {grouping}</h3>
                <ToggleGroup
                  value={[grouping]}
                  onValueChange={(value) => {
                    const next = value[0];
                    if (next === "tool" || next === "type") setGrouping(next);
                  }}
                  size="sm"
                >
                  <ToggleGroupItem value="tool">All tools</ToggleGroupItem>
                  <ToggleGroupItem value="type">By type</ToggleGroupItem>
                </ToggleGroup>
              </div>
              <Metrics
                rows={rows}
                totalMs={Math.max(insights.durationMs, insights.toolDurationMs)}
              />
            </section>

            <section className="space-y-2">
              <h3 className="text-xs font-medium">Turns</h3>
              {insights.turns.map((turn, index) => {
                const turnKey = String(turn.turnId);
                const expanded = expandedTurns.has(turnKey);
                return (
                  <div key={turnKey} className="overflow-hidden rounded-lg border border-border/60">
                    <button
                      type="button"
                      className="flex w-full items-center gap-2 p-3 text-left hover:bg-muted/30"
                      onClick={() =>
                        setExpandedTurns((current) => {
                          const next = new Set(current);
                          if (next.has(turnKey)) next.delete(turnKey);
                          else next.add(turnKey);
                          return next;
                        })
                      }
                    >
                      {expanded ? (
                        <ChevronDownIcon className="size-3.5 text-muted-foreground" />
                      ) : (
                        <ChevronRightIcon className="size-3.5 text-muted-foreground" />
                      )}
                      <span className="min-w-0 flex-1 truncate text-xs font-medium">
                        Turn {insights.turns.length - index}
                      </span>
                      <span className="text-[11px] capitalize text-muted-foreground">
                        {turn.status}
                      </span>
                      <span className="text-xs tabular-nums">
                        {formatInsightDuration(turn.durationMs)}
                      </span>
                    </button>
                    {expanded ? (
                      <div className="space-y-3 border-t border-border/60 bg-background/30 p-3">
                        <div className="text-[11px] text-muted-foreground">{turn.provider}</div>
                        <Metrics
                          rows={metricRowsByType(turn.thinkingMs, turn.waitingMs, turn.tools)}
                          totalMs={turn.durationMs}
                        />
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </section>
          </div>
        </ScrollArea>
      )}
    </div>
  );
});
