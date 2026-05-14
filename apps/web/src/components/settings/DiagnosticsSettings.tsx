import {
  AlertTriangleIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  CopyIcon,
  FolderOpenIcon,
  InfoIcon,
  RefreshCwIcon,
} from "lucide-react";
import { useCallback, useMemo, useState, type ReactNode } from "react";
import type { ServerProcessDiagnosticsEntry, ServerProcessSignal } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";

import { ensureLocalApi } from "../../localApi";
import { cn } from "../../lib/utils";
import { resolveAndPersistPreferredEditor } from "../../editorPreferences";
import { formatRelativeTime } from "../../timestampFormat";
import { useServerAvailableEditors, useServerObservability } from "../../rpc/serverState";
import { useProcessDiagnostics } from "../../lib/processDiagnosticsState";
import { useTraceDiagnostics } from "../../lib/traceDiagnosticsState";
import { Button } from "../ui/button";
import { ScrollArea } from "../ui/scroll-area";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { toastManager } from "../ui/toast";
import { SettingsPageContainer, SettingsSection, useRelativeTimeTick } from "./settingsLayout";

const NUMBER_FORMAT = new Intl.NumberFormat();

function formatCount(value: number): string {
  return NUMBER_FORMAT.format(value);
}

function formatDuration(value: number): string {
  if (value < 1_000) return `${Math.round(value)} ms`;
  return `${(value / 1_000).toFixed(value >= 10_000 ? 1 : 2)} s`;
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  const units = ["KB", "MB", "GB"] as const;
  let unitIndex = -1;
  let next = value;
  do {
    next /= 1024;
    unitIndex += 1;
  } while (next >= 1024 && unitIndex < units.length - 1);
  return `${next.toFixed(next >= 10 ? 1 : 2)} ${units[unitIndex]}`;
}

function formatRelative(value: DateTime.Utc | null): string {
  if (!value) return "No trace records";
  const relative = formatRelativeTime(DateTime.formatIso(value));
  return relative.suffix ? `${relative.value} ${relative.suffix}` : relative.value;
}

function formatRelativeNoWrap(value: DateTime.Utc | null): string {
  return formatRelative(value).replaceAll(" ", "\u00a0");
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
      <div className="flex min-w-0 items-center gap-1.5 text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground/70">
        <span className="min-w-0 truncate">{label}</span>
        {tooltip ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  className="inline-flex size-3.5 shrink-0 items-center justify-center rounded-sm text-muted-foreground/60 hover:text-foreground"
                  aria-label={`${label} details`}
                >
                  <InfoIcon className="size-3" />
                </button>
              }
            />
            <TooltipPopup
              side="top"
              className="max-w-[min(300px,calc(100vw-2rem))] whitespace-normal text-left text-[11px] leading-relaxed text-wrap"
            >
              {tooltip}
            </TooltipPopup>
          </Tooltip>
        ) : null}
      </div>
      <div
        className={cn(
          "mt-1 truncate font-mono text-lg font-semibold tabular-nums text-foreground",
          tone === "warning" && "text-amber-600 dark:text-amber-400",
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

function ExpandableText({
  text,
  className,
  collapsedClassName = "line-clamp-3",
  expandLabel = "Show full error",
}: {
  text: string;
  className?: string;
  collapsedClassName?: string;
  expandLabel?: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const canExpand = text.length > 180 || text.includes("\n");

  return (
    <div className={cn("min-w-0", className)}>
      <div
        className={cn(
          "whitespace-pre-wrap break-words",
          !expanded && canExpand ? collapsedClassName : null,
        )}
      >
        {text}
      </div>
      {canExpand ? (
        <button
          type="button"
          className="mt-1 text-[11px] font-medium text-foreground/70 underline-offset-2 hover:text-foreground hover:underline"
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? "Show less" : expandLabel}
        </button>
      ) : null}
    </div>
  );
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
      chainVerticalScroll
      scrollFade
      hideScrollbars
      className="w-full max-w-full rounded-none"
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
        <thead className="border-b border-border/60 text-[11px] uppercase tracking-[0.08em] text-muted-foreground/70">
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
  const [copied, setCopied] = useState(false);
  const copyTraceId = useCallback(() => {
    void navigator.clipboard
      ?.writeText(traceId)
      .then(() => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1_200);
      })
      .catch(() => undefined);
  }, [traceId]);

  return (
    <div className="flex w-full min-w-0 max-w-full items-center gap-2">
      <Tooltip>
        <TooltipTrigger
          render={
            <span className="min-w-0 flex-1 truncate font-mono text-[11px]">
              {shortenTraceId(traceId)}
            </span>
          }
        />
        <TooltipPopup
          side="top"
          className="max-w-[min(520px,calc(100vw-2rem))] break-all font-mono text-[11px]"
        >
          {traceId}
        </TooltipPopup>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              className="inline-flex size-5 shrink-0 items-center justify-center rounded-sm text-muted-foreground hover:bg-accent hover:text-foreground"
              aria-label={copied ? "Copied trace ID" : "Copy trace ID"}
              onClick={copyTraceId}
            >
              <CopyIcon className="size-3" />
            </button>
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
  const ChevronIcon = isExpanded ? ChevronDownIcon : ChevronRightIcon;

  return (
    <div
      className="grid min-w-0 grid-cols-[1.25rem_0.375rem_minmax(0,1fr)] items-center gap-2"
      style={{ paddingLeft: `${Math.min(process.depth, 8) * 16}px` }}
    >
      {hasChildren ? (
        <button
          type="button"
          className="inline-flex size-5 items-center justify-center rounded-sm text-muted-foreground hover:bg-accent hover:text-foreground"
          aria-label={isExpanded ? `Collapse ${name}` : `Expand ${name}`}
          onClick={() => onToggle(process.pid)}
        >
          <ChevronIcon className="size-3.5" />
        </button>
      ) : (
        <span className="size-5 shrink-0" aria-hidden="true" />
      )}
      <span className="size-1.5 shrink-0 rounded-full bg-emerald-500/80" />
      <span className="min-w-0 truncate font-medium text-foreground">{name}</span>
    </div>
  );
}

function ProcessSignalActions({
  process,
  isSignaling,
  onSignal,
}: {
  process: ServerProcessDiagnosticsEntry;
  isSignaling: boolean;
  onSignal: (pid: number, signal: ServerProcessSignal) => void;
}) {
  return (
    <div className="flex items-center justify-end gap-1.5">
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              disabled={isSignaling}
              className="text-[11px] font-medium text-muted-foreground underline-offset-2 hover:text-foreground hover:underline disabled:pointer-events-none disabled:opacity-50"
              onClick={() => onSignal(process.pid, "SIGINT")}
            >
              INT
            </button>
          }
        />
        <TooltipPopup side="top">Send SIGINT</TooltipPopup>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              disabled={isSignaling}
              className="text-[11px] font-medium text-destructive underline-offset-2 hover:underline disabled:pointer-events-none disabled:opacity-50"
              onClick={() => onSignal(process.pid, "SIGKILL")}
            >
              KILL
            </button>
          }
        />
        <TooltipPopup side="top">Send SIGKILL</TooltipPopup>
      </Tooltip>
    </div>
  );
}

function ProcessDiagnosticsTable({
  processes,
  signalingPid,
  onSignal,
  emptyLabel,
}: {
  processes: ReadonlyArray<ServerProcessDiagnosticsEntry>;
  signalingPid: number | null;
  onSignal: (pid: number, signal: ServerProcessSignal) => void;
  emptyLabel?: string;
}) {
  const [collapsedPids, setCollapsedPids] = useState<ReadonlySet<number>>(() => new Set());
  const visibleProcesses = useMemo(() => {
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
  }, [collapsedPids, processes]);

  const toggleProcess = useCallback((pid: number) => {
    setCollapsedPids((previous) => {
      const next = new Set(previous);
      if (next.has(pid)) {
        next.delete(pid);
      } else {
        next.add(pid);
      }
      return next;
    });
  }, []);

  return (
    <ScrollArea
      chainVerticalScroll
      scrollFade
      hideScrollbars
      className="w-full max-w-full rounded-none border-t border-border/60"
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
        <thead className="border-b border-border/60 bg-muted/15 text-[11px] uppercase tracking-[0.08em] text-muted-foreground/70">
          <tr>
            <th className="px-4 py-2 font-semibold sm:pl-5">Name</th>
            <th className="px-3 py-2 text-right font-semibold">CPU</th>
            <th className="px-3 py-2 text-right font-semibold">Memory</th>
            <th className="px-3 py-2 font-semibold">Command</th>
            <th className="px-3 py-2 text-right font-semibold">PID</th>
            <th className="px-3 py-2 font-semibold">Type</th>
            <th className="px-2 py-2 text-right font-semibold sm:pr-4">Kill</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border/50">
          {visibleProcesses.length === 0 ? (
            <tr>
              <td colSpan={7} className="px-4 py-4 text-xs text-muted-foreground sm:px-5">
                {emptyLabel ?? "No live descendant processes found."}
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
                  <TooltipPopup
                    side="top"
                    className="max-w-[min(440px,calc(100vw-2rem))] whitespace-normal break-words text-left font-mono text-[11px] leading-relaxed text-wrap"
                  >
                    {process.command}
                  </TooltipPopup>
                </Tooltip>
              </td>
              <td className="px-3 py-2 text-right align-middle font-mono tabular-nums text-muted-foreground">
                {process.pid}
              </td>
              <td className="truncate px-3 py-2 align-middle text-muted-foreground">
                {formatProcessType(process)}
              </td>
              <td className="px-2 py-2 align-middle sm:pr-4">
                <ProcessSignalActions
                  process={process}
                  isSignaling={signalingPid === process.pid}
                  onSignal={onSignal}
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </ScrollArea>
  );
}

function DiagnosticsLastChecked({ checkedAt }: { checkedAt: DateTime.Utc | null }) {
  useRelativeTimeTick();
  const relative = checkedAt ? formatRelativeTime(DateTime.formatIso(checkedAt)) : null;

  if (!relative) {
    return <span className="text-[11px] text-muted-foreground/50">Checking</span>;
  }

  return (
    <span className="text-[11px] text-muted-foreground/60">
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
            variant="ghost"
            className="size-5 rounded-sm p-0 text-muted-foreground hover:text-foreground"
            disabled={isPending}
            onClick={onClick}
            aria-label={label}
          >
            <RefreshCwIcon className={cn("size-3", isPending && "animate-spin")} />
          </Button>
        }
      />
      <TooltipPopup side="top">{label}</TooltipPopup>
    </Tooltip>
  );
}

export function DiagnosticsSettingsPanel() {
  const observability = useServerObservability();
  const availableEditors = useServerAvailableEditors();
  const { data, error, isPending, refresh } = useTraceDiagnostics();
  const {
    data: processData,
    error: processError,
    isPending: isProcessPending,
    refresh: refreshProcesses,
  } = useProcessDiagnostics();
  const [isOpeningLogsDirectory, setIsOpeningLogsDirectory] = useState(false);
  const [openLogsDirectoryError, setOpenLogsDirectoryError] = useState<string | null>(null);
  const [signalingPid, setSignalingPid] = useState<number | null>(null);

  const openLogsDirectory = useCallback(() => {
    const logsDirectoryPath = observability?.logsDirectoryPath ?? null;
    if (!logsDirectoryPath) return;

    const editor = resolveAndPersistPreferredEditor(availableEditors ?? []);
    if (!editor) {
      setOpenLogsDirectoryError("No available editors found.");
      return;
    }

    setIsOpeningLogsDirectory(true);
    setOpenLogsDirectoryError(null);
    void ensureLocalApi()
      .shell.openInEditor(logsDirectoryPath, editor)
      .catch((error: unknown) => {
        setOpenLogsDirectoryError(
          error instanceof Error ? error.message : "Unable to open logs folder.",
        );
      })
      .finally(() => {
        setIsOpeningLogsDirectory(false);
      });
  }, [availableEditors, observability?.logsDirectoryPath]);

  const isInitialLoading = isPending && data === null;
  const isProcessInitialLoading = isProcessPending && processData === null;
  const signalProcess = useCallback(
    (pid: number, signal: ServerProcessSignal) => {
      if (
        signal === "SIGKILL" &&
        !window.confirm(`Send SIGKILL to process ${pid}? This cannot be handled by the process.`)
      ) {
        return;
      }

      setSignalingPid(pid);
      void ensureLocalApi()
        .server.signalProcess({ pid, signal })
        .then((result) => {
          if (!result.signaled) {
            const message = Option.getOrUndefined(result.message);
            refreshProcesses();
            if (isStaleProcessSignalMessage(message)) {
              toastManager.add({
                type: "info",
                title: "Process already exited",
                description:
                  "The process is not a child of the T3 Server. It might already have exited.",
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
        })
        .catch((error: unknown) => {
          toastManager.add({
            type: "error",
            title: `Could not send ${signal}`,
            description: error instanceof Error ? error.message : `Failed to send ${signal}.`,
          });
        })
        .finally(() => {
          setSignalingPid(null);
        });
    },
    [refreshProcesses],
  );

  const processDiagnosticsError = processData ? Option.getOrNull(processData.error) : null;
  const traceDiagnosticsError = data ? Option.getOrNull(data.error) : null;
  const traceDiagnosticsPartialFailure = data
    ? Option.getOrElse(data.partialFailure, () => false)
    : false;

  return (
    <SettingsPageContainer>
      <SettingsSection
        title="Live Processes"
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
        <StatsGrid>
          <StatBlock
            label="Child Processes"
            value={processData ? formatCount(processData.processCount) : "..."}
          />
          <StatBlock
            label="CPU"
            value={processData ? `${processData.totalCpuPercent.toFixed(1)}%` : "..."}
            tooltip="Total CPU across live child processes of the current server process. The desktop shell and other parent processes are not included."
          />
          <StatBlock
            label="Memory"
            value={processData ? formatBytes(processData.totalRssBytes) : "..."}
            tooltip="Total resident memory across live child processes of the current server process. The desktop shell and other parent processes are not included."
          />
          <StatBlock
            label="Server PID"
            value={processData ? String(processData.serverPid) : "..."}
          />
        </StatsGrid>
        {processDiagnosticsError || processError ? (
          <div className="space-y-2 border-t border-border/60 px-4 py-3 text-xs text-muted-foreground sm:px-5">
            {processDiagnosticsError ? (
              <div className="flex items-start gap-2 text-destructive">
                <AlertTriangleIcon className="mt-0.5 size-3.5 shrink-0" />
                <span>{processDiagnosticsError.message}</span>
              </div>
            ) : null}
            {processError ? (
              <div className="flex items-start gap-2 text-destructive">
                <AlertTriangleIcon className="mt-0.5 size-3.5 shrink-0" />
                <span>{processError}</span>
              </div>
            ) : null}
          </div>
        ) : null}
        <ProcessDiagnosticsTable
          processes={processData?.processes ?? []}
          signalingPid={signalingPid}
          onSignal={signalProcess}
          emptyLabel={
            isProcessInitialLoading
              ? "Loading live processes..."
              : "No live descendant processes found."
          }
        />
      </SettingsSection>

      <SettingsSection
        title="Trace Diagnostics"
        headerAction={
          <div className="flex items-center gap-1.5">
            <DiagnosticsLastChecked checkedAt={data?.readAt ?? null} />
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    className="size-5 rounded-sm p-0 text-muted-foreground hover:text-foreground"
                    disabled={!observability?.logsDirectoryPath || isOpeningLogsDirectory}
                    onClick={openLogsDirectory}
                    aria-label="Open logs folder"
                  >
                    <FolderOpenIcon className="size-3" />
                  </Button>
                }
              />
              <TooltipPopup side="top">Open logs folder</TooltipPopup>
            </Tooltip>
            <DiagnosticsRefreshButton
              isPending={isPending}
              label="Refresh trace diagnostics"
              onClick={refresh}
            />
          </div>
        }
      >
        <StatsGrid>
          <StatBlock label="Spans" value={data ? formatCount(data.recordCount) : "..."} />
          <StatBlock
            label="Failures"
            value={data ? formatCount(data.failureCount) : "..."}
            tone={data && data.failureCount > 0 ? "danger" : "default"}
          />
          <StatBlock
            label="Slow Spans"
            value={data ? formatCount(data.slowSpanCount) : "..."}
            tooltip={
              data
                ? `Spans with a duration of ${formatDuration(data.slowSpanThresholdMs)} or longer.`
                : "Spans at or above the configured slow-span threshold."
            }
            tone={data && data.slowSpanCount > 0 ? "warning" : "default"}
          />
          <StatBlock
            label="Parse Errors"
            value={data ? formatCount(data.parseErrorCount) : "..."}
            tone={data && data.parseErrorCount > 0 ? "warning" : "default"}
          />
        </StatsGrid>
        {openLogsDirectoryError || traceDiagnosticsError || error ? (
          <div className="space-y-2 border-t border-border/60 px-4 py-3 text-xs text-muted-foreground sm:px-5">
            {openLogsDirectoryError ? (
              <div className="flex items-start gap-2 text-destructive">
                <AlertTriangleIcon className="mt-0.5 size-3.5 shrink-0" />
                <span>{openLogsDirectoryError}</span>
              </div>
            ) : null}
            {traceDiagnosticsError ? (
              <div
                className={cn(
                  "flex items-start gap-2",
                  traceDiagnosticsPartialFailure
                    ? "text-amber-600 dark:text-amber-400"
                    : "text-destructive",
                )}
              >
                <AlertTriangleIcon className="mt-0.5 size-3.5 shrink-0" />
                <span>
                  {traceDiagnosticsPartialFailure
                    ? `Some trace files could not be read, so diagnostics may be incomplete. ${traceDiagnosticsError.message}`
                    : traceDiagnosticsError.message}
                </span>
              </div>
            ) : null}
            {error ? (
              <div className="flex items-start gap-2 text-destructive">
                <AlertTriangleIcon className="mt-0.5 size-3.5 shrink-0" />
                <span>{error}</span>
              </div>
            ) : null}
          </div>
        ) : null}
      </SettingsSection>

      <SettingsSection title="Latest Failures">
        {data && data.latestFailures.length > 0 ? (
          <DiagnosticsTable headers={["Span", "Cause", "Duration", "Ended"]}>
            {data.latestFailures.map((failure) => (
              <tr key={`${failure.traceId}:${failure.spanId}`}>
                <td className="px-4 py-3 align-top text-xs font-medium text-foreground first:sm:pl-5">
                  {failure.name}
                </td>
                <td className="max-w-[360px] px-4 py-3 align-top text-muted-foreground">
                  <ExpandableText text={failure.cause} />
                </td>
                <td className="px-4 py-3 align-top font-mono tabular-nums">
                  {formatDuration(failure.durationMs)}
                </td>
                <td className="whitespace-nowrap px-4 py-3 align-top font-mono tabular-nums text-muted-foreground last:sm:pr-5">
                  {formatRelativeNoWrap(failure.endedAt)}
                </td>
              </tr>
            ))}
          </DiagnosticsTable>
        ) : (
          <EmptyRows label={isInitialLoading ? "Loading failures..." : "No failed spans found."} />
        )}
      </SettingsSection>

      <SettingsSection title="Most Common Failures">
        {data && data.commonFailures.length > 0 ? (
          <DiagnosticsTable
            headers={["Span", "Count", "Cause", "Last Seen"]}
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
                  {formatRelativeNoWrap(failure.lastSeenAt)}
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

      <SettingsSection title="Slowest Spans">
        {data && data.slowestSpans.length > 0 ? (
          <DiagnosticsTable
            headers={["Span", "Duration", "Ended", "Trace"]}
            minTableWidth="min-w-[900px]"
            columnWidths={["w-[44%]", "w-[14%]", "w-[12%]", "w-[30%]"]}
          >
            {data.slowestSpans.map((span) => (
              <tr key={`${span.traceId}:${span.spanId}`}>
                <td className="px-4 py-3 align-top text-xs font-medium text-foreground first:sm:pl-5">
                  {span.name}
                </td>
                <td className="px-4 py-3 align-top font-mono tabular-nums">
                  {formatDuration(span.durationMs)}
                </td>
                <td className="w-px whitespace-nowrap px-4 py-3 align-top font-mono tabular-nums text-muted-foreground">
                  {formatRelativeNoWrap(span.endedAt)}
                </td>
                <td className="min-w-0 whitespace-nowrap px-4 py-3 align-top text-muted-foreground last:sm:pr-5">
                  <TraceIdCell traceId={span.traceId} />
                </td>
              </tr>
            ))}
          </DiagnosticsTable>
        ) : (
          <EmptyRows label={isInitialLoading ? "Loading slow spans..." : "No spans found."} />
        )}
      </SettingsSection>

      <SettingsSection title="Span Logs">
        {data && data.latestWarningAndErrorLogs.length > 0 ? (
          <ScrollArea
            chainVerticalScroll
            scrollFade
            hideScrollbars
            className="w-full max-w-full rounded-none"
          >
            <table className="w-full min-w-[920px] table-fixed text-left text-xs">
              <colgroup>
                <col className="w-[11%]" />
                <col className="w-[9%]" />
                <col className="w-[24%]" />
                <col className="w-[26%]" />
                <col className="w-[30%]" />
              </colgroup>
              <thead className="border-b border-border/60 text-[11px] uppercase tracking-[0.08em] text-muted-foreground/70">
                <tr>
                  <th className="whitespace-nowrap px-4 py-2.5 font-semibold sm:pl-5">Time</th>
                  <th className="whitespace-nowrap px-4 py-2.5 font-semibold">Level</th>
                  <th className="whitespace-nowrap px-4 py-2.5 font-semibold">Span</th>
                  <th className="whitespace-nowrap px-4 py-2.5 font-semibold">Message</th>
                  <th className="whitespace-nowrap px-4 py-2.5 font-semibold sm:pr-5">Trace</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/60">
                {data.latestWarningAndErrorLogs.map((event) => (
                  <tr
                    key={`${event.traceId}:${event.spanId}:${DateTime.formatIso(event.seenAt)}:${event.message}`}
                    className="hover:bg-muted/15"
                  >
                    <td className="whitespace-nowrap px-4 py-3 align-top font-mono tabular-nums text-muted-foreground sm:pl-5">
                      {formatRelativeNoWrap(event.seenAt)}
                    </td>
                    <td className="px-4 py-3 align-top">
                      <span className="inline-flex rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] font-medium uppercase text-foreground/80">
                        {event.level}
                      </span>
                    </td>
                    <td className="px-4 py-3 align-top">
                      <div className="truncate font-medium text-foreground">{event.spanName}</div>
                    </td>
                    <td className="px-4 py-3 align-top text-muted-foreground">
                      <ExpandableText
                        collapsedClassName="line-clamp-2"
                        expandLabel="Show full message"
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
            label={isInitialLoading ? "Loading recent logs..." : "No warnings or errors found."}
          />
        )}
      </SettingsSection>

      <SettingsSection title="Top Span Names">
        {data && data.topSpansByCount.length > 0 ? (
          <DiagnosticsTable
            headers={["Span", "Count", "Failures", "Average", "Max"]}
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
                  {formatDuration(span.averageDurationMs)}
                </td>
                <td className="whitespace-nowrap px-4 py-3 align-top font-mono tabular-nums last:sm:pr-5">
                  {formatDuration(span.maxDurationMs)}
                </td>
              </tr>
            ))}
          </DiagnosticsTable>
        ) : (
          <EmptyRows label={isInitialLoading ? "Loading span names..." : "No spans found."} />
        )}
      </SettingsSection>
    </SettingsPageContainer>
  );
}
