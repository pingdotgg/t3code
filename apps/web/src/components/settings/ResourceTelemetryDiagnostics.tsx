import { thrownErrorMessage } from "@t3tools/client-runtime/errors";
import { ProcessSignalActions } from "./ProcessSignalActions";
import { AuthEnvironmentMaintainScope } from "@t3tools/contracts";
import { RefreshIcon } from "~/components/ui/refresh-icon";
import {
  ActivityIcon,
  BatteryIcon,
  CircleSlashIcon,
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
import { msg, T, useGT, useMessages, Var } from "gt-react";
import { m, type MessageResolver } from "../../i18n/messages";

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
import { StatusDot, type StatusDotTone } from "../ui/status-dot";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { toastManager } from "../ui/toast";
import {
  formatCpuTime,
  formatSamplingStatus,
  processIdentityKey,
  resourceHistoryBarHeight,
  resourceHistoryCpuScaleMax,
  shouldShowResourceMonitorRetry,
  visibleResourceTelemetryProcesses,
} from "./ResourceTelemetryDiagnostics.logic";
import { SettingsNote, SettingsSection } from "./settingsLayout";

const HISTORY_WINDOWS = [
  { label: "5m", windowMs: 5 * 60_000, bucketMs: 15_000 },
  { label: "15m", windowMs: 15 * 60_000, bucketMs: 30_000 },
  { label: "30m", windowMs: 30 * 60_000, bucketMs: 60_000 },
  { label: "1h", windowMs: 60 * 60_000, bucketMs: 2 * 60_000 },
] as const;

function formatRate(value: number): string {
  return `${formatBytes(value)}/s`;
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

function categoryLabel(
  category: ResourceTelemetryProcessCategory,
  resolve: MessageResolver = m,
): string {
  switch (category) {
    case "server":
      return resolve(msg("Server"));
    case "server-child":
      return resolve(msg("Backend child"));
    case "provider-root":
      return resolve(msg("Provider"));
    case "terminal-root":
      return resolve(msg("Terminal"));
    case "electron-main":
      return resolve(msg("Electron main"));
    case "electron-renderer":
      return resolve(msg("Renderer"));
    case "electron-gpu":
      return "GPU";
    case "electron-utility":
      return resolve(msg("Electron utility"));
    case "resource-monitor":
      return resolve(msg("Monitor"));
    case "unknown-t3":
      return resolve(msg("T3 process"));
  }
}

function categoryDotTone(category: ResourceTelemetryProcessCategory): StatusDotTone {
  if (category === "resource-monitor") return "warning";
  if (category.startsWith("electron-")) return "info";
  if (category === "server") return "merged";
  return "success";
}

function ioSemanticsLabel(
  semantics: ResourceTelemetryIoSemantics,
  resolve: MessageResolver = m,
): string {
  switch (semantics) {
    case "storage":
      return resolve(msg("Storage bytes"));
    case "logical":
      return resolve(msg("Logical bytes"));
    case "all-io":
      return resolve(msg("All I/O bytes"));
    case "unavailable":
      return resolve(msg("Unavailable"));
  }
}

function booleanStateLabel(
  value: BackgroundBooleanState,
  labels: { readonly true: string; readonly false: string },
  resolve: MessageResolver = m,
): string {
  if (value === "true") return labels.true;
  if (value === "false") return labels.false;
  return resolve(msg("Unknown"));
}

function sourceStatusTone(status: ResourceTelemetrySourceStatus): "default" | "warning" | "danger" {
  if (status === "healthy") return "default";
  if (status === "starting" || status === "degraded") return "warning";
  return "danger";
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
  const tone = presentation?.tone ?? sourceStatusTone(status);
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-badge border px-2.5 py-1 text-3xs font-medium",
        tone === "neutral" && "border-transparent bg-secondary text-muted-foreground",
        tone === "default" && "border-transparent bg-success/12 text-success-foreground",
        tone === "warning" && "border-transparent bg-warning/12 text-warning-foreground",
        tone === "danger" && "border-transparent bg-error/12 text-error-foreground",
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
      {label} {presentation?.label ?? status}
    </span>
  );
}

function LastSampleLabel({ sampledAt }: { sampledAt: DateTime.Utc | null }) {
  const relative = useRelativeTimeState(sampledAt ? DateTime.formatIso(sampledAt) : null);
  if (relative.status !== "relative") {
    return (
      <span className="text-2xs text-dim-foreground">
        <T>Waiting for sample</T>
      </span>
    );
  }
  return (
    <span className="text-2xs text-dim-foreground">
      {relative.suffix ? (
        <T context="the time is an elapsed time such as 5m">
          Updated{" "}
          <span className="font-mono tabular-nums">
            <Var>{relative.value}</Var>
          </span>{" "}
          ago
        </T>
      ) : (
        <T>
          Updated{" "}
          <span className="font-mono tabular-nums">
            <Var>{relative.value}</Var>
          </span>
        </T>
      )}
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
  detail?: ReactNode;
  tone?: "default" | "warning" | "danger";
}) {
  return (
    <div className="group min-w-0 px-4 py-4 sm:px-5">
      <div className="flex items-center gap-2 text-3xs font-normal text-dim-foreground">
        <span className="text-dim-foreground transition-colors group-hover:text-foreground/65">
          {icon}
        </span>
        <span className="truncate">{label}</span>
      </div>
      <div
        className={cn(
          "mt-2.5 truncate font-sans text-2xl font-semibold tabular-nums text-foreground",
          tone === "warning" && "text-warning-foreground",
          tone === "danger" && "text-destructive",
        )}
      >
        {value}
      </div>
      {detail ? <div className="mt-1.5 text-meta text-muted-foreground">{detail}</div> : null}
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
  const gt = useGT();
  return (
    <div className="relative overflow-hidden border-t border-divider px-4 py-4 first:border-t-0 md:border-t-0 md:border-l md:first:border-l-0 sm:px-5">
      <span className={cn("absolute inset-x-5 top-0 h-0.5 rounded-full opacity-75", accentClass)} />
      <div className="flex items-center justify-between gap-3">
        <div className="text-3xs font-normal text-dim-foreground">{label}</div>
        <div className="rounded-badge bg-secondary px-1.5 py-0.5 font-mono text-3xs tabular-nums text-dim-foreground">
          {aggregate.processCount} {aggregate.processCount === 1 ? "process" : "processes"}
        </div>
      </div>
      <div className="mt-3.5 grid grid-cols-2 gap-x-4 gap-y-2.5">
        <MetricPair label={gt("CPU")} value={`${aggregate.currentCpuPercent.toFixed(1)}%`} />
        <MetricPair label={gt("Memory")} value={formatBytes(aggregate.currentRssBytes)} />
        <MetricPair label={gt("Read")} value={formatRate(aggregate.ioReadBytesPerSecond)} />
        <MetricPair label={gt("Write")} value={formatRate(aggregate.ioWriteBytesPerSecond)} />
      </div>
    </div>
  );
}

function MetricPair({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <div className="text-3xs font-normal text-dim-foreground">{label}</div>
      <div className="truncate font-mono text-xs font-medium tabular-nums text-foreground">
        {value}
      </div>
    </div>
  );
}

function HealthSource({ label, health }: { label: string; health: ResourceTelemetrySourceHealth }) {
  const gt = useGT();
  const expectedInBrowser =
    health.status === "unavailable" &&
    Option.exists(health.lastError, (error) => error.includes("'web' mode"));
  // The page states why the monitor is down once, near the top; here the reason is a tooltip.
  const unavailable = health.status === "unavailable" && !expectedInBrowser;
  const badge = (
    <SourceStatusBadge
      label=""
      status={health.status}
      presentation={
        expectedInBrowser
          ? { label: gt("Desktop only"), tone: "neutral" }
          : unavailable
            ? { label: gt("Unavailable"), tone: "neutral" }
            : undefined
      }
    />
  );
  return (
    <div className="flex items-start justify-between gap-4 border-t border-divider py-3 first:border-t-0">
      <div className="min-w-0">
        <div className="text-sm font-medium text-strong-foreground">{label}</div>
        {unavailable ? null : (
          <div className="mt-1 text-2xs leading-relaxed text-dim-foreground">
            {expectedInBrowser
              ? gt("Available when this page runs inside the desktop app.")
              : Option.match(health.lastError, {
                  onNone: () => gt("No reported errors"),
                  onSome: (error) => error,
                })}
          </div>
        )}
      </div>
      {unavailable && Option.isSome(health.lastError) ? (
        <Tooltip>
          <TooltipTrigger render={<span className="shrink-0" />}>{badge}</TooltipTrigger>
          <TooltipPopup side="top">{health.lastError.value}</TooltipPopup>
        </Tooltip>
      ) : (
        badge
      )}
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
    <div className="flex items-center justify-between gap-4 border-t border-divider py-2.5 first:border-t-0">
      <span className="text-meta text-muted-foreground">{label}</span>
      <span
        className={cn(
          "min-w-0 text-right font-mono text-meta tabular-nums text-foreground",
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
  const gt = useGT();
  return (
    <ToggleGroup
      aria-label={gt("Resource history period")}
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
  const gt = useGT();
  const maxCpu = resourceHistoryCpuScaleMax(buckets);
  const maxIo = Math.max(1, ...buckets.map((bucket) => bucket.ioReadBytes + bucket.ioWriteBytes));

  return (
    <div className="border-t border-divider px-4 py-4 sm:px-5">
      <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-3xs text-dim-foreground">
        <span className="inline-flex items-center gap-1.5">
          <span className="h-1.5 w-3 rounded-full bg-foreground/70" /> <T>CPU average</T>
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="h-1.5 w-3 rounded-full bg-info/70" /> <T>I/O reads</T>
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="h-1.5 w-3 rounded-full bg-warning/80" /> <T>I/O writes</T>
        </span>
      </div>
      <div className="flex h-32 items-end gap-1 overflow-hidden rounded-control surface-well px-2 pt-3 pb-2">
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
                    {gt("CPU avg {percent}%", { percent: bucket.avgCpuPercent.toFixed(1) })}
                  </div>
                  <div>
                    {gt("CPU peak {percent}%", { percent: bucket.maxCpuPercent.toFixed(1) })}
                  </div>
                  <div>{gt("Read {bytes}", { bytes: formatBytes(bucket.ioReadBytes) })}</div>
                  <div>{gt("Write {bytes}", { bytes: formatBytes(bucket.ioWriteBytes) })}</div>
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
  const gt = useGT();
  const messages = useMessages();
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
          aria-label={collapsed ? gt("Expand {name}", { name }) : gt("Collapse {name}", { name })}
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
      <StatusDot tone={categoryDotTone(process.category)} />
      <div className="min-w-0">
        <Tooltip>
          <TooltipTrigger
            render={<div className="truncate text-label text-strong-foreground">{name}</div>}
          />
          <TooltipPopup side="top" variant="code">
            {process.command || process.name}
          </TooltipPopup>
        </Tooltip>
        <ProcessDetail>
          <span>{categoryLabel(process.category, messages)}</span>
          <span>
            <T>
              PID <Var>{process.identity.pid}</Var>
            </T>
          </span>
        </ProcessDetail>
      </div>
    </div>
  );
}

/** One quiet line saying why a measurement is missing, in place of an error banner. */
function UnavailableNote({ children }: { children: ReactNode }) {
  return (
    <SettingsNote icon={<CircleSlashIcon className="text-dim-foreground" />}>
      {children}
    </SettingsNote>
  );
}

/** A section whose data needs the monitor, once the reason has been stated above. */
function UnavailableRows() {
  return (
    <div className="px-4 py-4 text-xs text-muted-foreground sm:px-5">
      <T>Unavailable</T>
    </div>
  );
}

/** The muted second line under a process name. */
function ProcessDetail({ children }: { children: ReactNode }) {
  return (
    <div className="mt-0.5 grid gap-1 font-mono text-meta tabular-nums text-muted-foreground">
      {children}
    </div>
  );
}

/** Read and write stacked in one cell, colored like the timeline legend. */
function IoPair({ read, write, tooltip }: { read: string; write: string; tooltip?: ReactNode }) {
  const pair = (
    <div className="font-mono tabular-nums">
      <div className="truncate text-info-foreground">{read}</div>
      <div className="truncate text-warning-foreground">{write}</div>
    </div>
  );
  if (!tooltip) return pair;
  return (
    <Tooltip>
      <TooltipTrigger render={pair} />
      <TooltipPopup side="top" className="text-left">
        {tooltip}
      </TooltipPopup>
    </Tooltip>
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
    return <span className="text-3xs text-dim-foreground">-</span>;
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
  const messages = useMessages();
  const gt = useGT();
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
    <div className="border-t border-divider">
      <ScrollArea
        chainVerticalScroll
        scrollFade
        hideScrollbars
        className="max-h-[min(68vh,48rem)] w-full max-w-full"
      >
        <table className="w-full table-fixed text-left text-xs">
          <colgroup>
            <col />
            <col className="w-16" />
            <col className="w-18" />
            <col className="w-20" />
            <col className="w-24" />
            <col className="w-24" />
          </colgroup>
          <thead className="sticky top-0 z-10 border-b border-divider bg-card text-3xs text-dim-foreground">
            <tr>
              <th className="px-4 py-2 font-semibold sm:pl-5">
                <T>Process</T>
              </th>
              <th className="px-3 py-2 text-right font-semibold">
                <T>CPU</T>
              </th>
              <th className="px-3 py-2 text-right font-semibold">
                <T>CPU time</T>
              </th>
              <th className="px-3 py-2 text-right font-semibold">
                <T>Memory</T>
              </th>
              <th className="px-3 py-2 text-right font-semibold">
                <T>I/O per sec</T>
              </th>
              <th className="px-2 py-2 font-semibold sm:pr-4">
                <span className="sr-only">
                  <T>Signal</T>
                </span>
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-divider">
            {visible.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-4 py-5 text-xs text-muted-foreground sm:px-5">
                  <T>Waiting for the native process monitor.</T>
                </td>
              </tr>
            ) : null}
            {visible.map((process) => (
              <tr key={processIdentityKey(process)} className="hover:surface-ghost-hover">
                <td className="px-4 py-2 sm:pl-5">
                  <ProcessTreeName
                    process={process}
                    collapsed={collapsed.has(processIdentityKey(process))}
                    onToggle={toggle}
                  />
                </td>
                <td className="px-3 py-2 text-right font-mono tabular-nums">
                  {process.cpuPercent.toFixed(1)}%
                </td>
                <td className="px-3 py-2 text-right font-mono tabular-nums">
                  {formatCpuTime(process.cpuTimeMs / 1_000, messages)}
                </td>
                <td className="px-3 py-2 text-right font-mono tabular-nums">
                  {formatBytes(process.residentBytes)}
                </td>
                <td className="px-3 py-2 text-right">
                  <IoPair
                    read={formatRate(process.ioReadBytesPerSecond)}
                    write={formatRate(process.ioWriteBytesPerSecond)}
                    tooltip={
                      <div className="space-y-0.5">
                        <div>
                          {gt("Read {bytes}", { bytes: formatRate(process.ioReadBytesPerSecond) })}
                        </div>
                        <div>
                          {gt("Write {bytes}", { bytes: formatRate(process.ioWriteBytesPerSecond) })}
                        </div>
                        <div>
                          {gt("Read total {bytes}", { bytes: formatBytes(process.ioReadBytes) })}
                        </div>
                        <div>
                          {gt("Write total {bytes}", { bytes: formatBytes(process.ioWriteBytes) })}
                        </div>
                        <div>{ioSemanticsLabel(process.ioSemantics, messages)}</div>
                      </div>
                    }
                  />
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
  const messages = useMessages();
  const gt = useGT();
  return (
    <div className="border-t border-divider">
      <ScrollArea
        chainVerticalScroll
        scrollFade
        hideScrollbars
        className="max-h-[28rem] w-full max-w-full"
      >
        <table className="w-full table-fixed text-left text-xs">
          <colgroup>
            <col />
            <col className="w-20" />
            <col className="w-20" />
            <col className="w-22" />
            <col className="w-24" />
          </colgroup>
          <thead className="sticky top-0 z-10 border-b border-divider bg-card text-3xs text-dim-foreground">
            <tr>
              <th className="px-4 py-2 font-semibold sm:pl-5">
                <T>Process</T>
              </th>
              <th className="px-3 py-2 text-right font-semibold">
                <T>CPU time</T>
              </th>
              <th className="px-3 py-2 text-right font-semibold">
                <T>Peak CPU</T>
              </th>
              <th className="px-3 py-2 text-right font-semibold">
                <T>Peak mem</T>
              </th>
              <th className="px-3 py-2 text-right font-semibold sm:pr-5">
                <T>I/O</T>
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-divider">
            {processes.length === 0 ? (
              <tr>
                <td colSpan={5} className="px-4 py-5 text-xs text-muted-foreground sm:px-5">
                  <T>No retained process samples in this window.</T>
                </td>
              </tr>
            ) : null}
            {processes.map((process) => (
              <tr key={processIdentityKey(process)} className="hover:surface-ghost-hover">
                <td className="px-4 py-2 sm:pl-5">
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <span className="block truncate text-label text-strong-foreground">
                          {process.name || process.command}
                        </span>
                      }
                    />
                    <TooltipPopup side="top" variant="code">
                      {process.command || process.name}
                    </TooltipPopup>
                  </Tooltip>
                  <ProcessDetail>
                    <span>{categoryLabel(process.category, messages)}</span>
                    <span>
                      <T>
                        PID <Var>{process.identity.pid}</Var>
                      </T>
                    </span>
                    <span>
                      {gt("{count, plural, one {{count} sample} other {{count} samples}}", {
                        count: process.sampleCount,
                      })}
                    </span>
                  </ProcessDetail>
                </td>
                <td className="px-3 py-2 text-right font-mono tabular-nums">
                  {formatCpuTime(process.cpuTimeMs / 1_000, messages)}
                </td>
                <td className="px-3 py-2 text-right font-mono tabular-nums">
                  {process.maxCpuPercent.toFixed(1)}%
                </td>
                <td className="px-3 py-2 text-right font-mono tabular-nums">
                  {formatBytes(process.peakRssBytes)}
                </td>
                <td className="px-3 py-2 text-right sm:pr-5">
                  <IoPair
                    read={formatBytes(process.ioReadBytes)}
                    write={formatBytes(process.ioWriteBytes)}
                    tooltip={
                      <div className="space-y-0.5">
                        <div>{gt("Read {bytes}", { bytes: formatBytes(process.ioReadBytes) })}</div>
                        <div>{gt("Write {bytes}", { bytes: formatBytes(process.ioWriteBytes) })}</div>
                      </div>
                    }
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

function AttributionTable({ entries }: { entries: ReadonlyArray<ResourceAttributionEntry> }) {
  return (
    <div className="border-t border-divider">
      <table className="w-full table-fixed text-left text-xs">
        <colgroup>
          <col />
          <col className="w-22" />
          <col className="w-22" />
          <col className="w-18" />
          <col className="w-20" />
        </colgroup>
        <thead className="border-b border-divider text-3xs text-dim-foreground">
          <tr>
            <th className="px-4 py-2 font-semibold sm:pl-5">
              <T>Operation</T>
            </th>
            <th className="px-3 py-2 text-right font-semibold">
              <T>Read</T>
            </th>
            <th className="px-3 py-2 text-right font-semibold">
              <T>Write</T>
            </th>
            <th className="px-3 py-2 text-right font-semibold">
              <T>Count</T>
            </th>
            <th className="px-3 py-2 text-right font-semibold sm:pr-5">
              <T>Time</T>
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-divider">
          {entries.length === 0 ? (
            <tr>
              <td colSpan={5} className="px-4 py-5 text-xs text-muted-foreground sm:px-5">
                <T>No instrumented application I/O has been recorded yet.</T>
              </td>
            </tr>
          ) : null}
          {entries.map((entry) => (
            <tr key={`${entry.component}:${entry.operation}`} className="hover:surface-ghost-hover">
              <td className="px-4 py-2 sm:pl-5">
                <div className="truncate text-label text-strong-foreground">{entry.operation}</div>
                <ProcessDetail>{entry.component}</ProcessDetail>
              </td>
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
  const messages = useMessages();
  const gt = useGT();
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
  // With the native monitor down and nothing sampled, the zeroed totals are unknown, not zero.
  const nativeUnavailableReason =
    snapshot &&
    (snapshot.health.native.status === "unavailable" ||
      snapshot.health.native.status === "stopped") &&
    snapshot.processes.length === 0
      ? Option.getOrElse(
          snapshot.health.native.lastError,
          () => gt("The native process monitor is unavailable."),
        )
      : null;
  const measured = nativeUnavailableReason === null ? snapshot?.groups.allT3 : undefined;
  const pendingValue = nativeUnavailableReason === null ? "..." : "-";
  const historyProcesses = history.data?.topProcesses ?? [];

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
          gt("Send SIGKILL to process {pid}? This cannot be handled by the process.", {
            pid: process.identity.pid,
          }),
          { variant: "destructive" },
        );
      } catch (error) {
        clearSignaling();
        toastManager.add({
          type: "error",
          title: gt("Could not confirm signal"),
          description:
            error instanceof Error
              ? (thrownErrorMessage(error, m) ?? error.message)
              : gt("Failed to send {signal}.", { signal }),
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
          title: gt("Could not send {signal}", { signal }),
          description: Option.getOrElse(result.value.message, () =>
            gt("Failed to send {signal} to process {pid}.", {
              signal,
              pid: process.identity.pid,
            }),
          ),
        });
      })
      .catch((error: unknown) => {
        toastManager.add({
          type: "error",
          title: gt("Could not send {signal}", { signal }),
          description:
            error instanceof Error
              ? (thrownErrorMessage(error, m) ?? error.message)
              : gt("Failed to send {signal}.", { signal }),
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
          title: gt("Could not restart resource monitor"),
          description:
            error instanceof Error
              ? (thrownErrorMessage(error, m) ?? error.message)
              : gt("The resource monitor retry failed."),
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
        title={gt("Resource monitor")}
        headerAction={
          <div className="flex items-center gap-2">
            {snapshot && nativeUnavailableReason === null ? (
              <SourceStatusBadge label={gt("Native")} status={snapshot.health.native.status} />
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
                    aria-label={gt("Refresh resource telemetry")}
                  >
                    <RefreshIcon size="xs" refreshing={telemetry.isPending} />
                  </Button>
                }
              />
              <TooltipPopup side="top">
                <T>Refresh telemetry snapshot</T>
              </TooltipPopup>
            </Tooltip>
          </div>
        }
      >
        <div className="overflow-hidden rounded-card border border-transparent surface-card-settings">
          <div className="flex flex-col gap-3 border-b border-divider surface-card-settings px-4 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-5">
            <div>
              <div className="text-3xs font-normal text-dim-foreground">
                <T>T3 system footprint</T>
              </div>
              <p className="mt-1 max-w-xl text-xs leading-relaxed text-muted-foreground">
                <T>
                  Live native counters for the server, providers, terminals, desktop processes, and
                  the monitor itself.
                </T>
              </p>
            </div>
            {nativeUnavailableReason ? (
              <div className="flex items-center gap-2 text-3xs text-dim-foreground">
                <StatusDot tone="neutral" label={nativeUnavailableReason} />
                <T>Unavailable</T>
              </div>
            ) : (
              <div className="flex items-center gap-2 text-3xs text-dim-foreground">
                <StatusDot
                  tone={snapshot && snapshot.sampleIntervalMs > 0 ? "success" : "neutral"}
                />
                {snapshot
                  ? formatSamplingStatus(snapshot.sampleIntervalMs, messages)
                  : gt("Sampling every ...")}
              </div>
            )}
          </div>
          {/* Tiles draw their right and bottom edges; the 1px overhang is clipped by the card so only inner dividers show. */}
          <div className="-mr-px -mb-px grid grid-cols-2 md:grid-cols-3 [&>*]:border-r [&>*]:border-b [&>*]:border-divider">
            <IconStat
              icon={<CpuIcon className="size-3.5" />}
              label={gt("Current CPU")}
              value={measured ? `${measured.currentCpuPercent.toFixed(1)}%` : pendingValue}
              detail={
                measured
                  ? gt("{time} observed CPU time", {
                      time: formatCpuTime(measured.cpuTimeMs / 1_000, messages),
                    })
                  : undefined
              }
            />
            <IconStat
              icon={<MemoryStickIcon className="size-3.5" />}
              label={gt("Resident memory")}
              value={measured ? formatBytes(measured.currentRssBytes) : pendingValue}
              detail={
                measured
                  ? gt("{bytes} combined process peaks", {
                      bytes: formatBytes(measured.peakRssBytes),
                    })
                  : undefined
              }
            />
            <IconStat
              icon={<ActivityIcon className="size-3.5" />}
              label={gt("Process count")}
              value={measured ? String(measured.processCount) : pendingValue}
              detail={
                measured ? (
                  <span className="grid gap-1">
                    <span>
                      {gt("{count, plural, one {{count} start} other {{count} starts}}", {
                        count: measured.processStarts,
                      })}
                    </span>
                    <span>
                      {gt("{count, plural, one {{count} exit} other {{count} exits}}", {
                        count: measured.processExits,
                      })}
                    </span>
                  </span>
                ) : undefined
              }
            />
            <IconStat
              icon={<HardDriveIcon className="size-3.5" />}
              label={gt("Read throughput")}
              value={measured ? formatRate(measured.ioReadBytesPerSecond) : pendingValue}
              detail={measured ? `${formatBytes(measured.ioReadBytes)} observed` : undefined}
            />
            <IconStat
              icon={<DatabaseIcon className="size-3.5" />}
              label={gt("Write throughput")}
              value={measured ? formatRate(measured.ioWriteBytesPerSecond) : pendingValue}
              detail={measured ? `${formatBytes(measured.ioWriteBytes)} observed` : undefined}
              tone={
                measured && measured.ioWriteBytesPerSecond >= 10 * 1_024 * 1_024
                  ? "danger"
                  : measured && measured.ioWriteBytesPerSecond >= 1_024 * 1_024
                    ? "warning"
                    : "default"
              }
            />
            <IconStat
              icon={<GaugeIcon className="size-3.5" />}
              label={gt("CPU speed limit")}
              value={snapshot ? (speedLimit === null ? "-" : `${speedLimit.toFixed(0)}%`) : "..."}
              detail={
                snapshot && snapshot.power.thermalState !== "unknown"
                  ? gt("{thermalState} thermal state", {
                      thermalState: snapshot.power.thermalState,
                    })
                  : undefined
              }
              tone={speedLimit !== null && speedLimit < 80 ? "warning" : "default"}
            />
          </div>
          {telemetry.error ? (
            <div className="border-t border-divider">
              <UnavailableNote>{telemetry.error}</UnavailableNote>
            </div>
          ) : null}
          {snapshot && nativeUnavailableReason === null ? (
            <div className="grid border-t border-divider bg-muted/10 md:grid-cols-3">
              <AggregateCard
                label={gt("Backend + agents")}
                accentClass="bg-success/80"
                aggregate={snapshot.groups.backend}
              />
              <AggregateCard
                label={gt("Desktop")}
                accentClass="bg-info/80"
                aggregate={snapshot.groups.electron}
              />
              <AggregateCard
                label={gt("Monitor overhead")}
                accentClass="bg-warning/80"
                aggregate={snapshot.groups.monitor}
              />
            </div>
          ) : null}
        </div>
      </SettingsSection>

      <SettingsSection
        title={gt("Host & collection")}
        headerAction={
          collectorNeedsRetry ? (
            <Button size="xs" variant="secondary" disabled={isRetrying} onClick={retryCollector}>
              <RefreshIcon size="xs" refreshing={isRetrying} />
              <T>Retry monitor</T>
            </Button>
          ) : null
        }
      >
        {/* Without host signals the host side is one note, so the two sides stack instead of leaving a tall empty column. */}
        <div
          className={cn(
            "grid overflow-hidden rounded-card border border-transparent surface-card-settings",
            hasHostPowerSignal && "md:grid-cols-2 md:divide-x md:divide-divider",
          )}
        >
          <div className="px-4 py-4 sm:px-5">
            <div className="mb-3 flex items-center gap-2 text-3xs font-normal text-dim-foreground">
              <span className="flex size-6 items-center justify-center rounded-md bg-muted/60">
                <BatteryIcon className="size-3.5" />
              </span>
              <T>Host state</T>
            </div>
            {hasHostPowerSignal && snapshot ? (
              <>
                <DetailRow
                  label={gt("Power source")}
                  value={booleanStateLabel(
                    snapshot.power.onBattery,
                    { true: gt("Battery"), false: gt("External power") },
                    messages,
                  )}
                />
                <DetailRow
                  label={gt("Low power mode")}
                  value={booleanStateLabel(
                    snapshot.power.lowPowerMode,
                    { true: gt("Enabled"), false: gt("Disabled") },
                    messages,
                  )}
                />
                <DetailRow
                  label={gt("Idle")}
                  value={
                    <span className="grid justify-items-end gap-1">
                      <span>
                        {booleanStateLabel(
                          snapshot.power.idle,
                          {
                            true: gt("Idle", { $context: "host power state" }),
                            false: gt("Active", { $context: "host power state" }),
                          },
                          messages,
                        )}
                      </span>
                      {snapshot.power.idleSeconds === null ? null : (
                        <span>{Math.round(snapshot.power.idleSeconds)}s</span>
                      )}
                    </span>
                  }
                />
                <DetailRow
                  label={gt("Session")}
                  value={
                    snapshot.power.suspended
                      ? gt("Suspended")
                      : booleanStateLabel(
                          snapshot.power.locked,
                          { true: gt("Locked"), false: gt("Unlocked") },
                          messages,
                        )
                  }
                />
                <DetailRow
                  label={gt("Thermal")}
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
              <div>
                <div className="text-sm font-medium text-strong-foreground">
                  <T>Desktop host signals not connected</T>
                </div>
                <p className="mt-1 text-2xs leading-relaxed text-dim-foreground">
                  {snapshot?.health.native.status === "healthy" ||
                  snapshot?.health.native.status === "degraded" ? (
                    <T>
                      Power, idle, lock, and thermal state are supplied by the desktop host. Process
                      telemetry remains fully active in this browser session.
                    </T>
                  ) : (
                    <T>Power, idle, lock, and thermal state are supplied by the desktop host.</T>
                  )}
                </p>
              </div>
            )}
          </div>
          <div
            className={cn(
              "border-t border-divider px-4 py-4 sm:px-5",
              hasHostPowerSignal && "md:border-t-0",
            )}
          >
            <div className="mb-3 flex items-center gap-2 text-3xs font-normal text-dim-foreground">
              <span className="flex size-6 items-center justify-center rounded-md bg-muted/60">
                <GaugeIcon className="size-3.5" />
              </span>
              <T>Collection health</T>
            </div>
            {snapshot ? (
              <>
                <HealthSource
                  label={gt("Native process monitor")}
                  health={snapshot.health.native}
                />
                <HealthSource
                  label={gt("Electron main process")}
                  health={snapshot.health.desktop}
                />
                <DetailRow
                  label={gt("Collection time")}
                  value={
                    nativeUnavailableReason
                      ? "-"
                      : formatDurationMicros(snapshot.health.collectionDurationMicros)
                  }
                />
                <DetailRow
                  label={gt("Process scan")}
                  value={
                    nativeUnavailableReason
                      ? "-"
                      : `${snapshot.health.retainedProcessCount}/${snapshot.health.scannedProcessCount} retained`
                  }
                />
                <DetailRow
                  label={gt("Inaccessible")}
                  value={
                    nativeUnavailableReason ? "-" : String(snapshot.health.inaccessibleProcessCount)
                  }
                  valueClassName={
                    nativeUnavailableReason === null && snapshot.health.inaccessibleProcessCount > 0
                      ? "text-warning-foreground"
                      : undefined
                  }
                />
                <DetailRow
                  label={gt("Sidecar")}
                  value={
                    <span className="grid justify-items-end gap-1">
                      <span>{Option.getOrElse(snapshot.health.sidecarVersion, () => "-")}</span>
                      {Option.isSome(snapshot.health.sidecarPid) ? (
                        <span>
                          <T>
                            PID <Var>{snapshot.health.sidecarPid.value}</Var>
                          </T>
                        </span>
                      ) : null}
                    </span>
                  }
                />
                <DetailRow label={gt("Restarts")} value={String(snapshot.health.restartCount)} />
              </>
            ) : (
              <div className="py-4 text-xs text-muted-foreground">
                <T>Waiting for collector health.</T>
              </div>
            )}
          </div>
        </div>
      </SettingsSection>

      <SettingsSection
        title={gt("Resource timeline")}
        headerAction={
          <div className="flex items-center gap-2">
            <HistoryWindowSelector selectedWindowMs={windowMs} onSelect={setWindowMs} />
            <Button
              size="icon-micro"
              variant="ghost"
              disabled={history.isPending}
              onClick={history.refresh}
              aria-label={gt("Refresh resource history")}
            >
              <RefreshIcon size="xs" refreshing={history.isPending} />
            </Button>
          </div>
        }
      >
        <div className="overflow-hidden rounded-card border border-transparent surface-card-settings">
          {historyProcesses.length === 0 && nativeUnavailableReason ? (
            <UnavailableRows />
          ) : (
            <>
              {history.error ? <UnavailableNote>{history.error}</UnavailableNote> : null}
              {historyProcesses.length > 0 ? (
                <ResourceHistoryChart buckets={history.data?.buckets ?? []} />
              ) : null}
              <HistoryProcessTable processes={historyProcesses} />
            </>
          )}
        </div>
      </SettingsSection>

      <SettingsSection
        title={gt("Live process tree")}
        headerAction={
          snapshot ? (
            <span className="text-3xs text-dim-foreground">
              <T>
                Identity: <span className="font-mono">PID + start time</span>
              </T>
            </span>
          ) : null
        }
      >
        <div className="overflow-hidden rounded-card border border-transparent surface-card-settings">
          {nativeUnavailableReason ? (
            <UnavailableRows />
          ) : (
            <ProcessTable
              processes={snapshot?.processes ?? []}
              canMaintainEnvironment={canMaintainEnvironment}
              signalingKeys={signalingKeys}
              onSignal={signalProcess}
            />
          )}
        </div>
      </SettingsSection>

      <SettingsSection
        title={gt("Instrumented application I/O")}
        headerAction={
          <span className="text-3xs text-dim-foreground">
            <T>Logical bytes by operation</T>
          </span>
        }
      >
        <div className="overflow-hidden rounded-card border border-transparent surface-card-settings">
          <div className="bg-muted/15 px-4 py-3 text-2xs leading-relaxed text-muted-foreground sm:px-5">
            <T>
              Native counters identify which process is reading or writing. These application-level
              counters identify known T3 operations so process spikes can be correlated with
              specific persistence and logging paths.
            </T>
          </div>
          <AttributionTable entries={snapshot?.attribution.entries ?? []} />
        </div>
      </SettingsSection>
    </>
  );
}
