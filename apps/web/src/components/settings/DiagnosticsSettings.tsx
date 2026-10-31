import { ProcessSignalActions } from "./ProcessSignalActions";
import { resolveUsageAccess } from "@t3tools/client-runtime/state/usage-access";
import { environmentSession } from "../../state/session";
import { AuthOrchestrationOperateScope } from "@t3tools/contracts";
import { readEnvironmentScope, useEnvironmentScope } from "../../state/session";
import { AuthEnvironmentMaintainScope } from "@t3tools/contracts";
import { RefreshIcon } from "~/components/ui/refresh-icon";
import {
  AlertTriangleIcon,
  CircleSlashIcon,
  CopyIcon,
  FolderOpenIcon,
  InfoIcon,
} from "lucide-react";
import { ChevronDown, ChevronRight } from "lucide";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { Fragment, useRef, useState, type ReactNode } from "react";
import type {
  ServerProcessDiagnosticsEntry,
  ServerProcessResourceHistorySummary,
  ServerProcessSignal,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";

import { formatBytes } from "../../lib/formatBytes";
import { cn } from "../../lib/utils";
import { ensureLocalApi } from "../../localApi";
import { useOpenInPreferredEditor } from "../../editorPreferences";
import { useRelativeTimeState } from "../../hooks/useRelativeTimeState";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { Button } from "../ui/button";
import { MorphIcon } from "~/components/MorphIcon";
import { ScrollArea } from "../ui/scroll-area";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { toastManager } from "../ui/toast";
import { ExpandableText } from "./ExpandableText";
import { ResourceTelemetryDiagnostics } from "./ResourceTelemetryDiagnostics";
import {
  SettingsPageContainer,
  SettingsNote,
  SettingsRow,
  SettingsSection,
} from "./settingsLayout";
import { Badge } from "../ui/badge";
import { useAtomCommand } from "../../state/use-atom-command";
import { useSettingsScope } from "./SettingsScopeContext";
import { TelemetryExportSettings } from "./TelemetryExportSettings";

const NUMBER_FORMAT = new Intl.NumberFormat();
/** Shown in place of a total the process monitor could not measure. */
const UNAVAILABLE_VALUE = "-";

function formatCount(value: number): string {
  return NUMBER_FORMAT.format(value);
}

function formatDuration(value: number): string {
  if (value < 1_000) return `${Math.round(value)} ms`;
  return `${(value / 1_000).toFixed(value >= 10_000 ? 1 : 2).replace(/\.0+$/, "")} s`;
}

function RelativeTimeNoWrap(props: { value: DateTime.Utc }) {
  const relative = useRelativeTimeState(DateTime.formatIso(props.value));
  if (relative.status !== "relative") return null;
  return relative.suffix ? `${relative.value}\u00a0${relative.suffix}` : relative.value;
}

function shortenTraceId(traceId: string): string {
  if (traceId.length <= 32) return traceId;
  return `${traceId.slice(0, 18)}...${traceId.slice(-10)}`;
}

function isStaleProcessSignalMessage(message: string | undefined): boolean {
  return message?.includes("not a live descendant") ?? false;
}

function StatTooltip({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            className="inline-flex size-3.5 shrink-0 cursor-pointer items-center justify-center rounded-sm text-dim-foreground hover:text-foreground"
            aria-label={`${label} details`}
          >
            <InfoIcon className="size-3" />
          </button>
        }
      />
      <TooltipPopup side="top">{children}</TooltipPopup>
    </Tooltip>
  );
}

function StatBlock({
  label,
  value,
  tooltip,
  tone = "default",
}: {
  label: string;
  value: string;
  tooltip?: ReactNode;
  tone?: "default" | "warning" | "danger";
}) {
  return (
    <div className="min-w-0 border-border/60 px-4 py-3 sm:px-5">
      <div className="flex min-w-0 items-center gap-1.5 text-caption text-dim-foreground">
        <span className="min-w-0 truncate">{label}</span>
        {tooltip ? <StatTooltip label={label}>{tooltip}</StatTooltip> : null}
      </div>
      <div
        className={cn(
          "mt-1 truncate font-mono text-lg font-semibold tabular-nums text-foreground",
          tone === "warning" && "text-warning-foreground",
          tone === "danger" && "text-destructive",
        )}
      >
        {value}
      </div>
    </div>
  );
}

function StatsGrid({ children }: { children: ReactNode }) {
  return (
    <div className="relative grid grid-cols-2 sm:grid-cols-4">
      <span
        className="pointer-events-none absolute inset-y-0 left-1/2 w-px bg-border/60"
        aria-hidden
      />
      <span
        className="pointer-events-none absolute inset-x-0 top-1/2 h-px bg-border/60 sm:hidden"
        aria-hidden
      />
      <span
        className="pointer-events-none absolute inset-y-0 left-1/4 hidden w-px bg-border/60 sm:block"
        aria-hidden
      />
      <span
        className="pointer-events-none absolute inset-y-0 left-3/4 hidden w-px bg-border/60 sm:block"
        aria-hidden
      />
      {children}
    </div>
  );
}

/** One Overview tile: a card with a dim label over a large value. */
function OverviewTile({
  label,
  value,
  tooltip,
}: {
  label: string;
  value: string;
  tooltip?: ReactNode;
}) {
  // The transparent border matches SettingsGroup's, so the text sits on the rows' text line (card edge + 17).
  return (
    <div className="min-w-0 rounded-card border border-transparent surface-card-settings px-4 py-3">
      <div className="flex min-w-0 items-center gap-1.5 text-meta text-dim-foreground">
        <span className="min-w-0 truncate">{label}</span>
        {tooltip ? <StatTooltip label={label}>{tooltip}</StatTooltip> : null}
      </div>
      <div className="mt-1 truncate text-xl font-semibold tabular-nums text-strong-foreground">
        {value}
      </div>
    </div>
  );
}

function EmptyRows({ label }: { label: string }) {
  return <div className="px-4 py-4 text-meta text-muted-foreground sm:px-5">{label}</div>;
}

/**
 * A fixed-layout table that fits its settings card. Secondary values go on a
 * `RowDetail` line under the first cell instead of into more columns.
 */
function DiagnosticsTable({
  columns,
  children,
}: {
  columns: ReadonlyArray<{ label: string; width?: string; numeric?: boolean }>;
  children: ReactNode;
}) {
  return (
    <table className="w-full table-fixed text-left text-meta">
      <colgroup>
        {columns.map((column) => (
          <col key={column.label} className={column.width} />
        ))}
      </colgroup>
      <thead className="border-b border-border/60 text-caption text-dim-foreground">
        <tr>
          {columns.map((column) => (
            <th
              key={column.label}
              className={cn(
                "whitespace-nowrap px-3 py-2.5 font-semibold first:pl-4 last:pr-4 first:sm:pl-5 last:sm:pr-5",
                column.numeric && "text-right",
              )}
            >
              {column.label}
            </th>
          ))}
        </tr>
      </thead>
      <tbody className="divide-y divide-border/60">{children}</tbody>
    </table>
  );
}

/** A dotted span name that wraps between its segments, not inside a word. */
function SpanName({ name }: { name: string }) {
  const segments = name.split(".");
  return segments.map((segment, index) => (
    <Fragment key={segments.slice(0, index + 1).join(".")}>
      {index > 0 ? (
        <>
          .<wbr />
        </>
      ) : null}
      {segment}
    </Fragment>
  ));
}

/** The muted second line of a table row's first cell. */
function RowDetail({ children }: { children: ReactNode }) {
  return (
    <div className="mt-0.5 min-w-0 truncate font-mono text-caption tabular-nums text-dim-foreground">
      {children}
    </div>
  );
}

function TraceIdCell({ traceId }: { traceId: string }) {
  const { copyToClipboard, isCopied: copied } = useCopyToClipboard({
    target: "trace ID",
    timeout: 1_200,
  });

  return (
    <div className="flex w-full min-w-0 max-w-full items-center gap-2">
      <Tooltip>
        <TooltipTrigger
          render={
            <span className="min-w-0 truncate font-mono text-caption">
              {shortenTraceId(traceId)}
            </span>
          }
        />
        <TooltipPopup side="top" variant="code">
          {traceId}
        </TooltipPopup>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              size="icon-micro"
              variant="ghost-muted"
              aria-label={copied ? "Copied trace ID" : "Copy trace ID"}
              onClick={() => copyToClipboard(traceId)}
            >
              <CopyIcon className="size-3" />
            </Button>
          }
        />
        <TooltipPopup side="top">{copied ? "Copied" : "Copy full trace ID"}</TooltipPopup>
      </Tooltip>
    </div>
  );
}

function formatProcessName(command: string): string {
  const firstToken = command.trim().split(/\s+/)[0];
  if (!firstToken) return command;
  const normalized = firstToken.replace(/^['"]|['"]$/g, "");
  const segments = normalized.split(/[\\/]/).filter(Boolean);
  return segments.at(-1) ?? normalized;
}

function formatProcessType(process: ServerProcessDiagnosticsEntry): string {
  if (process.depth > 0) return "Subprocess";
  if (/\b(codex|claude|opencode|cursor)\b/i.test(process.command)) return "Agent";
  return "Process";
}

function ProcessNameCell({
  process,
  isExpanded,
  onToggle,
}: {
  process: ServerProcessDiagnosticsEntry;
  isExpanded: boolean;
  onToggle: (pid: number) => void;
}) {
  const name = formatProcessName(process.command);
  const hasChildren = process.childPids.length > 0;

  return (
    <div
      className="grid min-w-0 grid-cols-[1.25rem_0.375rem_minmax(0,1fr)] items-center gap-2"
      style={{ paddingLeft: `${Math.min(process.depth, 6) * 10}px` }}
    >
      {hasChildren ? (
        <Button
          size="icon-micro"
          variant="ghost-muted"
          aria-label={isExpanded ? `Collapse ${name}` : `Expand ${name}`}
          onClick={() => onToggle(process.pid)}
        >
          <MorphIcon className="size-3.5" icon={isExpanded ? ChevronDown : ChevronRight} />
        </Button>
      ) : (
        <span className="size-5 shrink-0" aria-hidden="true" />
      )}
      <span className="size-1.5 shrink-0 rounded-full bg-success/80" />
      <div className="min-w-0">
        <div className="truncate font-medium text-strong-foreground">{name}</div>
        <Tooltip>
          <TooltipTrigger
            render={
              <RowDetail>
                {process.pid} · {formatProcessType(process)} · {process.command}
              </RowDetail>
            }
          />
          <TooltipPopup side="top" variant="code">
            {process.command}
          </TooltipPopup>
        </Tooltip>
      </div>
    </div>
  );
}

function visibleProcessTree(
  processes: ReadonlyArray<ServerProcessDiagnosticsEntry>,
  collapsedPids: ReadonlySet<number>,
) {
  const visible: ServerProcessDiagnosticsEntry[] = [];
  let hiddenChildDepth: number | null = null;

  for (const process of processes) {
    if (hiddenChildDepth !== null) {
      if (process.depth > hiddenChildDepth) continue;
      hiddenChildDepth = null;
    }

    visible.push(process);
    if (collapsedPids.has(process.pid)) {
      hiddenChildDepth = process.depth;
    }
  }

  return visible;
}

function ProcessDiagnosticsTable({
  processes,
  canMaintainEnvironment,
  signalingPid,
  onSignal,
  emptyLabel,
}: {
  processes: ReadonlyArray<ServerProcessDiagnosticsEntry>;
  canMaintainEnvironment: boolean;
  signalingPid: number | null;
  onSignal: (pid: number, signal: ServerProcessSignal) => void;
  emptyLabel?: string;
}) {
  const [collapsedPids, setCollapsedPids] = useState<ReadonlySet<number>>(() => new Set());
  const visibleProcesses = visibleProcessTree(processes, collapsedPids);

  const toggleProcess = (pid: number) => {
    setCollapsedPids((previous) => {
      const next = new Set(previous);
      if (next.has(pid)) {
        next.delete(pid);
      } else {
        next.add(pid);
      }
      return next;
    });
  };

  return (
    <div className="border-t border-border/60">
      <ScrollArea
        radius="none"
        chainVerticalScroll
        scrollFade
        hideScrollbars
        className="max-h-[min(64vh,44rem)] w-full max-w-full"
      >
        <table className="w-full table-fixed text-left text-meta">
          <colgroup>
            <col />
            <col className="w-18" />
            <col className="w-22" />
            <col className="w-24" />
          </colgroup>
          <thead className="sticky top-0 z-10 border-b border-border/60 bg-card text-caption text-dim-foreground">
            <tr>
              <th className="px-4 py-2 font-semibold sm:pl-5">Process</th>
              <th className="px-3 py-2 text-right font-semibold">CPU</th>
              <th className="px-3 py-2 text-right font-semibold">Memory</th>
              <th className="p-2 font-semibold sm:pr-4">
                <span className="sr-only">Signal</span>
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border/50">
            {visibleProcesses.length === 0 ? (
              <tr>
                <td colSpan={4} className="px-4 py-4 text-meta text-muted-foreground sm:px-5">
                  {emptyLabel ?? "No live descendant processes found."}
                </td>
              </tr>
            ) : null}
            {visibleProcesses.map((process) => (
              <tr key={process.pid} className="hover:surface-ghost-hover">
                <td className="px-4 py-2 align-middle sm:pl-5">
                  <ProcessNameCell
                    process={process}
                    isExpanded={!collapsedPids.has(process.pid)}
                    onToggle={toggleProcess}
                  />
                </td>
                <td className="px-3 py-2 text-right align-middle font-mono tabular-nums">
                  {process.cpuPercent.toFixed(1)}%
                </td>
                <td className="px-3 py-2 text-right align-middle font-mono tabular-nums">
                  {formatBytes(process.rssBytes)}
                </td>
                <td className="p-2 align-middle sm:pr-4">
                  <ProcessSignalActions
                    disabled={!canMaintainEnvironment || signalingPid === process.pid}
                    onSignal={(signal) => onSignal(process.pid, signal)}
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

const RESOURCE_HISTORY_WINDOWS = [
  { label: "5m", windowMs: 5 * 60_000, bucketMs: 30_000 },
  { label: "15m", windowMs: 15 * 60_000, bucketMs: 60_000 },
  { label: "30m", windowMs: 30 * 60_000, bucketMs: 2 * 60_000 },
  { label: "1h", windowMs: 60 * 60_000, bucketMs: 5 * 60_000 },
] as const;

function formatCpuTime(seconds: number): string {
  if (seconds < 60) return `${seconds.toFixed(seconds >= 10 ? 1 : 2).replace(/\.0+$/, "")}s`;
  const minutes = seconds / 60;
  if (minutes < 60) return `${minutes.toFixed(minutes >= 10 ? 1 : 2).replace(/\.0+$/, "")}m`;
  return `${(minutes / 60).toFixed(2).replace(/\.0+$/, "")}h`;
}

function formatShortProcessName(command: string): string {
  const name = formatProcessName(command);
  return name.length > 42 ? `${name.slice(0, 39)}...` : name;
}

function ResourceHistoryProcessNameCell({
  process,
  visualDepth,
}: {
  process: ServerProcessResourceHistorySummary;
  visualDepth: number;
}) {
  const name = formatShortProcessName(process.command);

  return (
    <div
      className="grid min-w-0 grid-cols-[1.25rem_0.375rem_minmax(0,1fr)] items-center gap-2"
      style={{ paddingLeft: `${Math.min(visualDepth, 6) * 10}px` }}
      aria-label={`${process.isServerRoot ? "Root" : "Child"} process ${name}`}
    >
      <span className="size-5 shrink-0" aria-hidden="true" />
      <span
        className={cn(
          "size-1.5 shrink-0 rounded-full",
          process.isServerRoot ? "bg-warning/90" : "bg-success/80",
        )}
      />
      <div className="min-w-0">
        <div className="truncate font-medium text-strong-foreground">{name}</div>
        <Tooltip>
          <TooltipTrigger
            render={
              <RowDetail>
                {process.pid} · now {process.currentCpuPercent.toFixed(1)}% · {process.command}
              </RowDetail>
            }
          />
          <TooltipPopup side="top" variant="code">
            {process.command}
          </TooltipPopup>
        </Tooltip>
      </div>
    </div>
  );
}

function ProcessResourceHistoryChart({
  buckets,
}: {
  buckets: ReadonlyArray<{
    readonly startedAt: DateTime.Utc;
    readonly avgCpuPercent: number;
    readonly maxCpuPercent: number;
  }>;
}) {
  const maxCpuPercent = Math.max(1, ...buckets.map((bucket) => bucket.maxCpuPercent));

  return (
    <div className="border-t border-border/60 px-4 py-3 sm:px-5">
      <div className="flex h-28 items-end gap-1 overflow-hidden rounded-sm bg-muted/10 p-2">
        {buckets.map((bucket) => {
          const peakHeight = Math.max(2, (bucket.maxCpuPercent / maxCpuPercent) * 100);
          const averageHeight = Math.max(2, (bucket.avgCpuPercent / maxCpuPercent) * 100);
          return (
            <Tooltip key={DateTime.formatIso(bucket.startedAt)}>
              <TooltipTrigger
                render={
                  <div className="flex h-full min-w-1 flex-1 items-end">
                    <div
                      className="relative h-full w-full"
                      aria-label={`Average CPU ${bucket.avgCpuPercent.toFixed(1)}%, peak CPU ${bucket.maxCpuPercent.toFixed(1)}%`}
                    >
                      <div
                        className="absolute inset-x-0 bottom-0 rounded-t-sm bg-foreground/15 transition-colors"
                        style={{ height: `${peakHeight}%` }}
                      />
                      <div
                        className="absolute inset-x-0 bottom-0 rounded-t-sm bg-foreground/60 transition-colors"
                        style={{ height: `${averageHeight}%` }}
                      />
                    </div>
                  </div>
                }
              />
              <TooltipPopup side="top">
                Avg {bucket.avgCpuPercent.toFixed(1)}%, peak {bucket.maxCpuPercent.toFixed(1)}%
              </TooltipPopup>
            </Tooltip>
          );
        })}
      </div>
    </div>
  );
}

function ResourceHistoryWindowSelector({
  selectedWindowMs,
  onSelect,
}: {
  selectedWindowMs: number;
  onSelect: (windowMs: number) => void;
}) {
  return (
    <ToggleGroup
      aria-label="Process history period"
      variant="segmented"
      value={[String(selectedWindowMs)]}
      onValueChange={(next) => {
        const selected = RESOURCE_HISTORY_WINDOWS.find(
          (option) => String(option.windowMs) === next[0],
        );
        if (selected) onSelect(selected.windowMs);
      }}
    >
      {RESOURCE_HISTORY_WINDOWS.map((option) => (
        <Toggle key={option.windowMs} value={String(option.windowMs)}>
          {option.label}
        </Toggle>
      ))}
    </ToggleGroup>
  );
}

function ProcessResourceHistoryTable({
  processes,
  emptyLabel,
}: {
  processes: ReadonlyArray<ServerProcessResourceHistorySummary>;
  emptyLabel: string;
}) {
  const shallowestChildDepth = processes.reduce<number | null>((minDepth, process) => {
    if (process.isServerRoot) return minDepth;
    return minDepth === null ? process.depth : Math.min(minDepth, process.depth);
  }, null);

  return (
    <div className="border-t border-border/60">
      <ScrollArea
        chainVerticalScroll
        scrollFade
        hideScrollbars
        className="max-h-[min(64vh,44rem)] w-full max-w-full"
      >
        <table className="w-full table-fixed text-left text-meta">
          <colgroup>
            <col />
            <col className="w-20" />
            <col className="w-18" />
            <col className="w-18" />
            <col className="w-22" />
          </colgroup>
          <thead className="sticky top-0 z-10 border-b border-border/60 bg-card text-caption text-dim-foreground">
            <tr>
              <th className="px-4 py-2 font-semibold sm:pl-5">Process</th>
              <th className="px-3 py-2 text-right font-semibold">CPU time</th>
              <th className="px-3 py-2 text-right font-semibold">Average</th>
              <th className="px-3 py-2 text-right font-semibold">Peak</th>
              <th className="px-3 py-2 text-right font-semibold sm:pr-5">Max mem</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border/50">
            {processes.length === 0 ? (
              <tr>
                <td colSpan={5} className="px-4 py-4 text-meta text-muted-foreground sm:px-5">
                  {emptyLabel}
                </td>
              </tr>
            ) : null}
            {processes.map((process) => (
              <tr key={process.processKey} className="hover:surface-ghost-hover">
                <td className="px-4 py-2 align-middle sm:pl-5">
                  <ResourceHistoryProcessNameCell
                    process={process}
                    visualDepth={
                      process.isServerRoot || shallowestChildDepth === null
                        ? 0
                        : Math.max(1, process.depth - shallowestChildDepth + 1)
                    }
                  />
                </td>
                <td className="px-3 py-2 text-right align-middle font-mono tabular-nums">
                  {formatCpuTime(process.cpuSecondsApprox)}
                </td>
                <td className="px-3 py-2 text-right align-middle font-mono tabular-nums">
                  {process.avgCpuPercent.toFixed(1)}%
                </td>
                <td className="px-3 py-2 text-right align-middle font-mono tabular-nums">
                  {process.maxCpuPercent.toFixed(1)}%
                </td>
                <td className="px-3 py-2 text-right align-middle font-mono tabular-nums sm:pr-5">
                  {formatBytes(process.maxRssBytes)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </ScrollArea>
    </div>
  );
}

function DiagnosticsLastChecked({ checkedAt }: { checkedAt: DateTime.Utc | null }) {
  const relative = useRelativeTimeState(checkedAt ? DateTime.formatIso(checkedAt) : null);

  if (relative.status === "missing") {
    return <span className="text-caption text-dim-foreground">Checking</span>;
  }

  if (relative.status === "invalid") {
    return <span className="text-caption text-dim-foreground">Checked unavailable</span>;
  }

  return (
    <span className="text-caption text-dim-foreground">
      {relative.suffix ? (
        <>
          Checked <span className="font-mono tabular-nums">{relative.value}</span> {relative.suffix}
        </>
      ) : (
        <>Checked {relative.value}</>
      )}
    </span>
  );
}

function DiagnosticsRefreshButton({
  isPending,
  label,
  onClick,
}: {
  isPending: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            size="icon-xs"
            variant="ghost-muted"
            disabled={isPending}
            onClick={onClick}
            aria-label={label}
          >
            <RefreshIcon refreshing={isPending} />
          </Button>
        }
      />
      <TooltipPopup side="top">{label}</TooltipPopup>
    </Tooltip>
  );
}

export function DiagnosticsSettingsPanel() {
  const { environment } = useSettingsScope();
  // Signals and pending UI state belong to one environment, so a scope switch starts fresh.
  return <DiagnosticsSettingsBody key={environment?.environmentId ?? ""} />;
}

function DiagnosticsSettingsBody() {
  const { environment } = useSettingsScope();
  const environmentId = environment?.environmentId ?? null;
  const canMaintainEnvironment = useEnvironmentScope(environmentId, AuthEnvironmentMaintainScope);
  const observability = environment?.serverConfig?.observability;
  const availableEditors = environment?.serverConfig?.availableEditors;
  const canOpenHostEditor = useEnvironmentScope(environmentId, AuthOrchestrationOperateScope);
  const session = useEnvironmentQuery(
    environmentId === null ? null : environmentSession.sessionStateAtom(environmentId),
  );
  const diagnosticsAccess = resolveUsageAccess({
    connectionPhase: environment?.connection.phase ?? "available",
    session: session.data,
    hasSessionError: session.error !== null,
  });
  const canReadDiagnostics = diagnosticsAccess.canReadDiagnostics;
  const signalServerProcess = useAtomCommand(serverEnvironment.signalProcess, {
    reportFailure: false,
  });
  const openInEditor = useOpenInPreferredEditor(environmentId, availableEditors ?? []);
  const [resourceWindowMs, setResourceWindowMs] = useState(15 * 60_000);
  const selectedResourceWindow =
    RESOURCE_HISTORY_WINDOWS.find((option) => option.windowMs === resourceWindowMs) ??
    RESOURCE_HISTORY_WINDOWS[1];
  const { data, error, isPending, refresh } = useEnvironmentQuery(
    environmentId === null || !canReadDiagnostics
      ? null
      : serverEnvironment.traceDiagnostics({ environmentId, input: {} }),
  );
  const {
    data: processData,
    error: processError,
    isPending: isProcessPending,
    refresh: refreshProcesses,
  } = useEnvironmentQuery(
    environmentId === null || !canReadDiagnostics
      ? null
      : serverEnvironment.processDiagnostics({ environmentId, input: {} }),
  );
  const {
    data: resourceData,
    error: resourceError,
    isPending: isResourcePending,
    refresh: refreshResources,
  } = useEnvironmentQuery(
    environmentId === null || !canReadDiagnostics
      ? null
      : serverEnvironment.processResourceHistory({
          environmentId,
          input: {
            windowMs: selectedResourceWindow.windowMs,
            bucketMs: selectedResourceWindow.bucketMs,
          },
        }),
  );
  const [isOpeningLogsDirectory, setIsOpeningLogsDirectory] = useState(false);
  const [openLogsDirectoryError, setOpenLogsDirectoryError] = useState<string | null>(null);
  const [signalingPid, setSignalingPid] = useState<number | null>(null);
  const signalingPidRef = useRef<number | null>(null);

  const openLogsDirectory = () => {
    const logsDirectoryPath = observability?.logsDirectoryPath ?? null;
    if (!logsDirectoryPath) return;

    if (
      environmentId === null ||
      !readEnvironmentScope(environmentId, AuthOrchestrationOperateScope)
    ) {
      return;
    }

    setIsOpeningLogsDirectory(true);
    setOpenLogsDirectoryError(null);
    void (async () => {
      const result = await openInEditor(logsDirectoryPath);
      setIsOpeningLogsDirectory(false);
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        setOpenLogsDirectoryError(
          error instanceof Error ? error.message : "Unable to open logs folder.",
        );
      }
    })();
  };

  const isInitialLoading = isPending && data === null;
  const isProcessInitialLoading = isProcessPending && processData === null;
  const isResourceInitialLoading = isResourcePending && resourceData === null;
  // Wait for initial tables to stabilize search targets; later loads must preserve export drafts.
  const [exportFormEnvironmentId, setExportFormEnvironmentId] =
    useState<typeof environmentId>(null);
  if (
    exportFormEnvironmentId !== environmentId &&
    canReadDiagnostics &&
    !isInitialLoading &&
    !isProcessInitialLoading &&
    !isResourceInitialLoading
  ) {
    setExportFormEnvironmentId(environmentId);
  }
  const signalProcess = async (pid: number, signal: ServerProcessSignal) => {
    const targetEnvironmentId = environmentId;
    const process = processData?.processes.find((entry) => entry.pid === pid);
    if (
      targetEnvironmentId === null ||
      process === undefined ||
      !readEnvironmentScope(targetEnvironmentId, AuthEnvironmentMaintainScope)
    )
      return;
    if (signalingPidRef.current !== null) return;
    signalingPidRef.current = pid;
    setSignalingPid(pid);
    const clearSignaling = () => {
      signalingPidRef.current = null;
      setSignalingPid(null);
    };
    if (signal === "SIGKILL") {
      let confirmed = false;
      try {
        confirmed = await ensureLocalApi().dialogs.confirm(
          `Send SIGKILL to process ${pid}? This cannot be handled by the process.`,
          { variant: "destructive" },
        );
      } catch (error) {
        clearSignaling();
        toastManager.add({
          type: "error",
          title: "Could not confirm signal",
          description: error instanceof Error ? error.message : `Failed to send ${signal}.`,
        });
        return;
      }
      if (!confirmed) {
        clearSignaling();
        return;
      }
    }
    // The server rejects a pid whose start time no longer matches, so a process that exited
    // during confirmation is never signaled by mistake.
    if (!readEnvironmentScope(targetEnvironmentId, AuthEnvironmentMaintainScope)) {
      clearSignaling();
      return;
    }

    const result = await signalServerProcess({
      environmentId: targetEnvironmentId,
      input: { pid, startTimeMs: process.startTimeMs, signal },
    });
    clearSignaling();
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        toastManager.add({
          type: "error",
          title: `Could not send ${signal}`,
          description: error instanceof Error ? error.message : `Failed to send ${signal}.`,
        });
      }
      return;
    }
    if (!result.value.signaled) {
      const message = Option.getOrUndefined(result.value.message);
      refreshProcesses();
      if (isStaleProcessSignalMessage(message)) {
        toastManager.add({
          type: "info",
          title: "Process already exited",
          description: "The process is not a child of the T3 Server. It might already have exited.",
        });
        return;
      }

      toastManager.add({
        type: "error",
        title: `Could not send ${signal}`,
        description: message ?? `Failed to send ${signal}.`,
      });
      return;
    }
    refreshProcesses();
  };

  const processDiagnosticsError = processData ? Option.getOrNull(processData.error) : null;
  const processNote = processDiagnosticsError?.message ?? processError;
  // A monitor error with no processes means the totals are not zero, just unknown.
  const processTotalsUnavailable = processData
    ? processDiagnosticsError !== null && processData.processes.length === 0
    : processError !== null;
  const processResourceError = resourceData ? Option.getOrNull(resourceData.error) : null;
  const resourceNote = processResourceError?.message ?? resourceError;
  const resourceTotalsUnavailable = resourceData
    ? processResourceError !== null && resourceData.topProcesses.length === 0
    : resourceError !== null;
  const traceDiagnosticsError = data ? Option.getOrNull(data.error) : null;
  const traceDiagnosticsPartialFailure = data
    ? Option.getOrElse(data.partialFailure, () => false)
    : false;

  if (!canReadDiagnostics) {
    return (
      <SettingsPageContainer>
        <p className="text-sm text-muted-foreground">
          {environmentId === null
            ? "Connect an environment to see diagnostics."
            : diagnosticsAccess.isPending
              ? "Checking diagnostics access…"
              : diagnosticsAccess.error}
        </p>
      </SettingsPageContainer>
    );
  }

  return (
    <SettingsPageContainer width="expanded">
      <section className="space-y-2">
        <h2 className="flex min-h-7 items-center text-label text-dim-foreground">Overview</h2>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <OverviewTile
            label="Server PID"
            value={processData ? String(processData.serverPid) : "..."}
          />
          <OverviewTile
            label="CPU"
            value={
              processTotalsUnavailable
                ? UNAVAILABLE_VALUE
                : processData
                  ? `${processData.totalCpuPercent.toFixed(1)}%`
                  : "..."
            }
            tooltip="Total CPU across live child processes of the current server process. The desktop shell and other parent processes are not included."
          />
          <OverviewTile
            label="Memory"
            value={
              processTotalsUnavailable
                ? UNAVAILABLE_VALUE
                : processData
                  ? formatBytes(processData.totalRssBytes)
                  : "..."
            }
            tooltip="Total resident memory across live child processes of the current server process. The desktop shell and other parent processes are not included."
          />
          <OverviewTile
            label="Child processes"
            value={
              processTotalsUnavailable
                ? UNAVAILABLE_VALUE
                : processData
                  ? formatCount(processData.processCount)
                  : "..."
            }
          />
        </div>
      </section>

      <SettingsSection
        title="Live processes"
        headerAction={
          <div className="flex items-center gap-1.5">
            <DiagnosticsLastChecked checkedAt={processData?.readAt ?? null} />
            <DiagnosticsRefreshButton
              isPending={isProcessPending}
              label="Refresh process diagnostics"
              onClick={refreshProcesses}
            />
          </div>
        }
      >
        {processNote ? (
          <SettingsNote icon={<CircleSlashIcon className="text-dim-foreground" />}>
            {processNote}
          </SettingsNote>
        ) : null}
        {processTotalsUnavailable ? null : (
          <ProcessDiagnosticsTable
            processes={processData?.processes ?? []}
            canMaintainEnvironment={canMaintainEnvironment}
            signalingPid={signalingPid}
            onSignal={signalProcess}
            emptyLabel={
              isProcessInitialLoading
                ? "Loading live processes..."
                : "No live descendant processes found."
            }
          />
        )}
      </SettingsSection>

      <SettingsSection
        title="Trace diagnostics"
        headerAction={
          <div className="flex items-center gap-1.5">
            <DiagnosticsLastChecked checkedAt={data?.readAt ?? null} />
            <Button
              size="xs"
              variant="secondary"
              disabled={
                !canOpenHostEditor || !observability?.logsDirectoryPath || isOpeningLogsDirectory
              }
              onClick={openLogsDirectory}
            >
              <FolderOpenIcon />
              Open logs folder
            </Button>
            <DiagnosticsRefreshButton
              isPending={isPending}
              label="Refresh trace diagnostics"
              onClick={refresh}
            />
          </div>
        }
      >
        <SettingsRow
          title="Spans"
          description="Recorded in the current trace files."
          control={
            <span className="font-mono text-body tabular-nums text-foreground">
              {data ? formatCount(data.recordCount) : "..."}
            </span>
          }
        />
        <SettingsRow
          title="Failures"
          description={
            data && data.commonFailures[0]
              ? `${formatCount(data.commonFailures[0].count)} in ${data.commonFailures[0].name}`
              : "Spans that ended with an error."
          }
          control={
            data ? (
              <Badge variant={data.failureCount > 0 ? "error" : "secondary"}>
                {data.failureCount > 0 ? `${formatCount(data.failureCount)} failed` : "None"}
              </Badge>
            ) : (
              <span className="text-body text-muted-foreground">...</span>
            )
          }
        />
        <SettingsRow
          title="Slow spans"
          description={
            data
              ? `Spans that took ${formatDuration(data.slowSpanThresholdMs)} or longer.`
              : "Spans at or above the slow-span threshold."
          }
          control={
            <Badge variant={data && data.slowSpanCount > 0 ? "warning" : "secondary"}>
              {data ? formatCount(data.slowSpanCount) : "..."}
            </Badge>
          }
        />
        {data && data.parseErrorCount > 0 ? (
          <SettingsRow
            title="Parse errors"
            description="Trace lines that could not be read."
            control={<Badge variant="warning">{formatCount(data.parseErrorCount)}</Badge>}
          />
        ) : null}
        {openLogsDirectoryError || traceDiagnosticsError || error ? (
          <div className="space-y-2 px-4 py-3 text-meta text-muted-foreground sm:px-5">
            {openLogsDirectoryError ? (
              <div className="flex items-start gap-2 text-destructive">
                <AlertTriangleIcon className="size-3.5 h-lh shrink-0" />
                <span>{openLogsDirectoryError}</span>
              </div>
            ) : null}
            {traceDiagnosticsError ? (
              <div
                className={cn(
                  "flex items-start gap-2",
                  traceDiagnosticsPartialFailure ? "text-warning-foreground" : "text-destructive",
                )}
              >
                <AlertTriangleIcon className="size-3.5 h-lh shrink-0" />
                <span>
                  {traceDiagnosticsPartialFailure
                    ? `Some trace files could not be read, so diagnostics may be incomplete. ${traceDiagnosticsError.message}`
                    : traceDiagnosticsError.message}
                </span>
              </div>
            ) : null}
            {error ? (
              <div className="flex items-start gap-2 text-destructive">
                <AlertTriangleIcon className="size-3.5 h-lh shrink-0" />
                <span>{error}</span>
              </div>
            ) : null}
          </div>
        ) : null}
      </SettingsSection>

      <SettingsSection title="Latest failures">
        {data && data.latestFailures.length > 0 ? (
          <DiagnosticsTable columns={[{ label: "Span", width: "w-[38%]" }, { label: "Cause" }]}>
            {data.latestFailures.map((failure) => (
              <tr key={`${failure.traceId}:${failure.spanId}`}>
                <td className="py-3 pr-3 pl-4 align-top sm:pl-5">
                  <div className="break-words text-strong-foreground">
                    <SpanName name={failure.name} />
                  </div>
                  <RowDetail>
                    {formatDuration(failure.durationMs)} ·{" "}
                    <RelativeTimeNoWrap value={failure.endedAt} />
                  </RowDetail>
                </td>
                <td className="py-3 pr-4 pl-3 align-top break-words text-muted-foreground sm:pr-5">
                  <ExpandableText text={failure.cause} />
                </td>
              </tr>
            ))}
          </DiagnosticsTable>
        ) : (
          <EmptyRows label={isInitialLoading ? "Loading failures..." : "No failed spans found."} />
        )}
      </SettingsSection>

      <SettingsSection title="Most common failures">
        {data && data.commonFailures.length > 0 ? (
          <DiagnosticsTable
            columns={[
              { label: "Span", width: "w-[38%]" },
              { label: "Cause" },
              { label: "Count", width: "w-20", numeric: true },
            ]}
          >
            {data.commonFailures.map((failure) => (
              <tr key={`${failure.name}:${failure.cause}`}>
                <td className="py-3 pr-3 pl-4 align-top sm:pl-5">
                  <div className="break-words text-strong-foreground">
                    <SpanName name={failure.name} />
                  </div>
                  <RowDetail>
                    Last <RelativeTimeNoWrap value={failure.lastSeenAt} />
                  </RowDetail>
                </td>
                <td className="px-3 py-3 align-top break-words text-muted-foreground">
                  <ExpandableText text={failure.cause} />
                </td>
                <td className="py-3 pr-4 pl-3 text-right align-top font-mono tabular-nums sm:pr-5">
                  {formatCount(failure.count)}
                </td>
              </tr>
            ))}
          </DiagnosticsTable>
        ) : (
          <EmptyRows
            label={isInitialLoading ? "Loading failure groups..." : "No repeated failures found."}
          />
        )}
      </SettingsSection>

      <SettingsSection title="Slowest spans">
        {data && data.slowestSpans.length > 0 ? (
          <DiagnosticsTable
            columns={[
              { label: "Span" },
              { label: "Duration", width: "w-22", numeric: true },
              { label: "Ended", width: "w-24", numeric: true },
            ]}
          >
            {data.slowestSpans.map((span) => (
              <tr key={`${span.traceId}:${span.spanId}`}>
                <td className="py-3 pr-3 pl-4 align-top sm:pl-5">
                  <div className="break-words text-strong-foreground">
                    <SpanName name={span.name} />
                  </div>
                  <div className="mt-0.5 text-dim-foreground">
                    <TraceIdCell traceId={span.traceId} />
                  </div>
                </td>
                <td className="px-3 py-3 text-right align-top font-mono tabular-nums">
                  {formatDuration(span.durationMs)}
                </td>
                <td className="py-3 pr-4 pl-3 text-right align-top font-mono tabular-nums whitespace-nowrap text-muted-foreground sm:pr-5">
                  <RelativeTimeNoWrap value={span.endedAt} />
                </td>
              </tr>
            ))}
          </DiagnosticsTable>
        ) : (
          <EmptyRows label={isInitialLoading ? "Loading slow spans..." : "No spans found."} />
        )}
      </SettingsSection>

      <SettingsSection title="Span logs">
        {data && data.latestWarningAndErrorLogs.length > 0 ? (
          <DiagnosticsTable
            columns={[
              { label: "Time", width: "w-24" },
              { label: "Span", width: "w-[34%]" },
              { label: "Message" },
            ]}
          >
            {data.latestWarningAndErrorLogs.map((event) => (
              <tr
                key={`${event.traceId}:${event.spanId}:${DateTime.formatIso(event.seenAt)}:${event.message}`}
                className="hover:surface-ghost-hover"
              >
                <td className="py-3 pr-3 pl-4 align-top font-mono tabular-nums whitespace-nowrap text-muted-foreground sm:pl-5">
                  <div>
                    <RelativeTimeNoWrap value={event.seenAt} />
                  </div>
                  <span className="mt-1 inline-flex rounded-badge bg-secondary px-1.5 py-0.5 text-caption uppercase text-foreground">
                    {event.level}
                  </span>
                </td>
                <td className="px-3 py-3 align-top">
                  <div className="truncate font-medium text-strong-foreground">
                    {event.spanName}
                  </div>
                  <div className="mt-0.5 text-dim-foreground">
                    <TraceIdCell traceId={event.traceId} />
                  </div>
                </td>
                <td className="py-3 pr-4 pl-3 align-top break-words text-muted-foreground sm:pr-5">
                  <ExpandableText
                    collapsedClassName="line-clamp-2"
                    expandLabel="Show full message"
                    text={event.message}
                  />
                </td>
              </tr>
            ))}
          </DiagnosticsTable>
        ) : (
          <EmptyRows
            label={isInitialLoading ? "Loading recent logs..." : "No warnings or errors found."}
          />
        )}
      </SettingsSection>

      <SettingsSection title="Top span names">
        {data && data.topSpansByCount.length > 0 ? (
          <DiagnosticsTable
            columns={[
              { label: "Span" },
              { label: "Count", width: "w-20", numeric: true },
              { label: "Failures", width: "w-20", numeric: true },
              { label: "Average", width: "w-20", numeric: true },
              { label: "Max", width: "w-22", numeric: true },
            ]}
          >
            {data.topSpansByCount.map((span) => (
              <tr key={span.name}>
                <td className="break-words py-3 pr-3 pl-4 align-top text-strong-foreground sm:pl-5">
                  <SpanName name={span.name} />
                </td>
                <td className="whitespace-nowrap px-3 py-3 text-right align-top font-mono tabular-nums">
                  {formatCount(span.count)}
                </td>
                <td className="whitespace-nowrap px-3 py-3 text-right align-top font-mono tabular-nums">
                  {formatCount(span.failureCount)}
                </td>
                <td className="whitespace-nowrap px-3 py-3 text-right align-top font-mono tabular-nums">
                  {formatDuration(span.averageDurationMs)}
                </td>
                <td className="whitespace-nowrap py-3 pr-4 pl-3 text-right align-top font-mono tabular-nums sm:pr-5">
                  {formatDuration(span.maxDurationMs)}
                </td>
              </tr>
            ))}
          </DiagnosticsTable>
        ) : (
          <EmptyRows label={isInitialLoading ? "Loading span names..." : "No spans found."} />
        )}
      </SettingsSection>
      <ResourceTelemetryDiagnostics environmentId={environmentId} />

      <SettingsSection
        title="Resource history"
        headerAction={
          <div className="flex items-center gap-1.5">
            <ResourceHistoryWindowSelector
              selectedWindowMs={resourceWindowMs}
              onSelect={setResourceWindowMs}
            />
            <DiagnosticsLastChecked checkedAt={resourceData?.readAt ?? null} />
            <DiagnosticsRefreshButton
              isPending={isResourcePending}
              label="Refresh resource history"
              onClick={refreshResources}
            />
          </div>
        }
      >
        <StatsGrid>
          <StatBlock
            label="CPU Time"
            value={
              resourceTotalsUnavailable
                ? UNAVAILABLE_VALUE
                : resourceData
                  ? formatCpuTime(resourceData.totalCpuSecondsApprox)
                  : "..."
            }
            tooltip="Approximate active CPU time for the T3 server root process and its descendants during the selected window. It grows only while sampled processes use CPU and older samples leave as the window moves."
          />
          <StatBlock
            label="Samples"
            value={resourceData ? formatCount(resourceData.retainedSampleCount) : "..."}
            tooltip="In-memory process samples retained by the server. The server samples only while diagnostics is open, and this resets when the server restarts."
          />
          <StatBlock
            label="Interval"
            value={
              resourceData
                ? resourceData.sampleIntervalMs === 0
                  ? "On demand"
                  : formatDuration(resourceData.sampleIntervalMs)
                : "..."
            }
          />
          <StatBlock
            label="Processes"
            value={
              resourceTotalsUnavailable
                ? UNAVAILABLE_VALUE
                : resourceData
                  ? formatCount(resourceData.topProcesses.length)
                  : "..."
            }
          />
        </StatsGrid>
        {resourceNote ? (
          <div className="border-t border-border/60">
            {/* Live processes already states this reason; do not repeat it. */}
            {resourceNote === processNote ? (
              <EmptyRows label="Unavailable" />
            ) : (
              <SettingsNote icon={<CircleSlashIcon className="text-dim-foreground" />}>
                {resourceNote}
              </SettingsNote>
            )}
          </div>
        ) : null}
        {resourceTotalsUnavailable ? null : (
          <>
            {resourceData && resourceData.topProcesses.length > 0 ? (
              <ProcessResourceHistoryChart buckets={resourceData.buckets} />
            ) : null}
            <ProcessResourceHistoryTable
              processes={resourceData?.topProcesses ?? []}
              emptyLabel={
                isResourceInitialLoading
                  ? "Collecting process resource samples..."
                  : "No process resource samples found for this window."
              }
            />
          </>
        )}
      </SettingsSection>
      {exportFormEnvironmentId === environmentId && <TelemetryExportSettings />}
    </SettingsPageContainer>
  );
}
