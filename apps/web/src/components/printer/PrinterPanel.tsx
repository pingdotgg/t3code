import { useAtomValue } from "@effect/atom-react";
import type {
  EnvironmentId,
  PrinterAction,
  PrinterId,
  PrinterObject,
  PrinterSnapshot,
  PrinterThermalReading,
  ScopedThreadRef,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useGT } from "gt-react";
import {
  AlertTriangle,
  Box,
  CheckCircle2,
  Clock,
  Cpu,
  Flame,
  HardDrive,
  Info,
  Pause,
  Play,
  Printer,
  RefreshCw,
  Server,
  Settings,
  SkipForward,
  Square,
  Thermometer,
  Wifi,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";

import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "~/components/ui/alert-dialog";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { MiddleTruncate } from "~/components/ui/middle-truncate";
import { Popover, PopoverPopup, PopoverTrigger } from "~/components/ui/popover";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { Spinner } from "~/components/ui/spinner";
import { Toggle, ToggleGroup } from "~/components/ui/toggle-group";
import { toastManager } from "~/components/ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { observeResize } from "~/lib/observeResize";
import { cn } from "~/lib/utils";
import { type RightPanelSurface, useRightPanelStore } from "~/rightPanelStore";
import {
  printerEnvironment,
  refreshPrinterMediaAccess,
  selectFleetPrinter,
  useFleetPrinters,
  usePrinterMediaAccess,
} from "~/state/printer";
import { formatEnvironmentQueryError } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";
import { PreviewPanelShell, type PreviewPanelMode } from "../preview/PreviewPanelShell";
import { PrinterControlsDeck } from "./PrinterControlsDeck";
import { PrinterFilamentStrip } from "./PrinterFilamentStrip";
import {
  formatClockTime,
  formatDurationCompact,
  formatTemp,
  isActiveJobStatus,
  statusBadgeVariant,
  statusDotClass,
} from "./printerFormat";
import { PrinterThermalChart } from "./PrinterThermalChart";
import { PrinterViewport, type PrinterViewportMode } from "./PrinterViewport";

type PrinterPanelTab = "monitor" | "controls" | "details";

const NOZZLE_PRESETS = [0, 190, 215, 220, 250] as const;
const BED_PRESETS = [0, 55, 60, 70, 80] as const;

function ThermalCard({
  label,
  reading,
  defaultMaxC = 300,
  accentClass,
  editable,
  presets,
  disabled,
  onSetTarget,
}: {
  readonly label: string;
  readonly reading: PrinterThermalReading;
  readonly defaultMaxC?: number;
  readonly accentClass: string;
  readonly editable: boolean;
  readonly presets: ReadonlyArray<number>;
  readonly disabled: boolean;
  readonly onSetTarget?: ((targetC: number) => void) | undefined;
}) {
  const gt = useGT();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const minC = reading.minC ?? 0;
  const maxC = reading.maxC ?? defaultMaxC;
  const heating =
    reading.targetC !== null &&
    reading.targetC > 0 &&
    reading.actualC !== null &&
    reading.actualC < reading.targetC - 3;

  const commitTarget = (value: number) => {
    const clamped = Math.max(minC, Math.min(maxC, Math.round(value)));
    onSetTarget?.(clamped);
    setOpen(false);
  };

  const cardBody = (
    <div
      className={cn(
        "flex w-full flex-col gap-1 rounded-lg border border-border/60 bg-card/60 px-2.5 py-2 text-left transition",
        editable && !disabled && "cursor-pointer hover:border-border hover:bg-accent/40",
      )}
    >
      <div className="flex items-center justify-between gap-1 text-2xs text-muted-foreground">
        <span className="inline-flex items-center gap-1 font-medium">
          <span className={cn("size-1.5 rounded-full", accentClass)} />
          {label}
        </span>
        {heating ? <Flame className="size-3 text-warning" /> : null}
      </div>
      <div className="flex items-baseline gap-1 tabular-nums">
        <span className="text-sm font-semibold text-foreground">{formatTemp(reading.actualC)}</span>
        <span className="text-2xs text-muted-foreground">
          / {reading.targetC !== null ? `${Math.round(reading.targetC)}°` : "--"}
        </span>
      </div>
    </div>
  );

  if (!editable || !onSetTarget) {
    return cardBody;
  }

  return (
    <Popover
      open={open}
      onOpenChange={(nextOpen) => {
        setOpen(nextOpen);
        if (nextOpen) {
          setDraft(reading.targetC !== null ? String(Math.round(reading.targetC)) : "0");
        }
      }}
    >
      <PopoverTrigger
        disabled={disabled}
        render={
          <button
            type="button"
            disabled={disabled}
            className="w-full rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring disabled:opacity-60"
            aria-label={gt("Set {label} target temperature", { label })}
          />
        }
      >
        {cardBody}
      </PopoverTrigger>
      <PopoverPopup className="w-56">
        <div className="space-y-2.5">
          <div className="flex items-center justify-between text-xs font-medium">
            <span className="inline-flex items-center gap-1.5">
              <Thermometer className="size-3.5 text-muted-foreground" />
              {gt("{label} target", { label })}
            </span>
            <span className="text-2xs text-muted-foreground tabular-nums">
              {minC}-{maxC}°C
            </span>
          </div>
          <div className="flex items-center gap-1.5">
            <Input
              type="number"
              min={minC}
              max={maxC}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && draft.trim() !== "") {
                  const num = Number(draft.trim());
                  if (Number.isFinite(num)) commitTarget(num);
                }
              }}
              aria-label={gt("Target temperature in Celsius")}
            />
            <Button
              size="sm"
              disabled={draft.trim() === "" || !Number.isFinite(Number(draft.trim()))}
              onClick={() => {
                if (draft.trim() === "") return;
                const num = Number(draft.trim());
                if (Number.isFinite(num)) commitTarget(num);
              }}
            >
              {gt("Set")}
            </Button>
          </div>
          <div className="flex flex-wrap gap-1">
            {presets.map((preset) => (
              <Button key={preset} size="xs" variant="outline" onClick={() => commitTarget(preset)}>
                {preset === 0 ? gt("Off") : `${preset}°C`}
              </Button>
            ))}
          </div>
        </div>
      </PopoverPopup>
    </Popover>
  );
}

function PrinterDetailsSection({ printer }: { readonly printer: PrinterSnapshot }) {
  const gt = useGT();
  const rows: ReadonlyArray<{ readonly label: string; readonly value: string }> = [
    ...(printer.hardware.model ? [{ label: gt("Model"), value: printer.hardware.model }] : []),
    ...(printer.hardware.serial ? [{ label: gt("Serial"), value: printer.hardware.serial }] : []),
    ...(printer.hardware.nozzleSizeMm !== null || printer.hardware.nozzleType
      ? [
          {
            label: gt("Nozzle"),
            value: [
              printer.hardware.nozzleSizeMm !== null ? `${printer.hardware.nozzleSizeMm} mm` : null,
              printer.hardware.nozzleType,
            ]
              .filter(Boolean)
              .join(" "),
          },
        ]
      : []),
    ...(printer.hardware.bedType
      ? [{ label: gt("Build plate"), value: printer.hardware.bedType }]
      : []),
    ...(printer.hardware.firmware
      ? [{ label: gt("Firmware"), value: printer.hardware.firmware }]
      : []),
    ...(printer.hardware.ipAddress
      ? [{ label: gt("IP address"), value: printer.hardware.ipAddress }]
      : []),
    ...(printer.hardware.connectionMode
      ? [{ label: gt("Transport"), value: printer.hardware.connectionMode }]
      : []),
    ...(printer.hardware.sdCardStatus
      ? [{ label: gt("SD card"), value: printer.hardware.sdCardStatus }]
      : []),
    ...(printer.hardware.wifiSignalDbm !== null
      ? [{ label: gt("Wi-Fi signal"), value: `${printer.hardware.wifiSignalDbm} dBm` }]
      : []),
    ...(printer.hardware.totalUsageHours !== null
      ? [
          {
            label: gt("Total print time"),
            value: `${printer.hardware.totalUsageHours.toFixed(1)} h`,
          },
        ]
      : []),
  ];

  return (
    <div className="space-y-3">
      <div className="rounded-lg border border-border/60 bg-card/50 p-2.5">
        <div className="mb-2 flex items-center gap-1.5 text-xs font-medium text-foreground">
          <Cpu className="size-3.5 text-muted-foreground" />
          {gt("Hardware & Connection")}
        </div>
        <dl className="grid grid-cols-2 gap-x-3 gap-y-2 text-xs">
          {rows.map((row) => (
            <div key={row.label} className="min-w-0">
              <dt className="text-2xs text-muted-foreground">{row.label}</dt>
              <dd className="truncate font-medium text-foreground tabular-nums">{row.value}</dd>
            </div>
          ))}
        </dl>
      </div>

      <div className="rounded-lg border border-border/60 bg-card/50 p-2.5">
        <div className="mb-2 flex items-center justify-between text-xs font-medium text-foreground">
          <span className="inline-flex items-center gap-1.5">
            <HardDrive className="size-3.5 text-muted-foreground" />
            {gt("Health & Diagnostics")}
          </span>
          <Badge size="sm" variant={printer.alerts.length > 0 ? "warning" : "success"}>
            {printer.alerts.length > 0
              ? gt("{count} alerts", { count: printer.alerts.length })
              : gt("Healthy")}
          </Badge>
        </div>
        {printer.alerts.length === 0 ? (
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <CheckCircle2 className="size-3.5 text-success" />
            <span>{gt("No active HMS or print errors.")}</span>
          </div>
        ) : (
          <ul className="space-y-1.5">
            {printer.alerts.map((alert) => (
              <li
                key={`${alert.code}:${alert.message}`}
                className="flex items-start gap-2 rounded-md border border-border/60 bg-background/50 p-2 text-xs"
              >
                <AlertTriangle
                  className={cn(
                    "mt-0.5 size-3.5 shrink-0",
                    alert.severity === "error" ? "text-destructive" : "text-warning",
                  )}
                />
                <div className="min-w-0">
                  <div className="font-medium text-foreground">{alert.message}</div>
                  <div className="font-mono text-3xs text-muted-foreground">{alert.code}</div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function PrinterObjectsCard({
  objects,
  canSkip,
  busy,
  hasPickImage,
  onSelectObject,
  onRequestSkip,
}: {
  readonly objects: ReadonlyArray<PrinterObject>;
  readonly canSkip: boolean;
  readonly busy: boolean;
  readonly hasPickImage: boolean;
  readonly onSelectObject: () => void;
  readonly onRequestSkip: (obj: PrinterObject) => void;
}) {
  const gt = useGT();
  if (objects.length === 0) return null;
  const skippedCount = objects.filter((obj) => obj.skipped).length;

  return (
    <div className="space-y-2 rounded-lg border border-border/60 bg-card/50 p-2.5">
      <div className="flex items-center justify-between gap-2">
        <span className="inline-flex items-center gap-1.5 text-xs font-medium text-foreground">
          <Box className="size-3.5 text-muted-foreground" />
          {gt("Objects on plate")}
        </span>
        <span className="text-2xs text-muted-foreground tabular-nums">
          {skippedCount > 0
            ? gt("{total} total · {skipped} skipped", {
                total: objects.length,
                skipped: skippedCount,
              })
            : gt("{count, plural, one {{count} object} other {{count} objects}}", {
                count: objects.length,
              })}
        </span>
      </div>
      <ul className="space-y-1">
        {objects.map((obj) => (
          <li
            key={obj.id}
            className="flex items-center justify-between gap-2 rounded-md border border-border/50 bg-background/40 px-2 py-1.5 text-xs"
          >
            <button
              type="button"
              disabled={!hasPickImage}
              onClick={onSelectObject}
              className="min-w-0 flex-1 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring disabled:cursor-default"
            >
              <span
                className={cn(
                  "block truncate font-medium",
                  obj.skipped ? "text-muted-foreground line-through" : "text-foreground",
                )}
              >
                {obj.name}
              </span>
            </button>
            {obj.skipped ? (
              <Badge size="sm" variant="secondary">
                {gt("Skipped")}
              </Badge>
            ) : canSkip ? (
              <Button
                size="xs"
                variant="outline"
                disabled={busy}
                onClick={() => onRequestSkip(obj)}
              >
                <SkipForward className="size-3" />
                {gt("Skip")}
              </Button>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

export function PrinterPanel(props: {
  readonly mode: PreviewPanelMode;
  readonly threadRef: ScopedThreadRef;
  readonly surface: Extract<RightPanelSurface, { kind: "printer" }>;
  readonly visible: boolean;
}) {
  const gt = useGT();
  const navigate = useNavigate();
  const threadEnvironmentId = props.threadRef.environmentId;
  const {
    entries: fleetPrinters,
    localState: state,
    loaded,
    error: stateError,
    loadingEnvironmentIds,
  } = useFleetPrinters(threadEnvironmentId);

  const pinnedOwnerEnvironmentId =
    props.surface.printerId !== undefined
      ? (props.surface.proxyEnvironmentId ?? threadEnvironmentId)
      : props.surface.proxyEnvironmentId;
  const activeEntry = selectFleetPrinter(
    fleetPrinters,
    props.surface.printerId,
    pinnedOwnerEnvironmentId,
  );
  const activePrinter = activeEntry?.printer;
  const proxyEnvironmentId = activeEntry?.proxyEnvironmentId ?? threadEnvironmentId;
  const activePrinterKey = activePrinter ? `${proxyEnvironmentId}:${activePrinter.id}` : "none";

  const mediaAccess = usePrinterMediaAccess(proxyEnvironmentId);

  const canAction = useAtomValue(printerEnvironment.action.permissionAtom(proxyEnvironmentId));
  const runAction = useAtomCommand(printerEnvironment.action, { reportFailure: false });
  const runList = useAtomCommand(printerEnvironment.list, { reportFailure: false });

  const [tab, setTab] = useState<PrinterPanelTab>("monitor");
  const [viewMode, setViewMode] = useState<PrinterViewportMode>("camera");
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [stopTarget, setStopTarget] = useState<{
    readonly printerId: PrinterId;
    readonly printerLabel: string;
    readonly proxyEnvironmentId: EnvironmentId;
    readonly expectedJobFileName: string | null;
    readonly expectedJobStartedAt: string | null;
    readonly displayName: string;
  } | null>(null);
  const [skipTarget, setSkipTarget] = useState<{
    readonly printerId: PrinterId;
    readonly proxyEnvironmentId: EnvironmentId;
    readonly object: PrinterObject;
    readonly jobFileName: string | null;
    readonly jobStartedAt: string | null;
  } | null>(null);
  const [isWide, setIsWide] = useState(false);
  const [containerElement, setContainerElement] = useState<HTMLDivElement | null>(null);
  const lastMediaRefreshMsByPrinterRef = useRef<Map<string, number>>(new Map());

  const activeJobSignature = `${activePrinterKey}:${activePrinter?.job.fileName ?? ""}:${activePrinter?.job.startedAt ?? ""}`;
  const [trackedJobSignature, setTrackedJobSignature] = useState(activeJobSignature);
  if (trackedJobSignature !== activeJobSignature) {
    setTrackedJobSignature(activeJobSignature);
    if (stopTarget !== null) setStopTarget(null);
    if (skipTarget !== null) setSkipTarget(null);
  }

  const stopDialogValid =
    stopTarget !== null &&
    activePrinter !== undefined &&
    stopTarget.printerId === activePrinter.id &&
    stopTarget.proxyEnvironmentId === proxyEnvironmentId &&
    stopTarget.expectedJobFileName === activePrinter.job.fileName &&
    stopTarget.expectedJobStartedAt === activePrinter.job.startedAt;
  const skipDialogValid =
    skipTarget !== null &&
    activePrinter !== undefined &&
    skipTarget.printerId === activePrinter.id &&
    skipTarget.proxyEnvironmentId === proxyEnvironmentId &&
    skipTarget.jobFileName === activePrinter.job.fileName &&
    skipTarget.jobStartedAt === activePrinter.job.startedAt;

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- tracks container width to switch single-tree narrow vs wide layout without duplicating viewport polling
  useEffect(() => {
    if (!containerElement) return;
    const sync = () => setIsWide(containerElement.clientWidth >= 720);
    sync();
    return observeResize(containerElement, sync);
  }, [containerElement]);

  const handleMediaError = () => {
    const now = Date.now();
    const lastMs = lastMediaRefreshMsByPrinterRef.current.get(activePrinterKey) ?? 0;
    if (now - lastMs < 15_000) return;
    lastMediaRefreshMsByPrinterRef.current.set(activePrinterKey, now);
    refreshPrinterMediaAccess(proxyEnvironmentId);
  };

  const openSettings = () => {
    void navigate({
      to: "/settings/printers",
      ...(activeEntry?.isProxied ? { search: { machine: activeEntry.proxyEnvironmentId } } : {}),
    });
  };

  const handleRefresh = async () => {
    if (refreshing) return;
    setRefreshing(true);
    try {
      const result = await runList({
        environmentId: proxyEnvironmentId,
        input: {
          ...(activePrinter ? { printerId: activePrinter.id } : {}),
          refresh: true,
        },
      });
      if (result._tag === "Failure") {
        toastManager.add({
          type: "error",
          title: gt("Could not refresh printer"),
          description: formatEnvironmentQueryError(result.cause),
        });
      }
    } catch (error) {
      toastManager.add({
        type: "error",
        title: gt("Could not refresh printer"),
        description: error instanceof Error ? error.message : String(error),
      });
    }
    setRefreshing(false);
  };

  const handleAction = async (
    action: PrinterAction,
    targetOverride?: {
      readonly printerId: PrinterId;
      readonly proxyEnvironmentId: EnvironmentId;
    },
  ) => {
    const targetPrinterId = targetOverride?.printerId ?? activePrinter?.id;
    const targetEnvId = targetOverride?.proxyEnvironmentId ?? proxyEnvironmentId;
    if (!targetPrinterId || !canAction || pendingAction !== null) return;
    setPendingAction(action.kind);
    try {
      const result = await runAction({
        environmentId: targetEnvId,
        input: { printerId: targetPrinterId, action },
      });
      if (result._tag === "Failure") {
        toastManager.add({
          type: "error",
          title: gt("Printer command failed"),
          description: formatEnvironmentQueryError(result.cause),
        });
      }
    } catch (error) {
      toastManager.add({
        type: "error",
        title: gt("Printer command failed"),
        description: error instanceof Error ? error.message : String(error),
      });
    }
    setPendingAction(null);
  };

  const handleSelectPrinter = (fleetKey: string | null) => {
    if (!fleetKey) return;
    const match = fleetPrinters.find((entry) => entry.key === fleetKey);
    if (!match) return;
    setStopTarget(null);
    setSkipTarget(null);
    useRightPanelStore.getState().openPrinter(props.threadRef, {
      printerId: match.printer.id as PrinterId,
      proxyEnvironmentId: match.proxyEnvironmentId,
      label: match.printer.label,
    });
  };

  const renderEmptyState = () => {
    const pinnedEnvLoading =
      pinnedOwnerEnvironmentId !== undefined && loadingEnvironmentIds.has(pinnedOwnerEnvironmentId);
    if (!loaded || pinnedEnvLoading) {
      return (
        <div className="flex flex-1 items-center justify-center p-6">
          <Spinner />
        </div>
      );
    }
    if (props.surface.printerId !== undefined) {
      const pinnedName = props.surface.title ?? props.surface.printerId;
      return (
        <div className="scrollbar-gutter-both flex flex-1 flex-col items-center justify-center gap-3 overflow-y-auto p-6 text-center">
          <div className="flex size-11 items-center justify-center rounded-xl border border-border/70 bg-card text-muted-foreground">
            <Printer className="size-5" />
          </div>
          <div className="max-w-xs space-y-1">
            <h3 className="text-sm font-semibold text-foreground">
              {gt("{printer} is unavailable", { printer: pinnedName })}
            </h3>
            <p className="text-xs text-muted-foreground">
              {gt(
                "This pinned printer is removed or its hosting T3 Connect environment is disconnected. Commands are paused to avoid targeting a different printer.",
              )}
            </p>
          </div>
          {fleetPrinters.length > 0 ? (
            <div className="flex flex-wrap items-center justify-center gap-2">
              {fleetPrinters.slice(0, 3).map((entry) => (
                <Button
                  key={entry.key}
                  size="sm"
                  variant="outline"
                  onClick={() => handleSelectPrinter(entry.key)}
                >
                  {gt("Open {printer}", {
                    printer: entry.isProxied
                      ? `${entry.printer.label} (${entry.proxyEnvironmentLabel})`
                      : entry.printer.label,
                  })}
                </Button>
              ))}
            </div>
          ) : (
            <Button size="sm" onClick={openSettings}>
              <Settings className="size-3.5" />
              {gt("Configure 3D Printers")}
            </Button>
          )}
        </div>
      );
    }
    return (
      <div className="scrollbar-gutter-both flex flex-1 flex-col items-center justify-center gap-3 overflow-y-auto p-6 text-center">
        <div className="flex size-11 items-center justify-center rounded-xl border border-border/70 bg-card text-muted-foreground">
          <Printer className="size-5" />
        </div>
        <div className="max-w-xs space-y-1">
          <h3 className="text-sm font-semibold text-foreground">
            {state.enabled ? gt("No 3D printers configured") : gt("3D Printers")}
          </h3>
          <p className="text-xs text-muted-foreground">
            {state.enabled
              ? gt(
                  "Connect a Bambu Lab printer through Home Assistant, or a Klipper Moonraker or OctoPrint host.",
                )
              : gt(
                  "Enable 3D Printers in Settings to monitor live camera feeds, thermals, AMS spools, and slicer job progress inside T3 Code.",
                )}
          </p>
        </div>
        {stateError ? <p className="text-xs text-destructive">{stateError}</p> : null}
        <Button size="sm" onClick={openSettings}>
          <Settings className="size-3.5" />
          {gt("Configure 3D Printers")}
        </Button>
      </div>
    );
  };

  if (!activePrinter) {
    return (
      <PreviewPanelShell mode={props.mode}>
        <div className="flex min-h-0 flex-1 flex-col">{renderEmptyState()}</div>
      </PreviewPanelShell>
    );
  }

  const isJobActive = isActiveJobStatus(activePrinter.job.status);
  const progressPct = Math.max(0, Math.min(100, activePrinter.job.progressPercent ?? 0));
  const etaClock = formatClockTime(activePrinter.job.estimatedFinishAt);
  const statusLabel = !activePrinter.online
    ? gt("Offline")
    : activePrinter.job.status === "failed"
      ? gt("Failed")
      : (activePrinter.job.stageLabel ?? activePrinter.job.status);
  const hasErrorAlert = activePrinter.alerts.some((alert) => alert.severity === "error");
  const showChamberThermal = activePrinter.thermals.chamber !== undefined;

  const jobHud = isJobActive ? (
    <div className="space-y-2 rounded-lg border border-border/60 bg-card/60 p-2.5">
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0 flex-1 text-xs font-semibold text-foreground">
          <MiddleTruncate
            value={
              activePrinter.job.displayName ?? activePrinter.job.fileName ?? gt("Active print job")
            }
          />
        </div>
        <div className="shrink-0 text-xs font-semibold text-foreground tabular-nums">
          {activePrinter.job.progressPercent !== null ? `${progressPct}%` : "--"}
          {activePrinter.job.remainingSeconds !== null
            ? ` · ${formatDurationCompact(activePrinter.job.remainingSeconds)}`
            : ""}
          {etaClock ? ` · ~${etaClock}` : ""}
        </div>
      </div>

      <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
        <div
          className={cn(
            "h-full rounded-full transition-[width]",
            activePrinter.job.status === "pause" ? "bg-warning" : "bg-primary",
          )}
          style={{ width: `${progressPct}%` }}
        />
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2 text-2xs text-muted-foreground">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 tabular-nums">
          {activePrinter.job.currentLayer !== null && activePrinter.job.totalLayers !== null ? (
            <span>
              {gt("Layer {current}/{total}", {
                current: activePrinter.job.currentLayer,
                total: activePrinter.job.totalLayers,
              })}
            </span>
          ) : null}
          {activePrinter.job.stageLabel ? <span>· {activePrinter.job.stageLabel}</span> : null}
          {activePrinter.job.weightGrams !== null ? (
            <span>· {activePrinter.job.weightGrams.toFixed(1)} g</span>
          ) : null}
          {activePrinter.job.lengthMeters !== null ? (
            <span>· {activePrinter.job.lengthMeters.toFixed(1)} m</span>
          ) : null}
        </div>

        <div className="flex items-center gap-1">
          {activePrinter.capabilities.canPause ? (
            <Button
              size="xs"
              variant="outline"
              disabled={!canAction || pendingAction !== null}
              onClick={() =>
                void handleAction({
                  kind: "pause",
                  expectedJobFileName: activePrinter.job.fileName,
                  expectedJobStartedAt: activePrinter.job.startedAt,
                })
              }
            >
              <Pause className="size-3" />
              {gt("Pause")}
            </Button>
          ) : null}
          {activePrinter.capabilities.canResume ? (
            <Button
              size="xs"
              variant="outline"
              disabled={!canAction || pendingAction !== null}
              onClick={() =>
                void handleAction({
                  kind: "resume",
                  expectedJobFileName: activePrinter.job.fileName,
                  expectedJobStartedAt: activePrinter.job.startedAt,
                })
              }
            >
              <Play className="size-3" />
              {gt("Resume")}
            </Button>
          ) : null}
          {activePrinter.capabilities.canStop ? (
            <Button
              size="xs"
              variant="destructive-outline"
              disabled={!canAction || pendingAction !== null}
              onClick={() =>
                setStopTarget({
                  printerId: activePrinter.id,
                  printerLabel: activePrinter.label,
                  proxyEnvironmentId,
                  expectedJobFileName: activePrinter.job.fileName,
                  expectedJobStartedAt: activePrinter.job.startedAt,
                  displayName:
                    activePrinter.job.displayName ??
                    activePrinter.job.fileName ??
                    gt("the current job"),
                })
              }
            >
              <Square className="size-3" />
              {gt("Stop")}
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  ) : (
    <div className="flex items-center justify-between gap-2 rounded-lg border border-border/60 bg-card/40 px-2.5 py-2 text-xs text-muted-foreground">
      <div className="flex min-w-0 items-center gap-2">
        <Clock className="size-3.5 shrink-0" />
        <span className="truncate">
          {!activePrinter.online
            ? gt("Printer offline")
            : activePrinter.job.status === "unknown"
              ? gt("Status unknown · Waiting for printer readiness")
              : activePrinter.job.status === "failed"
                ? gt("Print failed or cancelled")
                : activePrinter.job.status === "finish" && activePrinter.job.displayName
                  ? gt("Finished · {job}", { job: activePrinter.job.displayName })
                  : activePrinter.job.lastCompletedJobName
                    ? gt("Idle · Last print: {job}", {
                        job: activePrinter.job.lastCompletedJobName,
                      })
                    : gt("Idle · Ready to print")}
        </span>
      </div>
      {activePrinter.hardware.nozzleSizeMm !== null ? (
        <span className="shrink-0 text-2xs tabular-nums">
          {activePrinter.hardware.nozzleSizeMm}mm
        </span>
      ) : null}
    </div>
  );

  const thermalCards = (
    <div className={cn("grid gap-2", showChamberThermal ? "grid-cols-3" : "grid-cols-2")}>
      <ThermalCard
        label={gt("Nozzle")}
        reading={activePrinter.thermals.nozzle}
        accentClass="bg-destructive"
        editable={activePrinter.capabilities.canSetTemps}
        presets={NOZZLE_PRESETS}
        disabled={!canAction || pendingAction !== null}
        onSetTarget={(targetC) => void handleAction({ kind: "setNozzleTemp", targetC })}
      />
      <ThermalCard
        label={gt("Bed")}
        reading={activePrinter.thermals.bed}
        defaultMaxC={120}
        accentClass="bg-warning"
        editable={activePrinter.capabilities.canSetTemps}
        presets={BED_PRESETS}
        disabled={!canAction || pendingAction !== null}
        onSetTarget={(targetC) => void handleAction({ kind: "setBedTemp", targetC })}
      />
      {showChamberThermal && activePrinter.thermals.chamber ? (
        <ThermalCard
          label={gt("Chamber")}
          reading={activePrinter.thermals.chamber}
          accentClass="bg-info"
          editable={false}
          presets={[]}
          disabled
        />
      ) : null}
    </div>
  );

  const objectsCard = (
    <PrinterObjectsCard
      objects={activePrinter.job.printableObjects}
      canSkip={canAction && activePrinter.capabilities.canSkipObjects}
      busy={pendingAction !== null}
      hasPickImage={activePrinter.media.hasPickImage}
      onSelectObject={() => setViewMode("pick")}
      onRequestSkip={(obj) =>
        setSkipTarget({
          printerId: activePrinter.id,
          proxyEnvironmentId,
          object: obj,
          jobFileName: activePrinter.job.fileName,
          jobStartedAt: activePrinter.job.startedAt,
        })
      }
    />
  );

  return (
    <PreviewPanelShell mode={props.mode}>
      <div
        ref={setContainerElement}
        className="@container flex min-h-0 flex-1 flex-col overflow-hidden"
      >
        {/* Compact 36px Header Strip */}
        <div className="flex h-9 shrink-0 items-center justify-between gap-2 border-b border-border/70 px-2.5">
          <div className="flex min-w-0 items-center gap-2">
            <span
              className={cn(
                "size-2 shrink-0 rounded-full",
                statusDotClass(activePrinter.job.status, activePrinter.online, hasErrorAlert),
              )}
            />
            {fleetPrinters.length > 1 && activeEntry ? (
              <Select value={activeEntry.key} onValueChange={handleSelectPrinter}>
                <SelectTrigger size="sm" className="max-w-44">
                  <SelectValue>{activePrinter.label}</SelectValue>
                </SelectTrigger>
                <SelectPopup>
                  {fleetPrinters.map((entry) => (
                    <SelectItem key={entry.key} value={entry.key}>
                      {entry.isProxied
                        ? `${entry.printer.label} · ${entry.proxyEnvironmentLabel}`
                        : entry.printer.label}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            ) : (
              <span className="truncate text-xs font-semibold text-foreground">
                {activePrinter.label}
              </span>
            )}
            <Badge size="sm" variant={statusBadgeVariant(activePrinter.job.status, hasErrorAlert)}>
              {statusLabel}
            </Badge>
            {activeEntry?.isProxied ? (
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Badge size="sm" variant="outline">
                      <Server className="size-2.5 shrink-0" />
                      <span className="max-w-24 truncate">
                        {gt("Via {environment}", {
                          environment: activeEntry.proxyEnvironmentLabel,
                        })}
                      </span>
                    </Badge>
                  }
                />
                <TooltipPopup>
                  {gt("Routed through {environment} via T3 Connect", {
                    environment: activeEntry.proxyEnvironmentLabel,
                  })}
                </TooltipPopup>
              </Tooltip>
            ) : null}
          </div>

          <div className="flex shrink-0 items-center gap-1">
            {activePrinter.hardware.wifiSignalDbm !== null ? (
              <Tooltip>
                <TooltipTrigger
                  render={
                    <span className="hidden items-center gap-1 px-1 text-2xs text-muted-foreground tabular-nums @[460px]:inline-flex">
                      <Wifi className="size-3" />
                      {activePrinter.hardware.wifiSignalDbm} dBm
                    </span>
                  }
                />
                <TooltipPopup>{gt("Printer Wi-Fi signal strength")}</TooltipPopup>
              </Tooltip>
            ) : null}

            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    size="icon-xs"
                    variant="ghost-muted"
                    disabled={refreshing}
                    aria-label={gt("Refresh printer telemetry")}
                    onClick={() => void handleRefresh()}
                  >
                    <RefreshCw className={cn("size-3.5", refreshing && "animate-spin")} />
                  </Button>
                }
              />
              <TooltipPopup>{gt("Refresh telemetry")}</TooltipPopup>
            </Tooltip>

            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    size="icon-xs"
                    variant="ghost-muted"
                    aria-label={gt("3D Printer settings")}
                    onClick={openSettings}
                  >
                    <Settings className="size-3.5" />
                  </Button>
                }
              />
              <TooltipPopup>{gt("3D Printer settings")}</TooltipPopup>
            </Tooltip>
          </div>
        </div>

        {/* Conditional Fault / Stale / Write-Blocked Banner */}
        {activePrinter.alerts.length > 0 ||
        (activePrinter.stale && Boolean(activePrinter.staleReason)) ||
        (activePrinter.online && activePrinter.hardware.controlBlocked) ? (
          <div className="shrink-0 space-y-1 border-b border-border/60 bg-muted/30 px-2.5 py-1.5 text-2xs">
            {activePrinter.alerts.slice(0, 2).map((alert) => (
              <div
                key={`${alert.code}:${alert.message}`}
                className={cn(
                  "flex items-start gap-1.5",
                  alert.severity === "error" ? "text-destructive" : "text-warning-foreground",
                )}
              >
                <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
                <span className="min-w-0 break-words font-medium">{alert.message}</span>
              </div>
            ))}
            {activePrinter.stale && activePrinter.staleReason ? (
              <div className="flex items-start gap-1.5 text-muted-foreground">
                <Info className="mt-0.5 size-3.5 shrink-0" />
                <span className="min-w-0 break-words">{activePrinter.staleReason}</span>
              </div>
            ) : null}
            {activePrinter.online && activePrinter.hardware.controlBlocked ? (
              <div className="flex items-start gap-1.5 text-warning-foreground">
                <Info className="mt-0.5 size-3.5 shrink-0" />
                <span className="min-w-0 break-words">
                  {activePrinter.hardware.controlBlockedReason ??
                    gt("Read-only mode: write controls are blocked by printer firmware.")}
                </span>
              </div>
            ) : null}
          </div>
        ) : null}

        {/* Responsive Slicer Cockpit Body (single-tree to avoid duplicate viewport polling) */}
        <div className="scrollbar-gutter-both min-h-0 flex-1 overflow-y-auto p-2.5">
          {isWide ? (
            <div className="grid grid-cols-[minmax(0,1.15fr)_minmax(300px,0.85fr)] gap-3">
              <div className="space-y-3">
                <PrinterViewport
                  key={`viewport:${activePrinterKey}`}
                  printer={activePrinter}
                  mediaAccess={mediaAccess}
                  visible={props.visible}
                  viewMode={viewMode}
                  onViewModeChange={setViewMode}
                  onMediaError={handleMediaError}
                  canControl={canAction}
                  lightPending={pendingAction === "setChamberLight"}
                  onToggleLight={() =>
                    void handleAction({
                      kind: "setChamberLight",
                      on: !activePrinter.lighting.chamberLight,
                    })
                  }
                />
                {jobHud}
                <PrinterThermalChart
                  history={activePrinter.thermals.history}
                  showChamber={showChamberThermal}
                />
                <PrinterDetailsSection printer={activePrinter} />
              </div>

              <div className="space-y-3">
                {thermalCards}
                <PrinterFilamentStrip filament={activePrinter.filament} />
                {objectsCard}
                <PrinterControlsDeck
                  key={`controls:${activePrinterKey}`}
                  printer={activePrinter}
                  canControl={canAction}
                  pendingAction={pendingAction}
                  onAction={(action) => void handleAction(action)}
                />
              </div>
            </div>
          ) : (
            <div className="space-y-2.5">
              <PrinterViewport
                key={`viewport:${activePrinterKey}`}
                printer={activePrinter}
                mediaAccess={mediaAccess}
                visible={props.visible}
                viewMode={viewMode}
                onViewModeChange={setViewMode}
                onMediaError={handleMediaError}
                canControl={canAction}
                lightPending={pendingAction === "setChamberLight"}
                onToggleLight={() =>
                  void handleAction({
                    kind: "setChamberLight",
                    on: !activePrinter.lighting.chamberLight,
                  })
                }
              />
              {jobHud}

              <ToggleGroup
                variant="segmented"
                className="w-full"
                value={[tab]}
                onValueChange={(values) => {
                  const next = values[0] as PrinterPanelTab | undefined;
                  if (next) setTab(next);
                }}
              >
                <Toggle value="monitor" className="flex-1">
                  {gt("Monitor")}
                </Toggle>
                <Toggle value="controls" className="flex-1">
                  {gt("Controls")}
                </Toggle>
                <Toggle value="details" className="flex-1">
                  {gt("Details")}
                </Toggle>
              </ToggleGroup>

              {tab === "monitor" ? (
                <div className="space-y-2.5">
                  {thermalCards}
                  <PrinterThermalChart
                    history={activePrinter.thermals.history}
                    showChamber={showChamberThermal}
                  />
                  <PrinterFilamentStrip filament={activePrinter.filament} />
                  {objectsCard}
                </div>
              ) : tab === "controls" ? (
                <PrinterControlsDeck
                  key={`controls:${activePrinterKey}`}
                  printer={activePrinter}
                  canControl={canAction}
                  pendingAction={pendingAction}
                  onAction={(action) => void handleAction(action)}
                />
              ) : (
                <PrinterDetailsSection printer={activePrinter} />
              )}
            </div>
          )}
        </div>
      </div>

      {/* Stop Print Confirmation Dialog (bound to the job captured when opened) */}
      <AlertDialog
        open={stopDialogValid}
        onOpenChange={(open) => {
          if (!open) setStopTarget(null);
        }}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>{gt("Stop active print?")}</AlertDialogTitle>
            <AlertDialogDescription>
              {gt("This cancels {job} on {printer}. The print cannot be resumed after stopping.", {
                job: stopTarget?.displayName ?? gt("the current job"),
                printer: stopTarget?.printerLabel ?? activePrinter.label,
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline">{gt("Keep printing")}</Button>} />
            <Button
              variant="destructive"
              onClick={() => {
                if (!stopTarget) return;
                const captured = stopTarget;
                setStopTarget(null);
                void handleAction(
                  {
                    kind: "stop",
                    expectedJobFileName: captured.expectedJobFileName,
                    expectedJobStartedAt: captured.expectedJobStartedAt,
                  },
                  {
                    printerId: captured.printerId,
                    proxyEnvironmentId: captured.proxyEnvironmentId,
                  },
                );
              }}
            >
              {gt("Stop print")}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>

      {/* Skip Object Confirmation Dialog */}
      <AlertDialog
        open={skipDialogValid}
        onOpenChange={(open) => {
          if (!open) setSkipTarget(null);
        }}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>{gt("Skip object for rest of print?")}</AlertDialogTitle>
            <AlertDialogDescription>
              {gt(
                "Skipping {object} prevents the printer from printing it on remaining layers. This cannot be undone during this print.",
                { object: skipTarget?.object.name ?? "" },
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline">{gt("Cancel")}</Button>} />
            <Button
              variant="destructive"
              onClick={() => {
                if (!skipTarget) return;
                const captured = skipTarget;
                setSkipTarget(null);
                void handleAction(
                  {
                    kind: "skipObjects",
                    objectIds: [captured.object.id],
                    ...(captured.jobFileName !== null
                      ? { expectedJobFileName: captured.jobFileName }
                      : {}),
                    ...(captured.jobStartedAt !== null
                      ? { expectedJobStartedAt: captured.jobStartedAt }
                      : {}),
                  },
                  {
                    printerId: captured.printerId,
                    proxyEnvironmentId: captured.proxyEnvironmentId,
                  },
                );
              }}
            >
              {gt("Skip object")}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </PreviewPanelShell>
  );
}
