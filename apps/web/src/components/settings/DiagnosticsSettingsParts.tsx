import { ProcessSignalActions } from "./ProcessSignalActions";
import { resolveUsageAccess } from "@t3tools/client-runtime/state/usage-access";
import { environmentSession } from "../../state/session";
import { AuthOrchestrationOperateScope } from "@t3tools/contracts";
import { readEnvironmentScope, useEnvironmentScope } from "../../state/session";
import { AuthEnvironmentMaintainScope } from "@t3tools/contracts";
import { RefreshIcon } from "~/components/ui/refresh-icon";
import { AlertTriangleIcon, CopyIcon, FolderOpenIcon, InfoIcon } from "lucide-react";
import { ChevronDown, ChevronRight } from "lucide";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { useRef, useState, type ReactNode } from "react";
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
import { SettingsPageContainer, SettingsSection } from "./settingsLayout";
import { useAtomCommand } from "../../state/use-atom-command";
import { useSettingsScope } from "./SettingsScopeContext";
import { TelemetryExportSettings } from "./TelemetryExportSettings";
import { DiagnosticsLastChecked, DiagnosticsRefreshButton, DiagnosticsTable, EmptyRows, ProcessDiagnosticsTable, ProcessResourceHistoryChart, ProcessResourceHistoryTable, RESOURCE_HISTORY_WINDOWS, RelativeTimeNoWrap, ResourceHistoryWindowSelector, StatBlock, StatsGrid, TraceIdCell, formatCount, formatCpuTime, formatDuration, isStaleProcessSignalMessage } from "./DiagnosticsSettings";

export function DiagnosticsSettingsBody() {
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
            ? "Connect an environment to see diagnostics."
            : diagnosticsAccess.isPending
              ? "Checking diagnostics access…"
              : diagnosticsAccess.error}
        </p>
      </SettingsPageContainer>
    );
  }

  return (
    <SettingsPageContainer width="expanded" className="gap-10">
      <ResourceTelemetryDiagnostics environmentId={environmentId} />

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
              ? "Loading live processes..."
              : "No live descendant processes found."
          }
        />
      </SettingsSection>

      <SettingsSection
        title="Resource History"
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
            value={resourceData ? formatCpuTime(resourceData.totalCpuSecondsApprox) : "..."}
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
              ? "Collecting process resource samples..."
              : "No process resource samples found for this window."
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
                    variant="ghost-muted"
                    disabled={
                      !canOpenHostEditor ||
                      !observability?.logsDirectoryPath ||
                      isOpeningLogsDirectory
                    }
                    onClick={openLogsDirectory}
                    aria-label="Open logs folder"
                  >
                    <FolderOpenIcon />
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
                  <RelativeTimeNoWrap value={failure.endedAt} />
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
                  <RelativeTimeNoWrap value={failure.lastSeenAt} />
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
                  <RelativeTimeNoWrap value={span.endedAt} />
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
      {exportFormEnvironmentId === environmentId && <TelemetryExportSettings />}
    </SettingsPageContainer>
  );
}

