import { msg, useMessages } from "gt-react";
import { ProcessSignalActions } from "./ProcessSignalActions";
import { AuthEnvironmentMaintainScope } from "@t3tools/contracts";
import { RefreshIcon } from "~/components/ui/refresh-icon";
import {
  ActivityIcon,
  AlertTriangleIcon,
  BatteryIcon,
  CpuIcon,
  DatabaseIcon,
  GaugeIcon,
  HardDriveIcon,
  MemoryStickIcon,
  ChevronDownIcon,
  ChevronRightIcon,
} from "lucide-react";
import type {
  BackgroundBooleanState,
  EnvironmentId,
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
import { RegistryContext } from "@effect/atom-react";
import { useContext, useRef, useState, type ReactNode } from "react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";

import {
  useResourceTelemetry,
  useResourceTelemetryHistory,
} from "../../lib/resourceTelemetryState";
import { cn } from "../../lib/utils";
import { formatBytes } from "../../lib/formatBytes";
import { ensureLocalApi } from "../../localApi";
import { serverEnvironment } from "../../state/server";
import { readEnvironmentScope, useEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { useRelativeTimeState } from "../../hooks/useRelativeTimeState";
import { Button } from "../ui/button";
import { ScrollArea } from "../ui/scroll-area";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { toastManager } from "../ui/toast";
import {
  formatCpuTime,
  processIdentityKey,
  resourceHistoryBarHeight,
  resourceHistoryCpuScaleMax,
  shouldShowResourceMonitorRetry,
  visibleResourceTelemetryProcesses,
} from "./ResourceTelemetryDiagnostics.logic";
import { SettingsSection } from "./settingsLayout";

const HISTORY_WINDOWS = [
  { label: "5m", windowMs: 5 * 60_000, bucketMs: 15_000 },
  { label: "15m", windowMs: 15 * 60_000, bucketMs: 30_000 },
  { label: "30m", windowMs: 30 * 60_000, bucketMs: 60_000 },
  { label: "1h", windowMs: 60 * 60_000, bucketMs: 2 * 60_000 },
] as const;

function formatRate(value: number): string {
  return `${formatBytes(value)}/s`;
}

function samplingStatusLabel(intervalMs: number, m: ReturnType<typeof useMessages>): string {
  if (intervalMs <= 0) return m(msg("Sampling on demand"));
  if (intervalMs < 1_000) {
    return `${m(msg("Sampling every"))} ${Math.round(intervalMs)} ${m(msg("milliseconds"))}`;
  }
  const seconds = intervalMs / 1_000;
  return `${m(msg("Sampling every"))} ${seconds.toLocaleString(undefined, {
    maximumFractionDigits: 1,
  })} ${m(seconds === 1 ? msg("second") : msg("seconds"))}`;
}

function formatDurationMicros(value: number): string {
  if (value < 1_000) return `${Math.round(value)} µs`;
  if (value < 1_000_000) return `${(value / 1_000).toFixed(2).replace(/\.0+$/, "")} ms`;
  return `${(value / 1_000_000).toFixed(2).replace(/\.0+$/, "")} s`;
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
      return msg("Server");
    case "server-child":
      return msg("Backend child");
    case "provider-root":
      return msg("Provider");
    case "terminal-root":
      return msg("Terminal");
    case "electron-main":
      return msg("Electron main");
    case "electron-renderer":
      return msg("Renderer");
    case "electron-gpu":
      return msg("GPU");
    case "electron-utility":
      return msg("Electron utility");
    case "resource-monitor":
      return msg("Monitor");
    case "unknown-t3":
      return msg("T3 process");
  }
}

function categoryDotClass(category: ResourceTelemetryProcessCategory): string {
  if (category === "resource-monitor") return "bg-warning";
  if (category.startsWith("electron-")) return "bg-info";
  if (category === "server") return "bg-violet-500";
  return "bg-success";
}

function ioSemanticsLabel(semantics: ResourceTelemetryIoSemantics): string {
  switch (semantics) {
    case "storage":
      return msg("Storage bytes");
    case "logical":
      return msg("Logical bytes");
    case "all-io":
      return msg("All I/O bytes");
    case "unavailable":
      return msg("Unavailable");
  }
}

function booleanStateLabel(
  value: BackgroundBooleanState,
  labels: { readonly true: string; readonly false: string },
): string {
  if (value === "true") return labels.true;
  if (value === "false") return labels.false;
  return msg("Unknown");
}

const THERMAL_STATE_MESSAGES = {
  unknown: msg("Unknown"),
  nominal: msg("Nominal"),
  fair: msg("Fair"),
  serious: msg("Serious"),
  critical: msg("Critical"),
} as const;

function resourceTelemetryErrorLabel(error: string, m: ReturnType<typeof useMessages>): string {
  const missingMonitor = /^Resource monitor binary was not found for ([^.]+)\.$/.exec(error);
  return missingMonitor
    ? `${m(msg("Resource monitor binary not found"))} (${missingMonitor[1]})`
    : error;
}

function sourceStatusTone(status: ResourceTelemetrySourceStatus): "default" | "warning" | "danger" {
  if (status === "healthy") return "default";
  if (status === "starting" || status === "degraded") return "warning";
  return "danger";
}

function sourceStatusLabel(status: ResourceTelemetrySourceStatus): string {
  switch (status) {
    case "healthy":
      return msg("Healthy");
    case "starting":
      return msg("Starting");
    case "degraded":
      return msg("Degraded");
    case "unavailable":
      return msg("Unavailable");
    case "stopped":
      return msg("Stopped");
    default:
      return msg("Unknown");
  }
}

function SourceStatusBadge({
  label,
  status,
  presentation,
}: {
  label: string;
  status: ResourceTelemetrySourceStatus;
  presentation?:
    | {
        readonly label: string;
        readonly tone: "neutral";
      }
    | undefined;
}) {
  const m = useMessages();
  const tone = presentation?.tone ?? sourceStatusTone(status);
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-3xs font-semibold uppercase tracking-widest",
        tone === "neutral" && "border-border/70 bg-muted/45 text-muted-foreground",
        tone === "default" && "border-success/25 bg-success/10 text-success-foreground",
        tone === "warning" && "border-warning/30 bg-warning/10 text-warning-foreground",
        tone === "danger" && "border-destructive/30 bg-destructive/10 text-destructive",
      )}
    >
      <span
        className={cn(
          "size-1.5 rounded-full",
          tone === "neutral" && "bg-muted-foreground/55",
          tone === "default" && "bg-success",
          tone === "warning" && "bg-warning",
          tone === "danger" && "bg-destructive",
        )}
      />
      {label ? `${m(label)} ` : ""}
      {presentation?.label ? m(presentation.label) : m(sourceStatusLabel(status))}
    </span>
  );
}

function LastSampleLabel({ sampledAt }: { sampledAt: DateTime.Utc | null }) {
  const m = useMessages();
  const relative = useRelativeTimeState(sampledAt ? DateTime.formatIso(sampledAt) : null);
  if (relative.status !== "relative") {
    return (
      <span className="text-2xs text-muted-foreground/55">{m(msg("Waiting for sample"))}</span>
    );
  }
  const relativeValue = relative.value === "just now" ? m(msg("just now")) : relative.value;
  return (
    <span className="text-2xs text-muted-foreground/60">
      {m(msg("Updated"))} <span className="font-mono tabular-nums">{relativeValue}</span>
      {relative.suffix ? ` ${m(msg("ago"))}` : ""}
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
  const m = useMessages();
  return (
    <div className="group min-w-0 px-4 py-4 sm:px-5">
      <div className="flex items-center gap-2 text-3xs font-semibold uppercase tracking-widest text-muted-foreground/70">
        <span className="text-muted-foreground/55 transition-colors group-hover:text-foreground/65">
          {icon}
        </span>
        <span className="truncate">{m(label)}</span>
      </div>
      <div
        className={cn(
          "mt-2.5 truncate font-mono text-2xl font-semibold tracking-tighter tabular-nums text-foreground",
          tone === "warning" && "text-warning-foreground",
          tone === "danger" && "text-destructive",
        )}
      >
        {value}
      </div>
      {detail ? (
        <div className="mt-1.5 truncate text-3xs text-muted-foreground/60">{detail}</div>
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
  const m = useMessages();
  return (
    <div className="relative overflow-hidden border-t border-border/60 px-4 py-4 first:border-t-0 md:border-t-0 md:border-l md:first:border-l-0 sm:px-5">
      <span className={cn("absolute inset-x-5 top-0 h-0.5 rounded-full opacity-75", accentClass)} />
      <div className="flex items-center justify-between gap-3">
        <div className="text-3xs font-semibold uppercase tracking-widest text-muted-foreground/75">
          {m(label)}
        </div>
        <div className="rounded-md bg-muted/55 px-1.5 py-0.5 font-mono text-3xs tabular-nums text-muted-foreground/70">
          {aggregate.processCount}{" "}
          {m(aggregate.processCount === 1 ? msg("process") : msg("processes"))}
        </div>
      </div>
      <div className="mt-3.5 grid grid-cols-2 gap-x-4 gap-y-2.5">
        <MetricPair label={msg("CPU")} value={`${aggregate.currentCpuPercent.toFixed(1)}%`} />
        <MetricPair label={msg("Memory")} value={formatBytes(aggregate.currentRssBytes)} />
        <MetricPair label={msg("Read")} value={formatRate(aggregate.ioReadBytesPerSecond)} />
        <MetricPair label={msg("Write")} value={formatRate(aggregate.ioWriteBytesPerSecond)} />
      </div>
    </div>
  );
}

function MetricPair({ label, value }: { label: string; value: string }) {
  const m = useMessages();
  return (
    <div className="min-w-0">
      <div className="text-3xs font-semibold uppercase tracking-widest text-muted-foreground/45">
        {m(label)}
      </div>
      <div className="truncate font-mono text-xs font-medium tabular-nums text-foreground/90">
        {value}
      </div>
    </div>
  );
}

function HealthSource({ label, health }: { label: string; health: ResourceTelemetrySourceHealth }) {
  const m = useMessages();
  const expectedInBrowser =
    health.status === "unavailable" &&
    Option.exists(health.lastError, (error) => error.includes("'web' mode"));
  return (
    <div className="flex items-start justify-between gap-4 border-t border-border/50 py-3 first:border-t-0">
      <div className="min-w-0">
        <div className="text-sm font-medium text-foreground">{m(label)}</div>
        <div className="mt-1 text-2xs leading-relaxed text-muted-foreground/65">
          {expectedInBrowser
            ? m(msg("Available when this page runs inside the desktop app."))
            : Option.match(health.lastError, {
                onNone: () => m(msg("No reported errors")),
                onSome: (error) => resourceTelemetryErrorLabel(error, m),
              })}
        </div>
      </div>
      <SourceStatusBadge
        label=""
        status={health.status}
        presentation={
          expectedInBrowser
            ? {
                label: m(msg("Desktop only")),
                tone: "neutral",
              }
            : undefined
        }
      />
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
  const m = useMessages();
  return (
    <div className="flex items-center justify-between gap-4 border-t border-border/50 py-2.5 first:border-t-0">
      <span className="text-2xs text-muted-foreground/75">{m(label)}</span>
      <span
        className={cn(
          "min-w-0 truncate text-right font-mono text-2xs tabular-nums text-foreground/85",
          valueClassName,
        )}
      >
        {typeof value === "string" ? m(value) : value}
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
  const m = useMessages();
  return (
    <ToggleGroup
      aria-label={m(msg("Resource history period"))}
      variant="segmented"
      value={[String(selectedWindowMs)]}
      onValueChange={(next) => {
        const selected = HISTORY_WINDOWS.find((option) => String(option.windowMs) === next[0]);
        if (selected) onSelect(selected.windowMs);
      }}
    >
      {HISTORY_WINDOWS.map((option) => (
        <Toggle key={option.windowMs} value={String(option.windowMs)}>
          {option.label}
        </Toggle>
      ))}
    </ToggleGroup>
  );
}

function ResourceHistoryChart({
  buckets,
}: {
  buckets: ReadonlyArray<ResourceTelemetryHistoryBucket>;
}) {
  const m = useMessages();
  const maxCpu = resourceHistoryCpuScaleMax(buckets);
  const maxIo = Math.max(1, ...buckets.map((bucket) => bucket.ioReadBytes + bucket.ioWriteBytes));

  return (
    <div className="border-t border-border/60 px-4 py-4 sm:px-5">
      <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-3xs text-muted-foreground/65">
        <span className="inline-flex items-center gap-1.5">
          <span className="h-1.5 w-3 rounded-full bg-foreground/70" /> {m(msg("CPU average"))}
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="h-1.5 w-3 rounded-full bg-info/70" /> {m(msg("I/O reads"))}
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="h-1.5 w-3 rounded-full bg-warning/80" /> {m(msg("I/O writes"))}
        </span>
      </div>
      <div className="flex h-32 items-end gap-1 overflow-hidden rounded-lg border border-border/40 bg-muted/8 px-2 pt-3 pb-2">
        {buckets.map((bucket) => {
          const cpuHeight = resourceHistoryBarHeight({
            value: bucket.avgCpuPercent,
            max: maxCpu,
            minimumVisiblePercent: 2,
          });
          const readHeight = resourceHistoryBarHeight({
            value: bucket.ioReadBytes,
            max: maxIo,
            minimumVisiblePercent: 1,
          });
          const writeHeight = resourceHistoryBarHeight({
            value: bucket.ioWriteBytes,
            max: maxIo,
            minimumVisiblePercent: 1,
          });
          return (
            <Tooltip key={DateTime.formatIso(bucket.startedAt)}>
              <TooltipTrigger
                render={
                  <div className="grid h-full min-w-1 flex-1 grid-cols-3 items-end gap-px">
                    <span
                      className="block rounded-t-sm bg-foreground/65"
                      style={{ height: `${cpuHeight}%` }}
                    />
                    <span
                      className="block rounded-t-sm bg-info/70"
                      style={{ height: `${readHeight}%` }}
                    />
                    <span
                      className="block rounded-t-sm bg-warning/80"
                      style={{ height: `${writeHeight}%` }}
                    />
                  </div>
                }
              />
              <TooltipPopup side="top" className="text-left">
                <div className="space-y-0.5">
                  <div>
                    {m(msg("CPU average"))} {bucket.avgCpuPercent.toFixed(1)}%
                  </div>
                  <div>
                    {m(msg("CPU peak"))} {bucket.maxCpuPercent.toFixed(1)}%
                  </div>
                  <div>
                    {m(msg("Read"))} {formatBytes(bucket.ioReadBytes)}
                  </div>
                  <div>
                    {m(msg("Write"))} {formatBytes(bucket.ioWriteBytes)}
                  </div>
                </div>
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
  return (
    <div
      className="grid min-w-0 grid-cols-[1.25rem_0.375rem_minmax(0,1fr)] items-center gap-2"
      style={{ paddingLeft: `${Math.min(process.depth, 7) * 10}px` }}
    >
      {hasChildren ? (
        <Button
          size="icon-micro"
          variant="ghost-muted"
          onClick={() => onToggle(process)}
          aria-label={collapsed ? `Expand ${name}` : `Collapse ${name}`}
        >
          {collapsed ? (
            <ChevronRightIcon className="size-3.5" />
          ) : (
            <ChevronDownIcon className="size-3.5" />
          )}
        </Button>
      ) : (
        <span className="size-5" aria-hidden />
      )}
      <span className={cn("size-1.5 rounded-full", categoryDotClass(process.category))} />
      <Tooltip>
        <TooltipTrigger
          render={<span className="min-w-0 truncate font-medium text-foreground">{name}</span>}
        />
        <TooltipPopup side="top" variant="code">
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
  canMaintainEnvironment,
  signalingKeys,
  onSignal,
}: {
  process: ResourceTelemetryProcess;
  canMaintainEnvironment: boolean;
  signalingKeys: ReadonlySet<string>;
  onSignal: (process: ResourceTelemetryProcess, signal: ServerProcessSignal) => void;
}) {
  if (!canSignalProcess(process)) {
    return <span className="text-3xs text-muted-foreground/35">-</span>;
  }
  const isSignaling = signalingKeys.has(processIdentityKey(process));
  return (
    <ProcessSignalActions
      disabled={!canMaintainEnvironment || isSignaling}
      onSignal={(signal) => onSignal(process, signal)}
    />
  );
}

function ProcessTable({
  processes,
  canMaintainEnvironment,
  signalingKeys,
  onSignal,
}: {
  processes: ReadonlyArray<ResourceTelemetryProcess>;
  canMaintainEnvironment: boolean;
  signalingKeys: ReadonlySet<string>;
  onSignal: (process: ResourceTelemetryProcess, signal: ServerProcessSignal) => void;
}) {
  const m = useMessages();
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
  const visible = visibleResourceTelemetryProcesses(processes, collapsed);
  const toggle = (process: ResourceTelemetryProcess) => {
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
  };

  return (
    <div className="border-t border-border/60">
      <ScrollArea
        chainVerticalScroll
        scrollFade
        hideScrollbars
        className="max-h-[min(68vh,48rem)] w-full max-w-full"
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
          <thead className="sticky top-0 z-10 border-b border-border/60 bg-card text-3xs uppercase tracking-widest text-muted-foreground/65">
            <tr>
              <th className="px-4 py-2 font-semibold sm:pl-5">{m(msg("Process"))}</th>
              <th className="px-3 py-2 font-semibold">{m(msg("Category"))}</th>
              <th className="px-3 py-2 text-right font-semibold">CPU</th>
              <th className="px-3 py-2 text-right font-semibold">{m(msg("CPU Time"))}</th>
              <th className="px-3 py-2 text-right font-semibold">{m(msg("Memory"))}</th>
              <th className="px-3 py-2 text-right font-semibold">{m(msg("Read/s"))}</th>
              <th className="px-3 py-2 text-right font-semibold">{m(msg("Write/s"))}</th>
              <th className="px-3 py-2 text-right font-semibold">{m(msg("Read Total"))}</th>
              <th className="px-3 py-2 text-right font-semibold">{m(msg("Write Total"))}</th>
              <th className="px-3 py-2 text-right font-semibold">PID</th>
              <th className="px-2 py-2 text-right font-semibold sm:pr-4">{m(msg("Kill"))}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border/50">
            {visible.length === 0 ? (
              <tr>
                <td colSpan={11} className="px-4 py-5 text-xs text-muted-foreground sm:px-5">
                  {m(msg("Waiting for the native process monitor."))}
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
                <td className="truncate px-3 py-2 text-2xs text-muted-foreground">
                  {m(categoryLabel(process.category))}
                </td>
                <td className="px-3 py-2 text-right font-mono tabular-nums">
                  {process.cpuPercent.toFixed(1)}%
                </td>
                <td className="px-3 py-2 text-right font-mono tabular-nums">
                  {formatCpuTime(process.cpuTimeMs / 1_000)}
                </td>
                <td className="px-3 py-2 text-right font-mono tabular-nums">
                  {formatBytes(process.residentBytes)}
                </td>
                <td className="px-3 py-2 text-right font-mono tabular-nums text-info-foreground">
                  {formatRate(process.ioReadBytesPerSecond)}
                </td>
                <td className="px-3 py-2 text-right font-mono tabular-nums text-warning-foreground">
                  {formatRate(process.ioWriteBytesPerSecond)}
                </td>
                <td className="px-3 py-2 text-right font-mono tabular-nums text-muted-foreground">
                  {formatBytes(process.ioReadBytes)}
                </td>
                <td className="px-3 py-2 text-right font-mono tabular-nums text-muted-foreground">
                  <Tooltip>
                    <TooltipTrigger render={<span>{formatBytes(process.ioWriteBytes)}</span>} />
                    <TooltipPopup side="top">
                      {m(ioSemanticsLabel(process.ioSemantics))}
                    </TooltipPopup>
                  </Tooltip>
                </td>
                <td className="px-3 py-2 text-right font-mono tabular-nums text-muted-foreground">
                  {process.identity.pid}
                </td>
                <td className="px-2 py-2 text-right sm:pr-4">
                  <ProcessActions
                    process={process}
                    canMaintainEnvironment={canMaintainEnvironment}
                    signalingKeys={signalingKeys}
                    onSignal={onSignal}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </ScrollArea>
    </div>
  );
}

function HistoryProcessTable({
  processes,
}: {
  processes: ReadonlyArray<ResourceTelemetryProcessSummary>;
}) {
  const m = useMessages();
  return (
    <div className="border-t border-border/60">
      <ScrollArea
        chainVerticalScroll
        scrollFade
        hideScrollbars
        className="max-h-[28rem] w-full max-w-full"
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
          <thead className="sticky top-0 z-10 border-b border-border/60 bg-card text-3xs uppercase tracking-widest text-muted-foreground/65">
            <tr>
              <th className="px-4 py-2 font-semibold sm:pl-5">{m(msg("Process"))}</th>
              <th className="px-3 py-2 font-semibold">{m(msg("Category"))}</th>
              <th className="px-3 py-2 text-right font-semibold">{m(msg("CPU Time"))}</th>
              <th className="px-3 py-2 text-right font-semibold">{m(msg("Peak CPU"))}</th>
              <th className="px-3 py-2 text-right font-semibold">{m(msg("Peak memory"))}</th>
              <th className="px-3 py-2 text-right font-semibold">{m(msg("Read"))}</th>
              <th className="px-3 py-2 text-right font-semibold">{m(msg("Write"))}</th>
              <th className="px-3 py-2 text-right font-semibold">{m(msg("Samples"))}</th>
              <th className="px-3 py-2 text-right font-semibold sm:pr-5">PID</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border/50">
            {processes.length === 0 ? (
              <tr>
                <td colSpan={9} className="px-4 py-5 text-xs text-muted-foreground sm:px-5">
                  {m(msg("No retained process samples in this window."))}
                </td>
              </tr>
            ) : null}
            {processes.map((process) => (
              <tr key={processIdentityKey(process)} className="hover:bg-muted/20">
                <td className="px-4 py-2 sm:pl-5">
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <span className="block truncate font-medium text-foreground">
                          {process.name || process.command}
                        </span>
                      }
                    />
                    <TooltipPopup side="top" variant="code">
                      {process.command || process.name}
                    </TooltipPopup>
                  </Tooltip>
                </td>
                <td className="truncate px-3 py-2 text-2xs text-muted-foreground">
                  {m(categoryLabel(process.category))}
                </td>
                <td className="px-3 py-2 text-right font-mono tabular-nums">
                  {formatCpuTime(process.cpuTimeMs / 1_000)}
                </td>
                <td className="px-3 py-2 text-right font-mono tabular-nums">
                  {process.maxCpuPercent.toFixed(1)}%
                </td>
                <td className="px-3 py-2 text-right font-mono tabular-nums">
                  {formatBytes(process.peakRssBytes)}
                </td>
                <td className="px-3 py-2 text-right font-mono tabular-nums text-info-foreground">
                  {formatBytes(process.ioReadBytes)}
                </td>
                <td className="px-3 py-2 text-right font-mono tabular-nums text-warning-foreground">
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
    </div>
  );
}

function AttributionTable({ entries }: { entries: ReadonlyArray<ResourceAttributionEntry> }) {
  const m = useMessages();
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
        <thead className="border-b border-border/60 text-3xs uppercase tracking-widest text-muted-foreground/65">
          <tr>
            <th className="px-4 py-2 font-semibold sm:pl-5">{m(msg("Component"))}</th>
            <th className="px-3 py-2 font-semibold">{m(msg("Operation"))}</th>
            <th className="px-3 py-2 text-right font-semibold">{m(msg("Logical Read"))}</th>
            <th className="px-3 py-2 text-right font-semibold">{m(msg("Logical Write"))}</th>
            <th className="px-3 py-2 text-right font-semibold">{m(msg("Count"))}</th>
            <th className="px-3 py-2 text-right font-semibold sm:pr-5">{m(msg("Time"))}</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border/50">
          {entries.length === 0 ? (
            <tr>
              <td colSpan={6} className="px-4 py-5 text-xs text-muted-foreground sm:px-5">
                {m(msg("No instrumented application I/O has been recorded yet."))}
              </td>
            </tr>
          ) : null}
          {entries.map((entry) => (
            <tr key={`${entry.component}:${entry.operation}`} className="hover:bg-muted/20">
              <td className="truncate px-4 py-2 font-medium text-foreground sm:pl-5">
                {entry.component}
              </td>
              <td className="truncate px-3 py-2 text-muted-foreground">{entry.operation}</td>
              <td className="px-3 py-2 text-right font-mono tabular-nums text-info-foreground">
                {formatBytes(entry.logicalReadBytes)}
              </td>
              <td className="px-3 py-2 text-right font-mono tabular-nums text-warning-foreground">
                {formatBytes(entry.logicalWriteBytes)}
              </td>
              <td className="px-3 py-2 text-right font-mono tabular-nums">{entry.count}</td>
              <td className="px-3 py-2 text-right font-mono tabular-nums text-muted-foreground sm:pr-5">
                {(entry.durationMs / 1_000).toFixed(2).replace(/\.0+$/, "")}s
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function ResourceTelemetryDiagnostics({
  environmentId,
}: {
  environmentId: EnvironmentId | null;
}) {
  // Pending signals and retries belong to one environment, so a switch starts fresh.
  return (
    <ResourceTelemetryDiagnosticsBody key={environmentId ?? ""} environmentId={environmentId} />
  );
}

function ResourceTelemetryDiagnosticsBody({
  environmentId,
}: {
  environmentId: EnvironmentId | null;
}) {
  const m = useMessages();
  const registry = useContext(RegistryContext);
  const [windowMs, setWindowMs] = useState(15 * 60_000);
  const selectedWindow =
    HISTORY_WINDOWS.find((option) => option.windowMs === windowMs) ?? HISTORY_WINDOWS[1];
  const canMaintainEnvironment = useEnvironmentScope(environmentId, AuthEnvironmentMaintainScope);
  const telemetry = useResourceTelemetry(environmentId);
  const retryTelemetry = telemetry.retry;
  const history = useResourceTelemetryHistory(
    {
      windowMs: selectedWindow.windowMs,
      bucketMs: selectedWindow.bucketMs,
    },
    environmentId,
  );
  const signalServerProcess = useAtomCommand(serverEnvironment.signalProcess, {
    reportFailure: false,
  });
  const [signalingKeys, setSignalingKeys] = useState<ReadonlySet<string>>(() => new Set());
  const signalingKeysRef = useRef<ReadonlySet<string>>(new Set());
  const [isRetrying, setIsRetrying] = useState(false);
  const snapshot = telemetry.data;
  const allT3 = snapshot?.groups.allT3;

  const signalProcess = async (process: ResourceTelemetryProcess, signal: ServerProcessSignal) => {
    const targetEnvironmentId = environmentId;
    if (
      targetEnvironmentId === null ||
      !readEnvironmentScope(targetEnvironmentId, AuthEnvironmentMaintainScope)
    )
      return;
    const identityKey = processIdentityKey(process);
    if (signalingKeysRef.current.has(identityKey)) return;
    const nextSignalingKeys = new Set(signalingKeysRef.current).add(identityKey);
    signalingKeysRef.current = nextSignalingKeys;
    setSignalingKeys(nextSignalingKeys);
    const clearSignaling = () => {
      const next = new Set(signalingKeysRef.current);
      next.delete(identityKey);
      signalingKeysRef.current = next;
      setSignalingKeys(next);
    };

    if (signal === "SIGKILL") {
      let confirmed = false;
      try {
        confirmed = await ensureLocalApi().dialogs.confirm(
          `Send SIGKILL to process ${process.identity.pid}? This cannot be handled by the process.`,
          { variant: "destructive" },
        );
      } catch (error) {
        clearSignaling();
        toastManager.add({
          type: "error",
          title: m(msg("Could not confirm signal")),
          description: error instanceof Error ? error.message : `Failed to send ${signal}.`,
        });
        return;
      }
      if (!confirmed) {
        clearSignaling();
        return;
      }
    }
    if (!readEnvironmentScope(targetEnvironmentId, AuthEnvironmentMaintainScope)) {
      clearSignaling();
      return;
    }
    void signalServerProcess({
      environmentId: targetEnvironmentId,
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
        clearSignaling();
      });
  };

  const retryCollector = () => {
    if (
      environmentId === null ||
      !readEnvironmentScope(environmentId, AuthEnvironmentMaintainScope)
    )
      return;
    setIsRetrying(true);
    void retryTelemetry()
      .then(() => {
        // The user can pick another window while the retry runs; refreshing every window
        // re-reads the one on screen and only invalidates the rest.
        for (const option of HISTORY_WINDOWS) {
          registry.refresh(
            serverEnvironment.resourceTelemetryHistory({
              environmentId,
              input: { windowMs: option.windowMs, bucketMs: option.bucketMs },
            }),
          );
        }
      })
      .catch((error: unknown) => {
        toastManager.add({
          type: "error",
          title: m(msg("Could not restart resource monitor")),
          description:
            error instanceof Error ? error.message : m(msg("The resource monitor retry failed.")),
        });
      })
      .finally(() => {
        setIsRetrying(false);
      });
  };

  const speedLimit = snapshot ? Option.getOrNull(snapshot.speedLimitPercent) : null;
  const collectorNeedsRetry = shouldShowResourceMonitorRetry({
    nativeStatus: snapshot?.health.native.status ?? null,
    error: telemetry.error,
  });
  const hasHostPowerSignal =
    snapshot !== null &&
    (snapshot.power.onBattery !== "unknown" ||
      snapshot.power.lowPowerMode !== "unknown" ||
      snapshot.power.idle !== "unknown" ||
      snapshot.power.locked !== "unknown" ||
      snapshot.power.thermalState !== "unknown");

  return (
    <>
      <SettingsSection
        title={msg("Resource monitor")}
        icon={<ActivityIcon className="size-4 text-muted-foreground" />}
        headerAction={
          <div className="flex items-center gap-2">
            {snapshot ? (
              <SourceStatusBadge label={msg("Native")} status={snapshot.health.native.status} />
            ) : null}
            <LastSampleLabel sampledAt={snapshot?.readAt ?? null} />
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    size="icon-micro"
                    variant="ghost"
                    disabled={telemetry.isPending}
                    onClick={telemetry.refresh}
                    aria-label={m(msg("Refresh resource telemetry"))}
                  >
                    <RefreshIcon size="xs" refreshing={telemetry.isPending} />
                  </Button>
                }
              />
              <TooltipPopup side="top">{m(msg("Refresh telemetry snapshot"))}</TooltipPopup>
            </Tooltip>
          </div>
        }
      >
        <div className="overflow-hidden rounded-[inherit]">
          <div className="flex flex-col gap-3 border-b border-border/60 bg-linear-to-r from-muted/45 via-muted/20 to-transparent px-4 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-5">
            <div>
              <div className="text-3xs font-semibold uppercase tracking-widest text-muted-foreground/70">
                {m(msg("T3 system footprint"))}
              </div>
              <p className="mt-1 max-w-xl text-xs leading-relaxed text-muted-foreground">
                {m(
                  msg(
                    "Live native counters for the server, providers, terminals, desktop processes, and the monitor itself.",
                  ),
                )}
              </p>
            </div>
            <div className="flex items-center gap-2 text-3xs text-muted-foreground/65">
              <span
                className={cn(
                  "size-1.5 rounded-full",
                  snapshot && snapshot.sampleIntervalMs > 0
                    ? "bg-success"
                    : "bg-muted-foreground/55",
                )}
              />
              {snapshot
                ? samplingStatusLabel(snapshot.sampleIntervalMs, m)
                : m(msg("Sampling every ..."))}
            </div>
          </div>
          <div className="grid grid-cols-2 divide-x divide-y divide-border/55 md:grid-cols-3">
            <IconStat
              icon={<CpuIcon className="size-3.5" />}
              label={msg("Current CPU")}
              value={allT3 ? `${allT3.currentCpuPercent.toFixed(1)}%` : "..."}
              detail={
                allT3
                  ? `${formatCpuTime(allT3.cpuTimeMs / 1_000)} ${m(msg("observed CPU time"))}`
                  : undefined
              }
            />
            <IconStat
              icon={<MemoryStickIcon className="size-3.5" />}
              label={msg("Resident memory")}
              value={allT3 ? formatBytes(allT3.currentRssBytes) : "..."}
              detail={
                allT3
                  ? `${formatBytes(allT3.peakRssBytes)} ${m(msg("combined process peaks"))}`
                  : undefined
              }
            />
            <IconStat
              icon={<ActivityIcon className="size-3.5" />}
              label={msg("Process count")}
              value={allT3 ? String(allT3.processCount) : "..."}
              detail={
                allT3
                  ? `${allT3.processStarts} ${m(msg("starts"))} · ${allT3.processExits} ${m(msg("exits"))}`
                  : undefined
              }
            />
            <IconStat
              icon={<HardDriveIcon className="size-3.5" />}
              label={msg("Read throughput")}
              value={allT3 ? formatRate(allT3.ioReadBytesPerSecond) : "..."}
              detail={allT3 ? `${formatBytes(allT3.ioReadBytes)} ${m(msg("observed"))}` : undefined}
            />
            <IconStat
              icon={<DatabaseIcon className="size-3.5" />}
              label={msg("Write throughput")}
              value={allT3 ? formatRate(allT3.ioWriteBytesPerSecond) : "..."}
              detail={
                allT3 ? `${formatBytes(allT3.ioWriteBytes)} ${m(msg("observed"))}` : undefined
              }
              tone={
                allT3 && allT3.ioWriteBytesPerSecond >= 10 * 1_024 * 1_024
                  ? "danger"
                  : allT3 && allT3.ioWriteBytesPerSecond >= 1_024 * 1_024
                    ? "warning"
                    : "default"
              }
            />
            <IconStat
              icon={<GaugeIcon className="size-3.5" />}
              label={msg("CPU speed limit")}
              value={
                snapshot
                  ? speedLimit === null
                    ? m(msg("Unknown"))
                    : `${speedLimit.toFixed(0)}%`
                  : "..."
              }
              detail={
                snapshot
                  ? `${m(
                      THERMAL_STATE_MESSAGES[
                        snapshot.power.thermalState as keyof typeof THERMAL_STATE_MESSAGES
                      ] ?? msg(snapshot.power.thermalState),
                    )} ${m(msg("thermal state"))}`
                  : undefined
              }
              tone={speedLimit !== null && speedLimit < 80 ? "warning" : "default"}
            />
          </div>
          {telemetry.error ? (
            <div className="flex items-start gap-2 border-t border-destructive/20 bg-destructive/5 px-4 py-3 text-xs text-destructive sm:px-5">
              <AlertTriangleIcon className="size-3.5 h-lh shrink-0" />
              <span>{telemetry.error}</span>
            </div>
          ) : null}
          {snapshot ? (
            <div className="grid border-t border-border/60 bg-muted/10 md:grid-cols-3">
              <AggregateCard
                label={msg("Backend + agents")}
                accentClass="bg-success/80"
                aggregate={snapshot.groups.backend}
              />
              <AggregateCard
                label={msg("Desktop")}
                accentClass="bg-info/80"
                aggregate={snapshot.groups.electron}
              />
              <AggregateCard
                label={msg("Monitor overhead")}
                accentClass="bg-warning/80"
                aggregate={snapshot.groups.monitor}
              />
            </div>
          ) : null}
        </div>
      </SettingsSection>

      <SettingsSection
        title={msg("Host & collection")}
        icon={<GaugeIcon className="size-4 text-muted-foreground" />}
        headerAction={
          collectorNeedsRetry ? (
            <Button size="xs" variant="outline" disabled={isRetrying} onClick={retryCollector}>
              <RefreshIcon size="xs" refreshing={isRetrying} />
              {m(msg("Retry monitor"))}
            </Button>
          ) : null
        }
      >
        <div className="grid overflow-hidden rounded-[inherit] md:grid-cols-2 md:divide-x md:divide-border/60">
          <div className="px-4 py-4 sm:px-5">
            <div className="mb-3 flex items-center gap-2 text-3xs font-semibold uppercase tracking-widest text-muted-foreground/70">
              <span className="flex size-6 items-center justify-center rounded-md bg-muted/60">
                <BatteryIcon className="size-3.5" />
              </span>
              {m(msg("Host state"))}
            </div>
            {hasHostPowerSignal && snapshot ? (
              <>
                <DetailRow
                  label={msg("Power source")}
                  value={booleanStateLabel(snapshot.power.onBattery, {
                    true: msg("Battery"),
                    false: msg("External power"),
                  })}
                />
                <DetailRow
                  label={msg("Low power mode")}
                  value={booleanStateLabel(snapshot.power.lowPowerMode, {
                    true: msg("Enabled"),
                    false: msg("Disabled"),
                  })}
                />
                <DetailRow
                  label={msg("Idle")}
                  value={`${booleanStateLabel(snapshot.power.idle, {
                    true: msg("Idle"),
                    false: msg("Active"),
                  })}${
                    snapshot.power.idleSeconds === null
                      ? ""
                      : ` · ${Math.round(snapshot.power.idleSeconds)}s`
                  }`}
                />
                <DetailRow
                  label={msg("Session")}
                  value={
                    snapshot.power.suspended
                      ? msg("Suspended")
                      : booleanStateLabel(snapshot.power.locked, {
                          true: msg("Locked"),
                          false: msg("Unlocked"),
                        })
                  }
                />
                <DetailRow
                  label={msg("Thermal")}
                  value={snapshot.power.thermalState}
                  valueClassName={
                    snapshot.power.thermalState === "serious" ||
                    snapshot.power.thermalState === "critical"
                      ? "text-destructive"
                      : undefined
                  }
                />
              </>
            ) : (
              <div className="rounded-xl border border-dashed border-border/70 bg-muted/20 px-4 py-5">
                <div className="text-sm font-medium text-foreground">
                  {m(msg("Desktop host signals not connected"))}
                </div>
                <p className="mt-1.5 max-w-sm text-2xs leading-relaxed text-muted-foreground/70">
                  {m(
                    msg(
                      "Power, idle, lock, and thermal state are supplied by the desktop host. Process telemetry remains fully active in this browser session.",
                    ),
                  )}
                </p>
              </div>
            )}
          </div>
          <div className="border-t border-border/60 px-4 py-4 md:border-t-0 sm:px-5">
            <div className="mb-3 flex items-center gap-2 text-3xs font-semibold uppercase tracking-widest text-muted-foreground/70">
              <span className="flex size-6 items-center justify-center rounded-md bg-muted/60">
                <GaugeIcon className="size-3.5" />
              </span>
              {m(msg("Collection health"))}
            </div>
            {snapshot ? (
              <>
                <HealthSource
                  label={msg("Native process monitor")}
                  health={snapshot.health.native}
                />
                <HealthSource
                  label={msg("Electron main process")}
                  health={snapshot.health.desktop}
                />
                <DetailRow
                  label={msg("Collection time")}
                  value={formatDurationMicros(snapshot.health.collectionDurationMicros)}
                />
                <DetailRow
                  label={msg("Process scan")}
                  value={`${snapshot.health.retainedProcessCount}/${snapshot.health.scannedProcessCount} ${m(msg("retained"))}`}
                />
                <DetailRow
                  label={msg("Inaccessible")}
                  value={String(snapshot.health.inaccessibleProcessCount)}
                  valueClassName={
                    snapshot.health.inaccessibleProcessCount > 0
                      ? "text-warning-foreground"
                      : undefined
                  }
                />
                <DetailRow
                  label={msg("Sidecar")}
                  value={Option.match(snapshot.health.sidecarVersion, {
                    onNone: () => msg("Unavailable"),
                    onSome: (version) =>
                      `${version}${Option.match(snapshot.health.sidecarPid, {
                        onNone: () => "",
                        onSome: (pid) => ` · PID ${pid}`,
                      })}`,
                  })}
                />
                <DetailRow label={msg("Restarts")} value={String(snapshot.health.restartCount)} />
              </>
            ) : (
              <div className="py-4 text-xs text-muted-foreground">
                {m(msg("Waiting for collector health."))}
              </div>
            )}
          </div>
        </div>
      </SettingsSection>

      <SettingsSection
        title={msg("Resource timeline")}
        icon={<HardDriveIcon className="size-4 text-muted-foreground" />}
        headerAction={
          <div className="flex items-center gap-2">
            <HistoryWindowSelector selectedWindowMs={windowMs} onSelect={setWindowMs} />
            <Button
              size="icon-micro"
              variant="ghost"
              disabled={history.isPending}
              onClick={history.refresh}
              aria-label={m(msg("Refresh resource history"))}
            >
              <RefreshIcon size="xs" refreshing={history.isPending} />
            </Button>
          </div>
        }
      >
        <div className="overflow-hidden rounded-[inherit]">
          {history.error ? (
            <div className="flex items-start gap-2 border-b border-destructive/20 bg-destructive/5 px-4 py-3 text-xs text-destructive sm:px-5">
              <AlertTriangleIcon className="size-3.5 h-lh shrink-0" />
              <span>{history.error}</span>
            </div>
          ) : null}
          <ResourceHistoryChart buckets={history.data?.buckets ?? []} />
          <HistoryProcessTable processes={history.data?.topProcesses ?? []} />
        </div>
      </SettingsSection>

      <SettingsSection
        title={msg("Live process tree")}
        icon={<CpuIcon className="size-4 text-muted-foreground" />}
        headerAction={
          snapshot ? (
            <span className="text-3xs text-muted-foreground/55">
              {m(msg("Identity"))}: <span className="font-mono">PID + {m(msg("start time"))}</span>
            </span>
          ) : null
        }
      >
        <div className="overflow-hidden rounded-[inherit]">
          <ProcessTable
            processes={snapshot?.processes ?? []}
            canMaintainEnvironment={canMaintainEnvironment}
            signalingKeys={signalingKeys}
            onSignal={signalProcess}
          />
        </div>
      </SettingsSection>

      <SettingsSection
        title={msg("Instrumented application I/O")}
        icon={<DatabaseIcon className="size-4 text-muted-foreground" />}
        headerAction={
          <span className="text-3xs text-muted-foreground/55">
            {m(msg("Logical bytes by operation"))}
          </span>
        }
      >
        <div className="overflow-hidden rounded-[inherit]">
          <div className="bg-muted/15 px-4 py-3 text-2xs leading-relaxed text-muted-foreground sm:px-5">
            {m(
              msg(
                "Native counters identify which process is reading or writing. These application-level counters identify known T3 operations so process spikes can be correlated with specific persistence and logging paths.",
              ),
            )}
          </div>
          <AttributionTable entries={snapshot?.attribution.entries ?? []} />
        </div>
      </SettingsSection>
    </>
  );
}
