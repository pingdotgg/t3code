import { thrownErrorMessage } from "@t3tools/client-runtime/errors";
import { m as resolveMessage } from "~/i18n/messages";
import { ProcessSignalActions } from "./ProcessSignalActions";
import { resolveUsageAccess } from "@t3tools/client-runtime/state/usage-access";
import { environmentSession } from "../../state/session";
import { AuthOrchestrationOperateScope } from "@t3tools/contracts";
import { readEnvironmentScope, useEnvironmentScope } from "../../state/session";
import { AuthEnvironmentMaintainScope } from "@t3tools/contracts";
import { RefreshIcon } from "~/components/ui/refresh-icon";
import {
  AlertTriangleIcon,
  CopyIcon,
  FolderOpenIcon,
  InfoIcon,
  ChevronDownIcon,
  ChevronRightIcon,
} from "lucide-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { useRef, useState, type ReactNode } from "react";
import { msg, T, useGT, useMessages, Var } from "gt-react";
import type { MessageResolver } from "../../i18n/messages";
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
import { ScrollArea } from "../ui/scroll-area";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { toastManager } from "../ui/toast";
import { formatDiagnosticsDuration } from "./DiagnosticsSettings.logic";
import { ExpandableText } from "./ExpandableText";
import { MachineResourcesSection } from "./MachineResourcesSection";
import { ResourceTelemetryDiagnostics } from "./ResourceTelemetryDiagnostics";
import { formatCpuTime } from "./ResourceTelemetryDiagnostics.logic";
import { SettingsPageContainer, SettingsSection } from "./settingsLayout";
import { useAtomCommand } from "../../state/use-atom-command";
import { useSettingsScope } from "./SettingsScopeContext";
import { TelemetryExportSettings } from "./TelemetryExportSettings";

const NUMBER_FORMAT = new Intl.NumberFormat();

function formatCount(value: number): string {
  return NUMBER_FORMAT.format(value);
}

function RelativeTimeNoWrap(props: { value: DateTime.Utc }) {
  const relative = useRelativeTimeState(DateTime.formatIso(props.value));
  if (relative.status !== "relative") return null;
  return relative.label.replaceAll(" ", "\u00a0");
}

function shortenTraceId(traceId: string): string {
  if (traceId.length <= 32) return traceId;
  return `${traceId.slice(0, 18)}...${traceId.slice(-10)}`;
}

function isStaleProcessSignalMessage(message: string | undefined): boolean {
  return message?.includes("not a live descendant") ?? false;
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
      <div className="flex min-w-0 items-center gap-1.5 text-2xs font-medium uppercase tracking-widest text-muted-foreground/70">
        <span className="min-w-0 truncate">{label}</span>
        {tooltip ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  className="cursor-pointer inline-flex size-3.5 shrink-0 items-center justify-center rounded-sm text-muted-foreground/60 hover:text-foreground"
                  aria-label={`${label} details`}
                >
                  <InfoIcon className="size-3" />
                </button>
              }
            />
            <TooltipPopup side="top">{tooltip}</TooltipPopup>
          </Tooltip>
        ) : null}
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

function EmptyRows({ label }: { label: string }) {
  return <div className="px-4 py-4 text-xs text-muted-foreground sm:px-5">{label}</div>;
}

function DiagnosticsTable({
  headers,
  children,
  minTableWidth = "min-w-[640px]",
  columnWidths,
}: {
  headers: ReadonlyArray<string>;
  children: ReactNode;
  minTableWidth?: string;
  columnWidths?: ReadonlyArray<string>;
}) {
  return (
    <ScrollArea
      radius="none"
      chainVerticalScroll
      scrollFade
      hideScrollbars
      className="w-full max-w-full"
    >
      <table
        className={cn("w-full text-left text-xs", minTableWidth, columnWidths && "table-fixed")}
      >
        {columnWidths ? (
          <colgroup>
            {headers.map((header, index) => (
              <col key={header} className={columnWidths[index]} />
            ))}
          </colgroup>
        ) : null}
        <thead className="border-b border-border/60 text-2xs uppercase tracking-widest text-muted-foreground/70">
          <tr>
            {headers.map((header, index) => (
              <th
                key={header}
                className={cn(
                  "whitespace-nowrap px-4 py-2.5 font-semibold first:sm:pl-5 last:sm:pr-5",
                  !columnWidths && index === headers.length - 1 && "w-px",
                )}
              >
                {header.replaceAll(" ", "\u00a0")}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-border/60">{children}</tbody>
      </table>
    </ScrollArea>
  );
}

function TraceIdCell({ traceId }: { traceId: string }) {
  const gt = useGT();
  const { copyToClipboard, isCopied: copied } = useCopyToClipboard({
    target: {
      target: "trace ID",
      unavailableMessage: msg("Clipboard API is unavailable while copying trace ID."),
      failureMessage: msg("Failed to copy trace ID to the clipboard."),
    },
    timeout: 1_200,
  });

  return (
    <div className="flex w-full min-w-0 max-w-full items-center gap-2">
      <Tooltip>
        <TooltipTrigger
          render={
            <span className="min-w-0 flex-1 truncate font-mono text-2xs">
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
              aria-label={copied ? gt("Copied trace ID") : gt("Copy trace ID")}
              onClick={() => copyToClipboard(traceId)}
            >
              <CopyIcon className="size-3" />
            </Button>
          }
        />
        <TooltipPopup side="top">{copied ? gt("Copied") : gt("Copy full trace ID")}</TooltipPopup>
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

function formatProcessType(
  process: ServerProcessDiagnosticsEntry,
  resolve: MessageResolver,
): string {
  if (process.depth > 0) return resolve(msg("Subprocess"));
  if (/\b(codex|claude|opencode|cursor)\b/i.test(process.command))
    return resolve(msg("Agent", { $context: "process type" }));
  return resolve(msg("Process", { $context: "process type" }));
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
  const gt = useGT();
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
          aria-label={isExpanded ? gt("Collapse {name}", { name }) : gt("Expand {name}", { name })}
          onClick={() => onToggle(process.pid)}
        >
          {isExpanded ? (
            <ChevronDownIcon className="size-3.5" />
          ) : (
            <ChevronRightIcon className="size-3.5" />
          )}
        </Button>
      ) : (
        <span className="size-5 shrink-0" aria-hidden="true" />
      )}
      <span className="size-1.5 shrink-0 rounded-full bg-success/80" />
      <Tooltip>
        <TooltipTrigger
          render={<span className="min-w-0 truncate font-medium text-foreground">{name}</span>}
        />
        <TooltipPopup side="top" variant="code">
          {process.command}
        </TooltipPopup>
      </Tooltip>
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
  const gt = useGT();
  const m = useMessages();
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
        <table className="w-full min-w-[1040px] table-fixed text-left text-xs">
          <colgroup>
            <col className="w-[24%]" />
            <col className="w-[8%]" />
            <col className="w-[10%]" />
            <col className="w-[33%]" />
            <col className="w-[8%]" />
            <col className="w-[11%]" />
            <col className="w-[6%]" />
          </colgroup>
          <thead className="sticky top-0 z-10 border-b border-border/60 bg-card text-2xs uppercase tracking-widest text-muted-foreground/70">
            <tr>
              <th className="px-4 py-2 font-semibold sm:pl-5">
                <T>Name</T>
              </th>
              <th className="px-3 py-2 text-right font-semibold">
                <T>CPU</T>
              </th>
              <th className="px-3 py-2 text-right font-semibold">
                <T>Memory</T>
              </th>
              <th className="px-3 py-2 font-semibold">
                <T>Command</T>
              </th>
              <th className="px-3 py-2 text-right font-semibold">
                <T>PID</T>
              </th>
              <th className="px-3 py-2 font-semibold">
                <T>Type</T>
              </th>
              <th className="p-2 text-right font-semibold sm:pr-4">
                <T>Kill</T>
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border/50">
            {visibleProcesses.length === 0 ? (
              <tr>
                <td colSpan={7} className="px-4 py-4 text-xs text-muted-foreground sm:px-5">
                  {emptyLabel ?? gt("No live descendant processes found.")}
                </td>
              </tr>
            ) : null}
            {visibleProcesses.map((process) => (
              <tr key={process.pid} className="hover:bg-muted/20">
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
                <td className="px-3 py-2 align-middle text-muted-foreground">
                  <Tooltip>
                    <TooltipTrigger
                      render={<span className="block truncate">{process.command}</span>}
                    />
                    <TooltipPopup side="top" variant="code">
                      {process.command}
                    </TooltipPopup>
                  </Tooltip>
                </td>
                <td className="px-3 py-2 text-right align-middle font-mono tabular-nums text-muted-foreground">
                  {process.pid}
                </td>
                <td className="truncate px-3 py-2 align-middle text-muted-foreground">
                  {formatProcessType(process, m)}
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
  const gt = useGT();
  const name = formatShortProcessName(process.command);

  return (
    <div
      className="grid min-w-0 grid-cols-[1.25rem_0.375rem_minmax(0,1fr)] items-center gap-2"
      style={{ paddingLeft: `${Math.min(visualDepth, 6) * 10}px` }}
      aria-label={
        process.isServerRoot
          ? gt("Root process {name}", { name })
          : gt("Child process {name}", { name })
      }
    >
      <span className="size-5 shrink-0" aria-hidden="true" />
      <span
        className={cn(
          "size-1.5 shrink-0 rounded-full",
          process.isServerRoot ? "bg-warning/90" : "bg-success/80",
        )}
      />
      <Tooltip>
        <TooltipTrigger
          render={<span className="min-w-0 truncate font-medium text-foreground">{name}</span>}
        />
        <TooltipPopup side="top" variant="code">
          {process.command}
        </TooltipPopup>
      </Tooltip>
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
  const gt = useGT();
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
                      aria-label={gt("Average CPU {average}%, peak CPU {peak}%", {
                        average: bucket.avgCpuPercent.toFixed(1),
                        peak: bucket.maxCpuPercent.toFixed(1),
                      })}
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
                {gt("Avg {average}%, peak {peak}%", {
                  average: bucket.avgCpuPercent.toFixed(1),
                  peak: bucket.maxCpuPercent.toFixed(1),
                })}
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
  const gt = useGT();
  return (
    <ToggleGroup
      aria-label={gt("Process history period")}
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
  const m = useMessages();
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
        <table className="w-full min-w-[980px] table-fixed text-left text-xs">
          <colgroup>
            <col className="w-[24%]" />
            <col className="w-[10%]" />
            <col className="w-[10%]" />
            <col className="w-[10%]" />
            <col className="w-[10%]" />
            <col className="w-[10%]" />
            <col className="w-[16%]" />
            <col className="w-[10%]" />
          </colgroup>
          <thead className="sticky top-0 z-10 border-b border-border/60 bg-card text-2xs uppercase tracking-widest text-muted-foreground/70">
            <tr>
              <th className="px-4 py-2 font-semibold sm:pl-5">
                <T>Process</T>
              </th>
              <th className="px-3 py-2 text-right font-semibold">
                <T>CPU Time</T>
              </th>
              <th className="px-3 py-2 text-right font-semibold">
                <T>Current</T>
              </th>
              <th className="px-3 py-2 text-right font-semibold">
                <T>Average</T>
              </th>
              <th className="px-3 py-2 text-right font-semibold">
                <T>Peak</T>
              </th>
              <th className="px-3 py-2 text-right font-semibold">
                <T>Max Mem</T>
              </th>
              <th className="px-3 py-2 font-semibold">
                <T>Command</T>
              </th>
              <th className="px-3 py-2 text-right font-semibold sm:pr-5">
                <T>PID</T>
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border/50">
            {processes.length === 0 ? (
              <tr>
                <td colSpan={8} className="px-4 py-4 text-xs text-muted-foreground sm:px-5">
                  {emptyLabel}
                </td>
              </tr>
            ) : null}
            {processes.map((process) => (
              <tr key={process.processKey} className="hover:bg-muted/20">
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
                  {formatCpuTime(process.cpuSecondsApprox, m)}
                </td>
                <td className="px-3 py-2 text-right align-middle font-mono tabular-nums">
                  {process.currentCpuPercent.toFixed(1)}%
                </td>
                <td className="px-3 py-2 text-right align-middle font-mono tabular-nums">
                  {process.avgCpuPercent.toFixed(1)}%
                </td>
                <td className="px-3 py-2 text-right align-middle font-mono tabular-nums">
                  {process.maxCpuPercent.toFixed(1)}%
                </td>
                <td className="px-3 py-2 text-right align-middle font-mono tabular-nums">
                  {formatBytes(process.maxRssBytes)}
                </td>
                <td className="px-3 py-2 align-middle text-muted-foreground">
                  <Tooltip>
                    <TooltipTrigger
                      render={<span className="block truncate">{process.command}</span>}
                    />
                    <TooltipPopup side="top" variant="code">
                      {process.command}
                    </TooltipPopup>
                  </Tooltip>
                </td>
                <td className="px-3 py-2 text-right align-middle font-mono tabular-nums text-muted-foreground sm:pr-5">
                  {process.pid}
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
  const gt = useGT();
  const relative = useRelativeTimeState(checkedAt ? DateTime.formatIso(checkedAt) : null);

  if (relative.status === "missing") {
    return (
      <span className="text-2xs text-muted-foreground/50">
        <T>Checking</T>
      </span>
    );
  }

  if (relative.status === "invalid") {
    return (
      <span className="text-2xs text-muted-foreground/50">
        <T>Checked unavailable</T>
      </span>
    );
  }

  return (
    <span className="text-2xs text-muted-foreground/60">
      {relative.suffix ? (
        <T context="the time is an elapsed time such as 5m">
          Checked{" "}
          <span className="font-mono tabular-nums">
            <Var>{relative.value}</Var>
          </span>{" "}
          ago
        </T>
      ) : (
        gt("Checked {time}", { time: relative.value })
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
  const gt = useGT();
  const m = useMessages();
  const { environment } = useSettingsScope();
  const environmentId = environment?.environmentId ?? null;
  const canMaintainEnvironment = useEnvironmentScope(environmentId, AuthEnvironmentMaintainScope);
  const observability = environment?.serverConfig?.observability;
  const availableEditors = environment?.serverConfig?.availableEditors;
  const canOpenHostEditor = useEnvironmentScope(environmentId, AuthOrchestrationOperateScope);
  const session = useEnvironmentQuery(
    environmentId === null ? null : environmentSession.sessionStateAtom(environmentId),
    m,
  );
  const diagnosticsAccess = resolveUsageAccess(
    {
      connectionPhase: environment?.connection.phase ?? "available",
      session: session.data,
      hasSessionError: session.error !== null,
    },
    m,
  );
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
    m,
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
    m,
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
    m,
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
          error instanceof Error
            ? (thrownErrorMessage(error, resolveMessage) ?? error.message)
            : gt("Unable to open logs folder."),
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
          gt("Send SIGKILL to process {pid}? This cannot be handled by the process.", { pid }),
          { variant: "destructive" },
        );
      } catch (error) {
        clearSignaling();
        toastManager.add({
          type: "error",
          title: gt("Could not confirm signal"),
          description:
            error instanceof Error
              ? (thrownErrorMessage(error, resolveMessage) ?? error.message)
              : gt("Failed to send {signal}.", { signal }),
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
          title: gt("Could not send {signal}", { signal }),
          description:
            error instanceof Error
              ? (thrownErrorMessage(error, resolveMessage) ?? error.message)
              : gt("Failed to send {signal}.", { signal }),
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
          title: gt("Process already exited"),
          description: gt(
            "The process is not a child of the T3 Server. It might already have exited.",
          ),
        });
        return;
      }

      toastManager.add({
        type: "error",
        title: gt("Could not send {signal}", { signal }),
        description: message ?? gt("Failed to send {signal}.", { signal }),
      });
      return;
    }
    refreshProcesses();
  };

  const processDiagnosticsError = processData ? Option.getOrNull(processData.error) : null;
  const processResourceError = resourceData ? Option.getOrNull(resourceData.error) : null;
  const traceDiagnosticsError = data ? Option.getOrNull(data.error) : null;
  const traceDiagnosticsPartialFailure = data
    ? Option.getOrElse(data.partialFailure, () => false)
    : false;

  if (!canReadDiagnostics) {
    return (
      <SettingsPageContainer>
        <p className="text-sm text-muted-foreground">
          {environmentId === null
            ? gt("Connect an environment to see diagnostics.")
            : diagnosticsAccess.isPending
              ? gt("Checking diagnostics access…")
              : diagnosticsAccess.error}
        </p>
      </SettingsPageContainer>
    );
  }

  return (
    <SettingsPageContainer width="expanded" className="gap-10">
      {environmentId === null ? null : <MachineResourcesSection environmentId={environmentId} />}
      <ResourceTelemetryDiagnostics environmentId={environmentId} />

      <SettingsSection
        title={gt("Live Processes")}
        headerAction={
          <div className="flex items-center gap-1.5">
            <DiagnosticsLastChecked checkedAt={processData?.readAt ?? null} />
            <DiagnosticsRefreshButton
              isPending={isProcessPending}
              label={gt("Refresh process diagnostics")}
              onClick={refreshProcesses}
            />
          </div>
        }
      >
        <StatsGrid>
          <StatBlock
            label={gt("Child Processes")}
            value={processData ? formatCount(processData.processCount) : "..."}
          />
          <StatBlock
            label={gt("CPU")}
            value={processData ? `${processData.totalCpuPercent.toFixed(1)}%` : "..."}
            tooltip={gt(
              "Total CPU across live child processes of the current server process. The desktop shell and other parent processes are not included.",
            )}
          />
          <StatBlock
            label={gt("Memory")}
            value={processData ? formatBytes(processData.totalRssBytes) : "..."}
            tooltip={gt(
              "Total resident memory across live child processes of the current server process. The desktop shell and other parent processes are not included.",
            )}
          />
          <StatBlock
            label={gt("Server PID")}
            value={processData ? String(processData.serverPid) : "..."}
          />
        </StatsGrid>
        {processDiagnosticsError || processError ? (
          <div className="space-y-2 border-t border-border/60 px-4 py-3 text-xs text-muted-foreground sm:px-5">
            {processDiagnosticsError ? (
              <div className="flex items-start gap-2 text-destructive">
                <AlertTriangleIcon className="size-3.5 h-lh shrink-0" />
                <span>{processDiagnosticsError.message}</span>
              </div>
            ) : null}
            {processError ? (
              <div className="flex items-start gap-2 text-destructive">
                <AlertTriangleIcon className="size-3.5 h-lh shrink-0" />
                <span>{processError}</span>
              </div>
            ) : null}
          </div>
        ) : null}
        <ProcessDiagnosticsTable
          processes={processData?.processes ?? []}
          canMaintainEnvironment={canMaintainEnvironment}
          signalingPid={signalingPid}
          onSignal={signalProcess}
          emptyLabel={
            isProcessInitialLoading
              ? gt("Loading live processes...")
              : gt("No live descendant processes found.")
          }
        />
      </SettingsSection>

      <SettingsSection
        title={gt("Resource History")}
        headerAction={
          <div className="flex items-center gap-1.5">
            <ResourceHistoryWindowSelector
              selectedWindowMs={resourceWindowMs}
              onSelect={setResourceWindowMs}
            />
            <DiagnosticsLastChecked checkedAt={resourceData?.readAt ?? null} />
            <DiagnosticsRefreshButton
              isPending={isResourcePending}
              label={gt("Refresh resource history")}
              onClick={refreshResources}
            />
          </div>
        }
      >
        <StatsGrid>
          <StatBlock
            label={gt("CPU Time")}
            value={resourceData ? formatCpuTime(resourceData.totalCpuSecondsApprox, m) : "..."}
            tooltip={gt(
              "Approximate active CPU time for the T3 server root process and its descendants during the selected window. It grows only while sampled processes use CPU and older samples leave as the window moves.",
            )}
          />
          <StatBlock
            label={gt("Samples")}
            value={resourceData ? formatCount(resourceData.retainedSampleCount) : "..."}
            tooltip={gt(
              "In-memory process samples retained by the server. The server samples only while diagnostics is open, and this resets when the server restarts.",
            )}
          />
          <StatBlock
            label={gt("Interval")}
            value={
              resourceData
                ? resourceData.sampleIntervalMs === 0
                  ? gt("On demand")
                  : formatDiagnosticsDuration(resourceData.sampleIntervalMs)
                : "..."
            }
          />
          <StatBlock
            label={gt("Processes")}
            value={resourceData ? formatCount(resourceData.topProcesses.length) : "..."}
          />
        </StatsGrid>
        {processResourceError || resourceError ? (
          <div className="space-y-2 border-t border-border/60 px-4 py-3 text-xs text-muted-foreground sm:px-5">
            {processResourceError ? (
              <div className="flex items-start gap-2 text-destructive">
                <AlertTriangleIcon className="size-3.5 h-lh shrink-0" />
                <span>{processResourceError.message}</span>
              </div>
            ) : null}
            {resourceError ? (
              <div className="flex items-start gap-2 text-destructive">
                <AlertTriangleIcon className="size-3.5 h-lh shrink-0" />
                <span>{resourceError}</span>
              </div>
            ) : null}
          </div>
        ) : null}
        <ProcessResourceHistoryChart buckets={resourceData?.buckets ?? []} />
        <ProcessResourceHistoryTable
          processes={resourceData?.topProcesses ?? []}
          emptyLabel={
            isResourceInitialLoading
              ? gt("Collecting process resource samples...")
              : gt("No process resource samples found for this window.")
          }
        />
      </SettingsSection>

      <SettingsSection
        title={gt("Trace Diagnostics")}
        headerAction={
          <div className="flex items-center gap-1.5">
            <DiagnosticsLastChecked checkedAt={data?.readAt ?? null} />
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    size="icon-xs"
                    variant="ghost-muted"
                    disabled={
                      !canOpenHostEditor ||
                      !observability?.logsDirectoryPath ||
                      isOpeningLogsDirectory
                    }
                    onClick={openLogsDirectory}
                    aria-label={gt("Open logs folder")}
                  >
                    <FolderOpenIcon />
                  </Button>
                }
              />
              <TooltipPopup side="top">
                <T>Open logs folder</T>
              </TooltipPopup>
            </Tooltip>
            <DiagnosticsRefreshButton
              isPending={isPending}
              label={gt("Refresh trace diagnostics")}
              onClick={refresh}
            />
          </div>
        }
      >
        <StatsGrid>
          <StatBlock label={gt("Spans")} value={data ? formatCount(data.recordCount) : "..."} />
          <StatBlock
            label={gt("Failures")}
            value={data ? formatCount(data.failureCount) : "..."}
            tone={data && data.failureCount > 0 ? "danger" : "default"}
          />
          <StatBlock
            label={gt("Slow Spans")}
            value={data ? formatCount(data.slowSpanCount) : "..."}
            tooltip={
              data
                ? gt("Spans with a duration of {duration} or longer.", {
                    duration: formatDiagnosticsDuration(data.slowSpanThresholdMs),
                  })
                : gt("Spans at or above the configured slow-span threshold.")
            }
            tone={data && data.slowSpanCount > 0 ? "warning" : "default"}
          />
          <StatBlock
            label={gt("Parse Errors")}
            value={data ? formatCount(data.parseErrorCount) : "..."}
            tone={data && data.parseErrorCount > 0 ? "warning" : "default"}
          />
        </StatsGrid>
        {openLogsDirectoryError || traceDiagnosticsError || error ? (
          <div className="space-y-2 border-t border-border/60 px-4 py-3 text-xs text-muted-foreground sm:px-5">
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
                    ? gt(
                        "Some trace files could not be read, so diagnostics may be incomplete. {message}",
                        { message: traceDiagnosticsError.message },
                      )
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

      <SettingsSection title={gt("Latest Failures")}>
        {data && data.latestFailures.length > 0 ? (
          <DiagnosticsTable headers={[gt("Span"), gt("Cause"), gt("Duration"), gt("Ended")]}>
            {data.latestFailures.map((failure) => (
              <tr key={`${failure.traceId}:${failure.spanId}`}>
                <td className="px-4 py-3 align-top text-xs font-medium text-foreground first:sm:pl-5">
                  {failure.name}
                </td>
                <td className="max-w-[360px] px-4 py-3 align-top text-muted-foreground">
                  <ExpandableText text={failure.cause} />
                </td>
                <td className="px-4 py-3 align-top font-mono tabular-nums">
                  {formatDiagnosticsDuration(failure.durationMs)}
                </td>
                <td className="whitespace-nowrap px-4 py-3 align-top font-mono tabular-nums text-muted-foreground last:sm:pr-5">
                  <RelativeTimeNoWrap value={failure.endedAt} />
                </td>
              </tr>
            ))}
          </DiagnosticsTable>
        ) : (
          <EmptyRows
            label={isInitialLoading ? gt("Loading failures...") : gt("No failed spans found.")}
          />
        )}
      </SettingsSection>

      <SettingsSection title={gt("Most Common Failures")}>
        {data && data.commonFailures.length > 0 ? (
          <DiagnosticsTable
            headers={[gt("Span"), gt("Count"), gt("Cause"), gt("Last Seen")]}
            minTableWidth="min-w-[760px]"
          >
            {data.commonFailures.map((failure) => (
              <tr key={`${failure.name}:${failure.cause}`}>
                <td className="px-4 py-3 align-top text-xs font-medium text-foreground first:sm:pl-5">
                  {failure.name}
                </td>
                <td className="px-4 py-3 align-top font-mono tabular-nums">
                  {formatCount(failure.count)}
                </td>
                <td className="max-w-[360px] px-4 py-3 align-top text-muted-foreground">
                  <ExpandableText text={failure.cause} />
                </td>
                <td className="w-px whitespace-nowrap px-4 py-3 align-top font-mono tabular-nums text-muted-foreground last:sm:pr-5">
                  <RelativeTimeNoWrap value={failure.lastSeenAt} />
                </td>
              </tr>
            ))}
          </DiagnosticsTable>
        ) : (
          <EmptyRows
            label={
              isInitialLoading ? gt("Loading failure groups...") : gt("No repeated failures found.")
            }
          />
        )}
      </SettingsSection>

      <SettingsSection title={gt("Slowest Spans")}>
        {data && data.slowestSpans.length > 0 ? (
          <DiagnosticsTable
            headers={[gt("Span"), gt("Duration"), gt("Ended"), gt("Trace")]}
            minTableWidth="min-w-[900px]"
            columnWidths={["w-[44%]", "w-[14%]", "w-[12%]", "w-[30%]"]}
          >
            {data.slowestSpans.map((span) => (
              <tr key={`${span.traceId}:${span.spanId}`}>
                <td className="px-4 py-3 align-top text-xs font-medium text-foreground first:sm:pl-5">
                  {span.name}
                </td>
                <td className="px-4 py-3 align-top font-mono tabular-nums">
                  {formatDiagnosticsDuration(span.durationMs)}
                </td>
                <td className="w-px whitespace-nowrap px-4 py-3 align-top font-mono tabular-nums text-muted-foreground">
                  <RelativeTimeNoWrap value={span.endedAt} />
                </td>
                <td className="min-w-0 whitespace-nowrap px-4 py-3 align-top text-muted-foreground last:sm:pr-5">
                  <TraceIdCell traceId={span.traceId} />
                </td>
              </tr>
            ))}
          </DiagnosticsTable>
        ) : (
          <EmptyRows
            label={isInitialLoading ? gt("Loading slow spans...") : gt("No spans found.")}
          />
        )}
      </SettingsSection>

      <SettingsSection title={gt("Span Logs")}>
        {data && data.latestWarningAndErrorLogs.length > 0 ? (
          <ScrollArea
            radius="none"
            chainVerticalScroll
            scrollFade
            hideScrollbars
            className="w-full max-w-full"
          >
            <table className="w-full min-w-[920px] table-fixed text-left text-xs">
              <colgroup>
                <col className="w-[11%]" />
                <col className="w-[9%]" />
                <col className="w-[24%]" />
                <col className="w-[26%]" />
                <col className="w-[30%]" />
              </colgroup>
              <thead className="border-b border-border/60 text-2xs uppercase tracking-widest text-muted-foreground/70">
                <tr>
                  <th className="whitespace-nowrap px-4 py-2.5 font-semibold sm:pl-5">
                    <T>Time</T>
                  </th>
                  <th className="whitespace-nowrap px-4 py-2.5 font-semibold">
                    <T>Level</T>
                  </th>
                  <th className="whitespace-nowrap px-4 py-2.5 font-semibold">
                    <T>Span</T>
                  </th>
                  <th className="whitespace-nowrap px-4 py-2.5 font-semibold">
                    <T>Message</T>
                  </th>
                  <th className="whitespace-nowrap px-4 py-2.5 font-semibold sm:pr-5">
                    <T>Trace</T>
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/60">
                {data.latestWarningAndErrorLogs.map((event) => (
                  <tr
                    key={`${event.traceId}:${event.spanId}:${DateTime.formatIso(event.seenAt)}:${event.message}`}
                    className="hover:bg-muted/15"
                  >
                    <td className="whitespace-nowrap px-4 py-3 align-top font-mono tabular-nums text-muted-foreground sm:pl-5">
                      <RelativeTimeNoWrap value={event.seenAt} />
                    </td>
                    <td className="px-4 py-3 align-top">
                      <span className="inline-flex rounded bg-muted px-1.5 py-0.5 font-mono text-2xs font-medium uppercase text-foreground/80">
                        {event.level}
                      </span>
                    </td>
                    <td className="px-4 py-3 align-top">
                      <div className="truncate font-medium text-foreground">{event.spanName}</div>
                    </td>
                    <td className="px-4 py-3 align-top text-muted-foreground">
                      <ExpandableText
                        collapsedClassName="line-clamp-2"
                        expandLabel={gt("Show full message")}
                        text={event.message}
                      />
                    </td>
                    <td className="min-w-0 whitespace-nowrap px-4 py-3 align-top text-muted-foreground sm:pr-5">
                      <TraceIdCell traceId={event.traceId} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </ScrollArea>
        ) : (
          <EmptyRows
            label={
              isInitialLoading ? gt("Loading recent logs...") : gt("No warnings or errors found.")
            }
          />
        )}
      </SettingsSection>

      <SettingsSection title={gt("Top Span Names")}>
        {data && data.topSpansByCount.length > 0 ? (
          <DiagnosticsTable
            headers={[gt("Span"), gt("Count"), gt("Failures"), gt("Average"), gt("Max")]}
            minTableWidth="min-w-[760px]"
            columnWidths={["w-[48%]", "w-[13%]", "w-[13%]", "w-[13%]", "w-[13%]"]}
          >
            {data.topSpansByCount.map((span) => (
              <tr key={span.name}>
                <td className="px-4 py-3 align-top text-xs font-medium text-foreground first:sm:pl-5">
                  {span.name}
                </td>
                <td className="whitespace-nowrap px-4 py-3 align-top font-mono tabular-nums">
                  {formatCount(span.count)}
                </td>
                <td className="whitespace-nowrap px-4 py-3 align-top font-mono tabular-nums">
                  {formatCount(span.failureCount)}
                </td>
                <td className="whitespace-nowrap px-4 py-3 align-top font-mono tabular-nums">
                  {formatDiagnosticsDuration(span.averageDurationMs)}
                </td>
                <td className="whitespace-nowrap px-4 py-3 align-top font-mono tabular-nums last:sm:pr-5">
                  {formatDiagnosticsDuration(span.maxDurationMs)}
                </td>
              </tr>
            ))}
          </DiagnosticsTable>
        ) : (
          <EmptyRows
            label={isInitialLoading ? gt("Loading span names...") : gt("No spans found.")}
          />
        )}
      </SettingsSection>
      {exportFormEnvironmentId === environmentId && <TelemetryExportSettings />}
    </SettingsPageContainer>
  );
}
