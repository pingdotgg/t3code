import {
  ActivityIcon,
  AlertTriangleIcon,
  BatteryIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  CpuIcon,
  DatabaseIcon,
  GaugeIcon,
  HardDriveIcon,
  MemoryStickIcon,
  RefreshCwIcon,
  RotateCcwIcon,
} from "lucide-react";
import type {
  BackgroundBooleanState,
  ResourceAttributionEntry,
  ResourceTelemetryAggregate,
  ResourceTelemetryHistoryBucket,
  ResourceTelemetryIoSemantics,
  ResourceTelemetryProcess,
  ResourceTelemetryProcessCategory,
  ResourceTelemetryProcessSummary,
  ResourceTelemetrySourceHealth,
  ResourceTelemetrySourceStatus,
  ServerProcessSignal,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import { useCallback, useMemo, useState, type ReactNode } from "react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";

import {
  useResourceTelemetry,
  useResourceTelemetryHistory,
} from "../../lib/resourceTelemetryState";
import { cn } from "../../lib/utils";
import { usePrimaryEnvironment } from "../../state/environments";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { formatRelativeTime } from "../../timestampFormat";
import { Button } from "../ui/button";
import { ScrollArea } from "../ui/scroll-area";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { toastManager } from "../ui/toast";
import { SettingsSection, useRelativeTimeTick } from "./settingsLayout";

const HISTORY_WINDOWS = [
  { label: "5m", windowMs: 5 * 60_000, bucketMs: 15_000 },
  { label: "15m", windowMs: 15 * 60_000, bucketMs: 30_000 },
  { label: "30m", windowMs: 30 * 60_000, bucketMs: 60_000 },
  { label: "1h", windowMs: 60 * 60_000, bucketMs: 2 * 60_000 },
] as const;

function formatBytes(value: number): string {
  if (value < 1_024) return `${Math.round(value)} B`;
  const units = ["KB", "MB", "GB", "TB"] as const;
  let next = value;
  let unitIndex = -1;
  do {
    next /= 1_024;
    unitIndex += 1;
  } while (next >= 1_024 && unitIndex < units.length - 1);
  return `${next.toFixed(next >= 100 ? 0 : next >= 10 ? 1 : 2)} ${units[unitIndex]}`;
}

function formatRate(value: number): string {
  return `${formatBytes(value)}/s`;
}

function formatCpuTime(valueMs: number): string {
  const seconds = valueMs / 1_000;
  if (seconds < 60) return `${seconds.toFixed(seconds >= 10 ? 1 : 2)}s`;
  const minutes = seconds / 60;
  if (minutes < 60) return `${minutes.toFixed(minutes >= 10 ? 1 : 2)}m`;
  return `${(minutes / 60).toFixed(2)}h`;
}

function formatDurationMicros(value: number): string {
  if (value < 1_000) return `${Math.round(value)} µs`;
  if (value < 1_000_000) return `${(value / 1_000).toFixed(2)} ms`;
  return `${(value / 1_000_000).toFixed(2)} s`;
}

function processIdentityKey(process: ResourceTelemetryProcess): string {
  return `${process.identity.pid}:${process.identity.startTimeMs}`;
}

function processSummaryIdentityKey(process: ResourceTelemetryProcessSummary): string {
  return `${process.identity.pid}:${process.identity.startTimeMs}`;
}

function formatProcessName(process: Pick<ResourceTelemetryProcess, "command" | "name">): string {
  if (process.name.trim()) return process.name;
  const firstToken = process.command.trim().split(/\s+/)[0] ?? process.command;
  const normalized = firstToken.replace(/^['"]|['"]$/g, "");
  return normalized.split(/[\\/]/).findLast((segment) => segment.length > 0) ?? normalized;
}

function categoryLabel(category: ResourceTelemetryProcessCategory): string {
  switch (category) {
    case "server":
      return "Server";
    case "server-child":
      return "Backend child";
    case "provider-root":
      return "Provider";
    case "terminal-root":
      return "Terminal";
    case "electron-main":
      return "Electron main";
    case "electron-renderer":
      return "Renderer";
    case "electron-gpu":
      return "GPU";
    case "electron-utility":
      return "Electron utility";
    case "resource-monitor":
      return "Monitor";
    case "unknown-t3":
      return "T3 process";
  }
}

function categoryDotClass(category: ResourceTelemetryProcessCategory): string {
  if (category === "resource-monitor") return "bg-amber-500";
  if (category.startsWith("electron-")) return "bg-sky-500";
  if (category === "server") return "bg-violet-500";
  return "bg-emerald-500";
}

function ioSemanticsLabel(semantics: ResourceTelemetryIoSemantics): string {
  switch (semantics) {
    case "storage":
      return "Storage bytes";
    case "logical":
      return "Logical bytes";
    case "all-io":
      return "All I/O bytes";
    case "unavailable":
      return "Unavailable";
  }
}

function booleanStateLabel(
  value: BackgroundBooleanState,
  labels: { readonly true: string; readonly false: string },
): string {
  if (value === "true") return labels.true;
  if (value === "false") return labels.false;
  return "Unknown";
}

function sourceStatusTone(status: ResourceTelemetrySourceStatus): "default" | "warning" | "danger" {
  if (status === "healthy") return "default";
  if (status === "starting" || status === "degraded") return "warning";
  return "danger";
}

function SourceStatusBadge({
  label,
  status,
}: {
  label: string;
  status: ResourceTelemetrySourceStatus;
}) {
  const tone = sourceStatusTone(status);
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.08em]",
        tone === "default" &&
          "border-emerald-500/20 bg-emerald-500/8 text-emerald-700 dark:text-emerald-300",
        tone === "warning" &&
          "border-amber-500/25 bg-amber-500/8 text-amber-700 dark:text-amber-300",
        tone === "danger" && "border-destructive/25 bg-destructive/8 text-destructive",
      )}
    >
      <span
        className={cn(
          "size-1.5 rounded-full",
          tone === "default" && "bg-emerald-500",
          tone === "warning" && "bg-amber-500",
          tone === "danger" && "bg-destructive",
        )}
      />
      {label} {status}
    </span>
  );
}

function LastSampleLabel({ sampledAt }: { sampledAt: DateTime.Utc | null }) {
  useRelativeTimeTick();
  if (!sampledAt) {
    return <span className="text-[11px] text-muted-foreground/55">Waiting for sample</span>;
  }
  const relative = formatRelativeTime(DateTime.formatIso(sampledAt));
  return (
    <span className="text-[11px] text-muted-foreground/60">
      Updated <span className="font-mono tabular-nums">{relative.value}</span>
      {relative.suffix ? ` ${relative.suffix}` : ""}
    </span>
  );
}

function IconStat({
  icon,
  label,
  value,
  detail,
  tone = "default",
}: {
  icon: ReactNode;
  label: string;
  value: string;
  detail?: string | undefined;
  tone?: "default" | "warning" | "danger";
}) {
  return (
    <div className="min-w-0 border-border/60 px-4 py-3.5 sm:px-5">
      <div className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.1em] text-muted-foreground/65">
        <span className="text-muted-foreground/50">{icon}</span>
        <span className="truncate">{label}</span>
      </div>
      <div
        className={cn(
          "mt-2 truncate font-mono text-xl font-semibold tracking-[-0.04em] tabular-nums text-foreground",
          tone === "warning" && "text-amber-600 dark:text-amber-300",
          tone === "danger" && "text-destructive",
        )}
      >
        {value}
      </div>
      {detail ? (
        <div className="mt-1 truncate text-[10px] text-muted-foreground/55">{detail}</div>
      ) : null}
    </div>
  );
}

function AggregateCard({
  label,
  accentClass,
  aggregate,
}: {
  label: string;
  accentClass: string;
  aggregate: ResourceTelemetryAggregate;
}) {
  return (
    <div className="relative overflow-hidden border-t border-border/60 px-4 py-3.5 first:border-t-0 md:border-t-0 md:border-l md:first:border-l-0 sm:px-5">
      <span className={cn("absolute inset-x-0 top-0 h-px opacity-80", accentClass)} />
      <div className="flex items-center justify-between gap-3">
        <div className="text-[10px] font-semibold uppercase tracking-[0.1em] text-muted-foreground/65">
          {label}
        </div>
        <div className="font-mono text-[10px] tabular-nums text-muted-foreground/55">
          {aggregate.processCount} proc
        </div>
      </div>
      <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2">
        <MetricPair label="CPU" value={`${aggregate.currentCpuPercent.toFixed(1)}%`} />
        <MetricPair label="Memory" value={formatBytes(aggregate.currentRssBytes)} />
        <MetricPair label="Read" value={formatRate(aggregate.ioReadBytesPerSecond)} />
        <MetricPair label="Write" value={formatRate(aggregate.ioWriteBytesPerSecond)} />
      </div>
    </div>
  );
}

function MetricPair({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <div className="text-[9px] font-semibold uppercase tracking-[0.08em] text-muted-foreground/45">
        {label}
      </div>
      <div className="truncate font-mono text-xs font-medium tabular-nums text-foreground/90">
        {value}
      </div>
    </div>
  );
}

function HealthSource({ label, health }: { label: string; health: ResourceTelemetrySourceHealth }) {
  return (
    <div className="flex items-start justify-between gap-4 border-t border-border/50 py-2.5 first:border-t-0">
      <div className="min-w-0">
        <div className="text-xs font-medium text-foreground">{label}</div>
        <div className="mt-0.5 truncate text-[10px] text-muted-foreground/60">
          {Option.match(health.lastError, {
            onNone: () => "No reported errors",
            onSome: (error) => error,
          })}
        </div>
      </div>
      <SourceStatusBadge label="" status={health.status} />
    </div>
  );
}

function DetailRow({
  label,
  value,
  valueClassName,
}: {
  label: string;
  value: ReactNode;
  valueClassName?: string | undefined;
}) {
  return (
    <div className="flex items-center justify-between gap-4 border-t border-border/50 py-2 first:border-t-0">
      <span className="text-[11px] text-muted-foreground/70">{label}</span>
      <span
        className={cn(
          "min-w-0 truncate text-right font-mono text-[11px] tabular-nums text-foreground/85",
          valueClassName,
        )}
      >
        {value}
      </span>
    </div>
  );
}

function HistoryWindowSelector({
  selectedWindowMs,
  onSelect,
}: {
  selectedWindowMs: number;
  onSelect: (windowMs: number) => void;
}) {
  return (
    <div className="flex items-center rounded-md border border-border/60 p-0.5">
      {HISTORY_WINDOWS.map((option) => (
        <button
          key={option.windowMs}
          type="button"
          className={cn(
            "h-6 rounded-sm px-2 text-[11px] font-medium text-muted-foreground hover:text-foreground",
            selectedWindowMs === option.windowMs && "bg-muted text-foreground",
          )}
          onClick={() => onSelect(option.windowMs)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

function ResourceHistoryChart({
  buckets,
}: {
  buckets: ReadonlyArray<ResourceTelemetryHistoryBucket>;
}) {
  const maxCpu = Math.max(1, ...buckets.map((bucket) => bucket.maxCpuPercent));
  const maxIo = Math.max(1, ...buckets.map((bucket) => bucket.ioReadBytes + bucket.ioWriteBytes));

  return (
    <div className="border-t border-border/60 px-4 py-4 sm:px-5">
      <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-[10px] text-muted-foreground/65">
        <span className="inline-flex items-center gap-1.5">
          <span className="h-1.5 w-3 rounded-full bg-foreground/70" /> CPU average
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="h-1.5 w-3 rounded-full bg-sky-500/70" /> I/O reads
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="h-1.5 w-3 rounded-full bg-amber-500/80" /> I/O writes
        </span>
      </div>
      <div className="flex h-32 items-end gap-1 overflow-hidden rounded-lg border border-border/40 bg-muted/8 px-2 pt-3 pb-2">
        {buckets.map((bucket) => {
          const cpuHeight = Math.max(2, (bucket.avgCpuPercent / maxCpu) * 100);
          const readHeight = Math.max(1, (bucket.ioReadBytes / maxIo) * 100);
          const writeHeight = Math.max(1, (bucket.ioWriteBytes / maxIo) * 100);
          return (
            <Tooltip key={DateTime.formatIso(bucket.startedAt)}>
              <TooltipTrigger
                render={
                  <div className="grid h-full min-w-1 flex-1 grid-cols-3 items-end gap-px">
                    <span
                      className="block min-h-px rounded-t-sm bg-foreground/65"
                      style={{ height: `${cpuHeight}%` }}
                    />
                    <span
                      className="block min-h-px rounded-t-sm bg-sky-500/70"
                      style={{ height: `${readHeight}%` }}
                    />
                    <span
                      className="block min-h-px rounded-t-sm bg-amber-500/80"
                      style={{ height: `${writeHeight}%` }}
                    />
                  </div>
                }
              />
              <TooltipPopup side="top" className="space-y-0.5 text-left">
                <div>CPU avg {bucket.avgCpuPercent.toFixed(1)}%</div>
                <div>CPU peak {bucket.maxCpuPercent.toFixed(1)}%</div>
                <div>Read {formatBytes(bucket.ioReadBytes)}</div>
                <div>Write {formatBytes(bucket.ioWriteBytes)}</div>
              </TooltipPopup>
            </Tooltip>
          );
        })}
      </div>
    </div>
  );
}

function ProcessTreeName({
  process,
  collapsed,
  onToggle,
}: {
  process: ResourceTelemetryProcess;
  collapsed: boolean;
  onToggle: (process: ResourceTelemetryProcess) => void;
}) {
  const name = formatProcessName(process);
  const hasChildren = process.childPids.length > 0;
  const ChevronIcon = collapsed ? ChevronRightIcon : ChevronDownIcon;
  return (
    <div
      className="grid min-w-0 grid-cols-[1.25rem_0.375rem_minmax(0,1fr)] items-center gap-2"
      style={{ paddingLeft: `${Math.min(process.depth, 7) * 10}px` }}
    >
      {hasChildren ? (
        <button
          type="button"
          className="inline-flex size-5 items-center justify-center rounded-sm text-muted-foreground hover:bg-accent hover:text-foreground"
          onClick={() => onToggle(process)}
          aria-label={collapsed ? `Expand ${name}` : `Collapse ${name}`}
        >
          <ChevronIcon className="size-3.5" />
        </button>
      ) : (
        <span className="size-5" aria-hidden />
      )}
      <span className={cn("size-1.5 rounded-full", categoryDotClass(process.category))} />
      <Tooltip>
        <TooltipTrigger
          render={<span className="min-w-0 truncate font-medium text-foreground">{name}</span>}
        />
        <TooltipPopup
          side="top"
          className="max-w-[min(520px,calc(100vw-2rem))] whitespace-normal break-words text-left font-mono text-[11px]"
        >
          {process.command || process.name}
        </TooltipPopup>
      </Tooltip>
    </div>
  );
}

function canSignalProcess(process: ResourceTelemetryProcess): boolean {
  return (
    process.category === "server-child" ||
    process.category === "provider-root" ||
    process.category === "terminal-root"
  );
}

function ProcessActions({
  process,
  signalingKey,
  onSignal,
}: {
  process: ResourceTelemetryProcess;
  signalingKey: string | null;
  onSignal: (process: ResourceTelemetryProcess, signal: ServerProcessSignal) => void;
}) {
  if (!canSignalProcess(process)) {
    return <span className="text-[10px] text-muted-foreground/35">—</span>;
  }
  const isSignaling = signalingKey === processIdentityKey(process);
  return (
    <div className="flex items-center justify-end gap-1.5">
      <button
        type="button"
        disabled={isSignaling}
        className="text-[10px] font-semibold text-muted-foreground hover:text-foreground disabled:opacity-50"
        onClick={() => onSignal(process, "SIGINT")}
      >
        INT
      </button>
      <button
        type="button"
        disabled={isSignaling}
        className="text-[10px] font-semibold text-destructive hover:underline disabled:opacity-50"
        onClick={() => onSignal(process, "SIGKILL")}
      >
        KILL
      </button>
    </div>
  );
}

function ProcessTable({
  processes,
  signalingKey,
  onSignal,
}: {
  processes: ReadonlyArray<ResourceTelemetryProcess>;
  signalingKey: string | null;
  onSignal: (process: ResourceTelemetryProcess, signal: ServerProcessSignal) => void;
}) {
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
  const visible = useMemo(() => {
    const result: ResourceTelemetryProcess[] = [];
    let hiddenDepth: number | null = null;
    for (const process of processes) {
      if (hiddenDepth !== null) {
        if (process.depth > hiddenDepth) continue;
        hiddenDepth = null;
      }
      result.push(process);
      if (collapsed.has(processIdentityKey(process))) {
        hiddenDepth = process.depth;
      }
    }
    return result;
  }, [collapsed, processes]);
  const toggle = useCallback((process: ResourceTelemetryProcess) => {
    const identityKey = processIdentityKey(process);
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(identityKey)) {
        next.delete(identityKey);
      } else {
        next.add(identityKey);
      }
      return next;
    });
  }, []);

  return (
    <ScrollArea
      chainVerticalScroll
      scrollFade
      hideScrollbars
      className="max-h-[min(68vh,48rem)] w-full max-w-full border-t border-border/60"
    >
      <table className="w-full min-w-[1320px] table-fixed text-left text-xs">
        <colgroup>
          <col className="w-[20%]" />
          <col className="w-[10%]" />
          <col className="w-[7%]" />
          <col className="w-[8%]" />
          <col className="w-[9%]" />
          <col className="w-[9%]" />
          <col className="w-[9%]" />
          <col className="w-[10%]" />
          <col className="w-[8%]" />
          <col className="w-[6%]" />
          <col className="w-[4%]" />
        </colgroup>
        <thead className="sticky top-0 z-10 border-b border-border/60 bg-card text-[10px] uppercase tracking-[0.08em] text-muted-foreground/65">
          <tr>
            <th className="px-4 py-2 font-semibold sm:pl-5">Process</th>
            <th className="px-3 py-2 font-semibold">Category</th>
            <th className="px-3 py-2 text-right font-semibold">CPU</th>
            <th className="px-3 py-2 text-right font-semibold">CPU Time</th>
            <th className="px-3 py-2 text-right font-semibold">Memory</th>
            <th className="px-3 py-2 text-right font-semibold">Read/s</th>
            <th className="px-3 py-2 text-right font-semibold">Write/s</th>
            <th className="px-3 py-2 text-right font-semibold">Read Total</th>
            <th className="px-3 py-2 text-right font-semibold">Write Total</th>
            <th className="px-3 py-2 text-right font-semibold">PID</th>
            <th className="px-2 py-2 text-right font-semibold sm:pr-4">Kill</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border/50">
          {visible.length === 0 ? (
            <tr>
              <td colSpan={11} className="px-4 py-5 text-xs text-muted-foreground sm:px-5">
                Waiting for the native process monitor.
              </td>
            </tr>
          ) : null}
          {visible.map((process) => (
            <tr key={processIdentityKey(process)} className="hover:bg-muted/20">
              <td className="px-4 py-2 sm:pl-5">
                <ProcessTreeName
                  process={process}
                  collapsed={collapsed.has(processIdentityKey(process))}
                  onToggle={toggle}
                />
              </td>
              <td className="truncate px-3 py-2 text-[11px] text-muted-foreground">
                {categoryLabel(process.category)}
              </td>
              <td className="px-3 py-2 text-right font-mono tabular-nums">
                {process.cpuPercent.toFixed(1)}%
              </td>
              <td className="px-3 py-2 text-right font-mono tabular-nums">
                {formatCpuTime(process.cpuTimeMs)}
              </td>
              <td className="px-3 py-2 text-right font-mono tabular-nums">
                {formatBytes(process.residentBytes)}
              </td>
              <td className="px-3 py-2 text-right font-mono tabular-nums text-sky-700 dark:text-sky-300">
                {formatRate(process.ioReadBytesPerSecond)}
              </td>
              <td className="px-3 py-2 text-right font-mono tabular-nums text-amber-700 dark:text-amber-300">
                {formatRate(process.ioWriteBytesPerSecond)}
              </td>
              <td className="px-3 py-2 text-right font-mono tabular-nums text-muted-foreground">
                {formatBytes(process.ioReadBytes)}
              </td>
              <td className="px-3 py-2 text-right font-mono tabular-nums text-muted-foreground">
                <Tooltip>
                  <TooltipTrigger render={<span>{formatBytes(process.ioWriteBytes)}</span>} />
                  <TooltipPopup side="top">{ioSemanticsLabel(process.ioSemantics)}</TooltipPopup>
                </Tooltip>
              </td>
              <td className="px-3 py-2 text-right font-mono tabular-nums text-muted-foreground">
                {process.identity.pid}
              </td>
              <td className="px-2 py-2 text-right sm:pr-4">
                <ProcessActions process={process} signalingKey={signalingKey} onSignal={onSignal} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </ScrollArea>
  );
}

function HistoryProcessTable({
  processes,
}: {
  processes: ReadonlyArray<ResourceTelemetryProcessSummary>;
}) {
  return (
    <ScrollArea
      chainVerticalScroll
      scrollFade
      hideScrollbars
      className="max-h-[28rem] w-full max-w-full border-t border-border/60"
    >
      <table className="w-full min-w-[1020px] table-fixed text-left text-xs">
        <colgroup>
          <col className="w-[24%]" />
          <col className="w-[11%]" />
          <col className="w-[10%]" />
          <col className="w-[10%]" />
          <col className="w-[11%]" />
          <col className="w-[11%]" />
          <col className="w-[11%]" />
          <col className="w-[7%]" />
          <col className="w-[5%]" />
        </colgroup>
        <thead className="sticky top-0 z-10 border-b border-border/60 bg-card text-[10px] uppercase tracking-[0.08em] text-muted-foreground/65">
          <tr>
            <th className="px-4 py-2 font-semibold sm:pl-5">Process</th>
            <th className="px-3 py-2 font-semibold">Category</th>
            <th className="px-3 py-2 text-right font-semibold">CPU Time</th>
            <th className="px-3 py-2 text-right font-semibold">Peak CPU</th>
            <th className="px-3 py-2 text-right font-semibold">Peak Mem</th>
            <th className="px-3 py-2 text-right font-semibold">Read</th>
            <th className="px-3 py-2 text-right font-semibold">Write</th>
            <th className="px-3 py-2 text-right font-semibold">Samples</th>
            <th className="px-3 py-2 text-right font-semibold sm:pr-5">PID</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border/50">
          {processes.length === 0 ? (
            <tr>
              <td colSpan={9} className="px-4 py-5 text-xs text-muted-foreground sm:px-5">
                No retained process samples in this window.
              </td>
            </tr>
          ) : null}
          {processes.map((process) => (
            <tr key={processSummaryIdentityKey(process)} className="hover:bg-muted/20">
              <td className="px-4 py-2 sm:pl-5">
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <span className="block truncate font-medium text-foreground">
                        {process.name || process.command}
                      </span>
                    }
                  />
                  <TooltipPopup
                    side="top"
                    className="max-w-[min(520px,calc(100vw-2rem))] whitespace-normal break-words text-left font-mono text-[11px]"
                  >
                    {process.command || process.name}
                  </TooltipPopup>
                </Tooltip>
              </td>
              <td className="truncate px-3 py-2 text-[11px] text-muted-foreground">
                {categoryLabel(process.category)}
              </td>
              <td className="px-3 py-2 text-right font-mono tabular-nums">
                {formatCpuTime(process.cpuTimeMs)}
              </td>
              <td className="px-3 py-2 text-right font-mono tabular-nums">
                {process.maxCpuPercent.toFixed(1)}%
              </td>
              <td className="px-3 py-2 text-right font-mono tabular-nums">
                {formatBytes(process.peakRssBytes)}
              </td>
              <td className="px-3 py-2 text-right font-mono tabular-nums text-sky-700 dark:text-sky-300">
                {formatBytes(process.ioReadBytes)}
              </td>
              <td className="px-3 py-2 text-right font-mono tabular-nums text-amber-700 dark:text-amber-300">
                {formatBytes(process.ioWriteBytes)}
              </td>
              <td className="px-3 py-2 text-right font-mono tabular-nums text-muted-foreground">
                {process.sampleCount}
              </td>
              <td className="px-3 py-2 text-right font-mono tabular-nums text-muted-foreground sm:pr-5">
                {process.identity.pid}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </ScrollArea>
  );
}

function AttributionTable({ entries }: { entries: ReadonlyArray<ResourceAttributionEntry> }) {
  return (
    <div className="overflow-x-auto border-t border-border/60">
      <table className="w-full min-w-[720px] table-fixed text-left text-xs">
        <colgroup>
          <col className="w-[22%]" />
          <col className="w-[28%]" />
          <col className="w-[14%]" />
          <col className="w-[14%]" />
          <col className="w-[10%]" />
          <col className="w-[12%]" />
        </colgroup>
        <thead className="border-b border-border/60 text-[10px] uppercase tracking-[0.08em] text-muted-foreground/65">
          <tr>
            <th className="px-4 py-2 font-semibold sm:pl-5">Component</th>
            <th className="px-3 py-2 font-semibold">Operation</th>
            <th className="px-3 py-2 text-right font-semibold">Logical Read</th>
            <th className="px-3 py-2 text-right font-semibold">Logical Write</th>
            <th className="px-3 py-2 text-right font-semibold">Count</th>
            <th className="px-3 py-2 text-right font-semibold sm:pr-5">Time</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border/50">
          {entries.length === 0 ? (
            <tr>
              <td colSpan={6} className="px-4 py-5 text-xs text-muted-foreground sm:px-5">
                No instrumented application I/O has been recorded yet.
              </td>
            </tr>
          ) : null}
          {entries.map((entry) => (
            <tr key={`${entry.component}:${entry.operation}`} className="hover:bg-muted/20">
              <td className="truncate px-4 py-2 font-medium text-foreground sm:pl-5">
                {entry.component}
              </td>
              <td className="truncate px-3 py-2 text-muted-foreground">{entry.operation}</td>
              <td className="px-3 py-2 text-right font-mono tabular-nums text-sky-700 dark:text-sky-300">
                {formatBytes(entry.logicalReadBytes)}
              </td>
              <td className="px-3 py-2 text-right font-mono tabular-nums text-amber-700 dark:text-amber-300">
                {formatBytes(entry.logicalWriteBytes)}
              </td>
              <td className="px-3 py-2 text-right font-mono tabular-nums">{entry.count}</td>
              <td className="px-3 py-2 text-right font-mono tabular-nums text-muted-foreground sm:pr-5">
                {(entry.durationMs / 1_000).toFixed(2)}s
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function ResourceTelemetryDiagnostics() {
  const [windowMs, setWindowMs] = useState(15 * 60_000);
  const selectedWindow =
    HISTORY_WINDOWS.find((option) => option.windowMs === windowMs) ?? HISTORY_WINDOWS[1];
  const telemetry = useResourceTelemetry();
  const retryTelemetry = telemetry.retry;
  const history = useResourceTelemetryHistory({
    windowMs: selectedWindow.windowMs,
    bucketMs: selectedWindow.bucketMs,
  });
  const primaryEnvironment = usePrimaryEnvironment();
  const signalServerProcess = useAtomCommand(serverEnvironment.signalProcess, {
    reportFailure: false,
  });
  const [signalingKey, setSignalingKey] = useState<string | null>(null);
  const [isRetrying, setIsRetrying] = useState(false);
  const snapshot = telemetry.data;
  const allT3 = snapshot?.groups.allT3;

  const signalProcess = useCallback(
    (process: ResourceTelemetryProcess, signal: ServerProcessSignal) => {
      if (
        signal === "SIGKILL" &&
        !window.confirm(
          `Send SIGKILL to process ${process.identity.pid}? This cannot be handled by the process.`,
        )
      ) {
        return;
      }
      const identityKey = processIdentityKey(process);
      const environmentId = primaryEnvironment?.environmentId;
      if (environmentId === undefined) {
        return;
      }
      setSignalingKey(identityKey);
      void signalServerProcess({
        environmentId,
        input: {
          pid: process.identity.pid,
          startTimeMs: process.identity.startTimeMs,
          signal,
        },
      })
        .then((result) => {
          if (result._tag === "Failure") {
            if (isAtomCommandInterrupted(result)) return;
            throw squashAtomCommandFailure(result);
          }
          if (result.value.signaled) return;
          toastManager.add({
            type: "error",
            title: `Could not send ${signal}`,
            description: Option.getOrElse(
              result.value.message,
              () => `Failed to send ${signal} to process ${process.identity.pid}.`,
            ),
          });
        })
        .catch((error: unknown) => {
          toastManager.add({
            type: "error",
            title: `Could not send ${signal}`,
            description: error instanceof Error ? error.message : `Failed to send ${signal}.`,
          });
        })
        .finally(() => {
          setSignalingKey((current) => (current === identityKey ? null : current));
        });
    },
    [primaryEnvironment?.environmentId, signalServerProcess],
  );

  const retryCollector = useCallback(() => {
    setIsRetrying(true);
    void retryTelemetry()
      .catch((error: unknown) => {
        toastManager.add({
          type: "error",
          title: "Could not restart resource monitor",
          description:
            error instanceof Error ? error.message : "The resource monitor retry failed.",
        });
      })
      .finally(() => {
        setIsRetrying(false);
      });
  }, [retryTelemetry]);

  const speedLimit = snapshot ? Option.getOrNull(snapshot.speedLimitPercent) : null;
  const collectorNeedsRetry =
    snapshot?.health.native.status === "degraded" ||
    snapshot?.health.native.status === "unavailable" ||
    snapshot?.health.native.status === "stopped";

  return (
    <>
      <SettingsSection
        title="Resource Overview"
        headerAction={
          <div className="flex items-center gap-2">
            {snapshot ? (
              <SourceStatusBadge label="Native" status={snapshot.health.native.status} />
            ) : null}
            <LastSampleLabel sampledAt={snapshot?.readAt ?? null} />
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    className="size-5 rounded-sm p-0"
                    disabled={telemetry.isPending}
                    onClick={telemetry.refresh}
                    aria-label="Refresh resource telemetry"
                  >
                    <RefreshCwIcon
                      className={cn("size-3", telemetry.isPending && "animate-spin")}
                    />
                  </Button>
                }
              />
              <TooltipPopup side="top">Refresh telemetry snapshot</TooltipPopup>
            </Tooltip>
          </div>
        }
      >
        <div className="grid grid-cols-2 divide-x divide-y divide-border/60 md:grid-cols-3">
          <IconStat
            icon={<CpuIcon className="size-3.5" />}
            label="Current CPU"
            value={allT3 ? `${allT3.currentCpuPercent.toFixed(1)}%` : "..."}
            detail={allT3 ? `${formatCpuTime(allT3.cpuTimeMs)} observed CPU time` : undefined}
          />
          <IconStat
            icon={<MemoryStickIcon className="size-3.5" />}
            label="Resident Memory"
            value={allT3 ? formatBytes(allT3.currentRssBytes) : "..."}
            detail={allT3 ? `${formatBytes(allT3.peakRssBytes)} process peaks` : undefined}
          />
          <IconStat
            icon={<HardDriveIcon className="size-3.5" />}
            label="I/O Reads"
            value={allT3 ? formatRate(allT3.ioReadBytesPerSecond) : "..."}
            detail={allT3 ? `${formatBytes(allT3.ioReadBytes)} observed` : undefined}
          />
          <IconStat
            icon={<DatabaseIcon className="size-3.5" />}
            label="I/O Writes"
            value={allT3 ? formatRate(allT3.ioWriteBytesPerSecond) : "..."}
            detail={allT3 ? `${formatBytes(allT3.ioWriteBytes)} observed` : undefined}
            tone={
              allT3 && allT3.ioWriteBytesPerSecond >= 10 * 1_024 * 1_024
                ? "danger"
                : allT3 && allT3.ioWriteBytesPerSecond >= 1_024 * 1_024
                  ? "warning"
                  : "default"
            }
          />
          <IconStat
            icon={<ActivityIcon className="size-3.5" />}
            label="Processes"
            value={allT3 ? String(allT3.processCount) : "..."}
            detail={
              allT3 ? `${allT3.processStarts} starts · ${allT3.processExits} exits` : undefined
            }
          />
          <IconStat
            icon={<GaugeIcon className="size-3.5" />}
            label="CPU Speed Limit"
            value={
              snapshot ? (speedLimit === null ? "Unknown" : `${speedLimit.toFixed(0)}%`) : "..."
            }
            detail={snapshot ? `${snapshot.power.thermalState} thermal state` : undefined}
            tone={speedLimit !== null && speedLimit < 80 ? "warning" : "default"}
          />
        </div>
        {telemetry.error ? (
          <div className="flex items-start gap-2 border-t border-border/60 px-4 py-3 text-xs text-destructive sm:px-5">
            <AlertTriangleIcon className="mt-0.5 size-3.5 shrink-0" />
            <span>{telemetry.error}</span>
          </div>
        ) : null}
        {snapshot ? (
          <div className="grid md:grid-cols-3">
            <AggregateCard
              label="Backend + Agents"
              accentClass="bg-emerald-500/80"
              aggregate={snapshot.groups.backend}
            />
            <AggregateCard
              label="Electron"
              accentClass="bg-sky-500/80"
              aggregate={snapshot.groups.electron}
            />
            <AggregateCard
              label="Monitor Overhead"
              accentClass="bg-amber-500/80"
              aggregate={snapshot.groups.monitor}
            />
          </div>
        ) : null}
      </SettingsSection>

      <SettingsSection
        title="Power & Collector"
        headerAction={
          collectorNeedsRetry ? (
            <Button size="xs" variant="outline" disabled={isRetrying} onClick={retryCollector}>
              <RotateCcwIcon className={cn("size-3", isRetrying && "animate-spin")} />
              Retry monitor
            </Button>
          ) : null
        }
      >
        <div className="grid md:grid-cols-2 md:divide-x md:divide-border/60">
          <div className="px-4 py-3.5 sm:px-5">
            <div className="mb-2 flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.1em] text-muted-foreground/60">
              <BatteryIcon className="size-3.5" /> Host state
            </div>
            <DetailRow
              label="Power source"
              value={
                snapshot
                  ? booleanStateLabel(snapshot.power.onBattery, {
                      true: "Battery",
                      false: "External power",
                    })
                  : "Unknown"
              }
            />
            <DetailRow
              label="Low power mode"
              value={
                snapshot
                  ? booleanStateLabel(snapshot.power.lowPowerMode, {
                      true: "Enabled",
                      false: "Disabled",
                    })
                  : "Unknown"
              }
            />
            <DetailRow
              label="Idle"
              value={
                snapshot
                  ? `${booleanStateLabel(snapshot.power.idle, {
                      true: "Idle",
                      false: "Active",
                    })}${
                      snapshot.power.idleSeconds === null
                        ? ""
                        : ` · ${Math.round(snapshot.power.idleSeconds)}s`
                    }`
                  : "Unknown"
              }
            />
            <DetailRow
              label="Session"
              value={
                snapshot
                  ? snapshot.power.suspended
                    ? "Suspended"
                    : booleanStateLabel(snapshot.power.locked, {
                        true: "Locked",
                        false: "Unlocked",
                      })
                  : "Unknown"
              }
            />
            <DetailRow
              label="Thermal"
              value={snapshot?.power.thermalState ?? "unknown"}
              valueClassName={
                snapshot?.power.thermalState === "serious" ||
                snapshot?.power.thermalState === "critical"
                  ? "text-destructive"
                  : undefined
              }
            />
          </div>
          <div className="border-t border-border/60 px-4 py-3.5 md:border-t-0 sm:px-5">
            <div className="mb-2 flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.1em] text-muted-foreground/60">
              <GaugeIcon className="size-3.5" /> Collection health
            </div>
            {snapshot ? (
              <>
                <HealthSource label="Native process monitor" health={snapshot.health.native} />
                <HealthSource label="Electron main process" health={snapshot.health.desktop} />
                <DetailRow
                  label="Collection time"
                  value={formatDurationMicros(snapshot.health.collectionDurationMicros)}
                />
                <DetailRow
                  label="Process scan"
                  value={`${snapshot.health.retainedProcessCount}/${snapshot.health.scannedProcessCount} retained`}
                />
                <DetailRow
                  label="Inaccessible"
                  value={String(snapshot.health.inaccessibleProcessCount)}
                  valueClassName={
                    snapshot.health.inaccessibleProcessCount > 0
                      ? "text-amber-600 dark:text-amber-300"
                      : undefined
                  }
                />
                <DetailRow
                  label="Sidecar"
                  value={Option.match(snapshot.health.sidecarVersion, {
                    onNone: () => "Unavailable",
                    onSome: (version) =>
                      `${version}${Option.match(snapshot.health.sidecarPid, {
                        onNone: () => "",
                        onSome: (pid) => ` · PID ${pid}`,
                      })}`,
                  })}
                />
                <DetailRow label="Restarts" value={String(snapshot.health.restartCount)} />
              </>
            ) : (
              <div className="py-4 text-xs text-muted-foreground">
                Waiting for collector health.
              </div>
            )}
          </div>
        </div>
      </SettingsSection>

      <SettingsSection
        title="Resource Timeline"
        headerAction={
          <div className="flex items-center gap-2">
            <HistoryWindowSelector selectedWindowMs={windowMs} onSelect={setWindowMs} />
            <Button
              size="icon-xs"
              variant="ghost"
              className="size-5 rounded-sm p-0"
              disabled={history.isPending}
              onClick={history.refresh}
              aria-label="Refresh resource history"
            >
              <RefreshCwIcon className={cn("size-3", history.isPending && "animate-spin")} />
            </Button>
          </div>
        }
      >
        {history.error ? (
          <div className="flex items-start gap-2 px-4 py-3 text-xs text-destructive sm:px-5">
            <AlertTriangleIcon className="mt-0.5 size-3.5 shrink-0" />
            <span>{history.error}</span>
          </div>
        ) : null}
        <ResourceHistoryChart buckets={history.data?.buckets ?? []} />
        <HistoryProcessTable processes={history.data?.topProcesses ?? []} />
      </SettingsSection>

      <SettingsSection
        title="Live Process Tree"
        headerAction={
          snapshot ? (
            <span className="text-[10px] text-muted-foreground/55">
              Identity: <span className="font-mono">PID + start time</span>
            </span>
          ) : null
        }
      >
        <ProcessTable
          processes={snapshot?.processes ?? []}
          signalingKey={signalingKey}
          onSignal={signalProcess}
        />
      </SettingsSection>

      <SettingsSection
        title="Instrumented Application I/O"
        headerAction={
          <span className="text-[10px] text-muted-foreground/55">Logical bytes by operation</span>
        }
      >
        <div className="px-4 py-3 text-[11px] leading-relaxed text-muted-foreground sm:px-5">
          Native counters identify which process is reading or writing. These application-level
          counters identify known T3 operations so process spikes can be correlated with specific
          persistence and logging paths.
        </div>
        <AttributionTable entries={snapshot?.attribution.entries ?? []} />
      </SettingsSection>
    </>
  );
}
