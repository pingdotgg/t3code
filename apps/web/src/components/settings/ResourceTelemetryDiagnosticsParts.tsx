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
} from "lucide-react";
import { ChevronDown, ChevronRight } from "lucide";
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
import { MorphIcon } from "~/components/MorphIcon";
import { ScrollArea } from "../ui/scroll-area";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { toastManager } from "../ui/toast";
import {
  processIdentityKey,
  resourceHistoryBarHeight,
  resourceHistoryCpuScaleMax,
  shouldShowResourceMonitorRetry,
  visibleResourceTelemetryProcesses,
} from "./ResourceTelemetryDiagnostics.logic";
import { SettingsSection } from "./settingsLayout";
import { AggregateCard, AttributionTable, DetailRow, HISTORY_WINDOWS, HealthSource, HistoryProcessTable, HistoryWindowSelector, IconStat, LastSampleLabel, ProcessTable, ResourceHistoryChart, SourceStatusBadge, booleanStateLabel, formatCpuTime, formatDurationMicros, formatRate, formatSampleInterval } from "./ResourceTelemetryDiagnostics";

export function ResourceTelemetryDiagnosticsBody({
  environmentId,
}: {
  environmentId: EnvironmentId | null;
}) {
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
          title: "Could not restart resource monitor",
          description:
            error instanceof Error ? error.message : "The resource monitor retry failed.",
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
        title="Resource monitor"
        icon={<ActivityIcon className="size-4 text-muted-foreground" />}
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
                    size="icon-micro"
                    variant="ghost"
                    disabled={telemetry.isPending}
                    onClick={telemetry.refresh}
                    aria-label="Refresh resource telemetry"
                  >
                    <RefreshIcon size="xs" refreshing={telemetry.isPending} />
                  </Button>
                }
              />
              <TooltipPopup side="top">Refresh telemetry snapshot</TooltipPopup>
            </Tooltip>
          </div>
        }
      >
        <div className="overflow-hidden rounded-[inherit]">
          <div className="flex flex-col gap-3 border-b border-border/60 bg-linear-to-r from-muted/45 via-muted/20 to-transparent px-4 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-5">
            <div>
              <div className="text-3xs font-semibold uppercase tracking-widest text-muted-foreground/70">
                T3 system footprint
              </div>
              <p className="mt-1 max-w-xl text-xs leading-relaxed text-muted-foreground">
                Live native counters for the server, providers, terminals, desktop processes, and
                the monitor itself.
              </p>
            </div>
            <div className="flex items-center gap-2 text-3xs text-muted-foreground/65">
              <span className="size-1.5 rounded-full bg-success" />
              Sampling every {snapshot ? formatSampleInterval(snapshot.sampleIntervalMs) : "..."}
            </div>
          </div>
          <div className="grid grid-cols-2 divide-x divide-y divide-border/55 md:grid-cols-3">
            <IconStat
              icon={<CpuIcon className="size-3.5" />}
              label="Current CPU"
              value={allT3 ? `${allT3.currentCpuPercent.toFixed(1)}%` : "..."}
              detail={allT3 ? `${formatCpuTime(allT3.cpuTimeMs)} observed CPU time` : undefined}
            />
            <IconStat
              icon={<MemoryStickIcon className="size-3.5" />}
              label="Resident memory"
              value={allT3 ? formatBytes(allT3.currentRssBytes) : "..."}
              detail={
                allT3 ? `${formatBytes(allT3.peakRssBytes)} combined process peaks` : undefined
              }
            />
            <IconStat
              icon={<ActivityIcon className="size-3.5" />}
              label="Process count"
              value={allT3 ? String(allT3.processCount) : "..."}
              detail={
                allT3 ? `${allT3.processStarts} starts · ${allT3.processExits} exits` : undefined
              }
            />
            <IconStat
              icon={<HardDriveIcon className="size-3.5" />}
              label="Read throughput"
              value={allT3 ? formatRate(allT3.ioReadBytesPerSecond) : "..."}
              detail={allT3 ? `${formatBytes(allT3.ioReadBytes)} observed` : undefined}
            />
            <IconStat
              icon={<DatabaseIcon className="size-3.5" />}
              label="Write throughput"
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
              icon={<GaugeIcon className="size-3.5" />}
              label="CPU speed limit"
              value={
                snapshot ? (speedLimit === null ? "Unknown" : `${speedLimit.toFixed(0)}%`) : "..."
              }
              detail={snapshot ? `${snapshot.power.thermalState} thermal state` : undefined}
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
                label="Backend + agents"
                accentClass="bg-success/80"
                aggregate={snapshot.groups.backend}
              />
              <AggregateCard
                label="Desktop"
                accentClass="bg-info/80"
                aggregate={snapshot.groups.electron}
              />
              <AggregateCard
                label="Monitor overhead"
                accentClass="bg-warning/80"
                aggregate={snapshot.groups.monitor}
              />
            </div>
          ) : null}
        </div>
      </SettingsSection>

      <SettingsSection
        title="Host & collection"
        icon={<GaugeIcon className="size-4 text-muted-foreground" />}
        headerAction={
          collectorNeedsRetry ? (
            <Button size="xs" variant="outline" disabled={isRetrying} onClick={retryCollector}>
              <RefreshIcon size="xs" refreshing={isRetrying} />
              Retry monitor
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
              Host state
            </div>
            {hasHostPowerSignal && snapshot ? (
              <>
                <DetailRow
                  label="Power source"
                  value={booleanStateLabel(snapshot.power.onBattery, {
                    true: "Battery",
                    false: "External power",
                  })}
                />
                <DetailRow
                  label="Low power mode"
                  value={booleanStateLabel(snapshot.power.lowPowerMode, {
                    true: "Enabled",
                    false: "Disabled",
                  })}
                />
                <DetailRow
                  label="Idle"
                  value={`${booleanStateLabel(snapshot.power.idle, {
                    true: "Idle",
                    false: "Active",
                  })}${
                    snapshot.power.idleSeconds === null
                      ? ""
                      : ` · ${Math.round(snapshot.power.idleSeconds)}s`
                  }`}
                />
                <DetailRow
                  label="Session"
                  value={
                    snapshot.power.suspended
                      ? "Suspended"
                      : booleanStateLabel(snapshot.power.locked, {
                          true: "Locked",
                          false: "Unlocked",
                        })
                  }
                />
                <DetailRow
                  label="Thermal"
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
                  Desktop host signals not connected
                </div>
                <p className="mt-1.5 max-w-sm text-2xs leading-relaxed text-muted-foreground/70">
                  Power, idle, lock, and thermal state are supplied by the desktop host. Process
                  telemetry remains fully active in this browser session.
                </p>
              </div>
            )}
          </div>
          <div className="border-t border-border/60 px-4 py-4 md:border-t-0 sm:px-5">
            <div className="mb-3 flex items-center gap-2 text-3xs font-semibold uppercase tracking-widest text-muted-foreground/70">
              <span className="flex size-6 items-center justify-center rounded-md bg-muted/60">
                <GaugeIcon className="size-3.5" />
              </span>
              Collection health
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
                      ? "text-warning-foreground"
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
        title="Resource timeline"
        icon={<HardDriveIcon className="size-4 text-muted-foreground" />}
        headerAction={
          <div className="flex items-center gap-2">
            <HistoryWindowSelector selectedWindowMs={windowMs} onSelect={setWindowMs} />
            <Button
              size="icon-micro"
              variant="ghost"
              disabled={history.isPending}
              onClick={history.refresh}
              aria-label="Refresh resource history"
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
        title="Live process tree"
        icon={<CpuIcon className="size-4 text-muted-foreground" />}
        headerAction={
          snapshot ? (
            <span className="text-3xs text-muted-foreground/55">
              Identity: <span className="font-mono">PID + start time</span>
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
        title="Instrumented application I/O"
        icon={<DatabaseIcon className="size-4 text-muted-foreground" />}
        headerAction={
          <span className="text-3xs text-muted-foreground/55">Logical bytes by operation</span>
        }
      >
        <div className="overflow-hidden rounded-[inherit]">
          <div className="bg-muted/15 px-4 py-3 text-2xs leading-relaxed text-muted-foreground sm:px-5">
            Native counters identify which process is reading or writing. These application-level
            counters identify known T3 operations so process spikes can be correlated with specific
            persistence and logging paths.
          </div>
          <AttributionTable entries={snapshot?.attribution.entries ?? []} />
        </div>
      </SettingsSection>
    </>
  );
}

