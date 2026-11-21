import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import {
  type MoonrakerPrinterConfig,
  type PrinterAction,
  type PrinterAlert,
  type PrinterJobStatus,
  PrinterOperationError,
  type PrinterSnapshot,
  type PrinterSpeedProfile,
} from "@t3tools/contracts";

import {
  deriveStableJobStartedAt,
  detectImageMimeType,
  type PrinterAdapter,
} from "../PrinterAdapter.ts";
import {
  buildPrinterEndpoint,
  fetchPrinterBinary,
  fetchPrinterJson,
  fetchPrinterText,
  fingerprintBytes,
  validatePrinterBaseUrl,
} from "../PrinterUrlGuard.ts";

let jogStateSeq = 0;

interface MoonrakerQueryResponse {
  readonly result?: {
    readonly status?: {
      readonly print_stats?: {
        readonly state?: string;
        readonly filename?: string;
        readonly print_duration?: number;
        readonly filament_used?: number;
        readonly message?: string;
        readonly info?: {
          readonly current_layer?: number | null;
          readonly total_layer?: number | null;
        };
      };
      readonly display_status?: {
        readonly progress?: number;
      };
      readonly extruder?: {
        readonly temperature?: number;
        readonly target?: number;
      };
      readonly heater_bed?: {
        readonly temperature?: number;
        readonly target?: number;
      };
      readonly fan?: {
        readonly speed?: number;
      };
      readonly gcode_move?: {
        readonly speed_factor?: number;
      };
      readonly webhooks?: {
        readonly state?: string;
        readonly state_message?: string;
      };
    };
  };
}

const SPEED_FACTOR_BY_PROFILE: Readonly<Record<PrinterSpeedProfile, number>> = {
  silent: 50,
  standard: 100,
  sport: 125,
  ludicrous: 150,
};

function moonrakerHeaders(secret: string): Record<string, string> {
  return secret ? { "X-Api-Key": secret } : {};
}

function mapMoonrakerStatus(
  state: string | undefined,
  klipperState: string | undefined,
): PrinterJobStatus {
  if (klipperState === undefined) return "unknown";
  if (klipperState !== "ready") return "failed";
  switch (state?.toLowerCase()) {
    case "printing":
      return "running";
    case "paused":
      return "pause";
    case "complete":
      return "finish";
    case "error":
    case "cancelled":
      return "failed";
    case "standby":
      return "idle";
    default:
      return "unknown";
  }
}

function speedProfileFromFactor(factor: number | undefined): PrinterSpeedProfile | null {
  if (typeof factor !== "number" || !Number.isFinite(factor)) return null;
  const pct = Math.round(factor * 100);
  if (pct <= 60) return "silent";
  if (pct <= 110) return "standard";
  if (pct <= 140) return "sport";
  return "ludicrous";
}

function runMoonrakerGcode(
  baseUrl: URL,
  secret: string,
  script: string,
  printerId: string,
  operation: string,
) {
  return fetchPrinterText(
    buildPrinterEndpoint(baseUrl, `/printer/gcode/script?script=${encodeURIComponent(script)}`),
    {
      method: "POST",
      headers: moonrakerHeaders(secret),
      operation,
      printerId,
    },
  ).pipe(Effect.asVoid);
}

export const moonrakerAdapter: PrinterAdapter<MoonrakerPrinterConfig> = {
  poll: Effect.fn("MoonrakerAdapter.poll")(function* (config, secret, previous, cache) {
    const baseUrl = yield* validatePrinterBaseUrl(config.baseUrl, "poll", config.id);
    const queryPath =
      "/printer/objects/query?print_stats&display_status&extruder&heater_bed&fan&gcode_move&webhooks";
    const data = yield* fetchPrinterJson<MoonrakerQueryResponse>(
      buildPrinterEndpoint(baseUrl, queryPath),
      {
        headers: moonrakerHeaders(secret),
        operation: "moonraker.poll",
        printerId: config.id,
      },
    );

    const st = data.result?.status ?? {};
    const now = yield* DateTime.now;
    const nowMs = DateTime.toEpochMillis(now);
    const nowIso = DateTime.formatIso(now);
    const klipperState = st.webhooks?.state;
    const klipperReady = klipperState === "ready";
    const status = mapMoonrakerStatus(st.print_stats?.state, klipperState);
    const isActive = status === "running" || status === "pause" || status === "prepare";
    const progress =
      typeof st.display_status?.progress === "number"
        ? Math.round(st.display_status.progress * 100)
        : null;
    const elapsedSeconds =
      typeof st.print_stats?.print_duration === "number" && isActive
        ? Math.round(st.print_stats.print_duration)
        : null;
    const remainingSeconds =
      elapsedSeconds !== null && progress !== null && progress > 1 && progress < 100
        ? Math.round((elapsedSeconds * (100 - progress)) / progress)
        : null;

    const nozzleActual =
      typeof st.extruder?.temperature === "number"
        ? Math.round(st.extruder.temperature * 10) / 10
        : null;
    const nozzleTarget =
      typeof st.extruder?.target === "number" ? Math.round(st.extruder.target) : null;
    const bedActual =
      typeof st.heater_bed?.temperature === "number"
        ? Math.round(st.heater_bed.temperature * 10) / 10
        : null;
    const bedTarget =
      typeof st.heater_bed?.target === "number" ? Math.round(st.heater_bed.target) : null;

    const alerts: PrinterAlert[] = [];
    if (klipperState !== undefined && !klipperReady) {
      alerts.push({
        code: `KLIPPER_${klipperState.toUpperCase()}`,
        severity: "error",
        message: st.webhooks?.state_message || `Klipper firmware state: ${klipperState}`,
      });
    }
    if (st.print_stats?.message) {
      alerts.push({
        code: "PRINT_STATS",
        severity: "warning",
        message: st.print_stats.message,
      });
    }

    const previousHistory = previous?.thermals.history ?? [];
    const lastPoint = previousHistory.at(-1);
    const history =
      (nozzleActual !== null || bedActual !== null) &&
      (!lastPoint || nowMs - lastPoint.timestampMs >= 2_500)
        ? [
            ...previousHistory,
            {
              timestampMs: nowMs,
              nozzleActualC: nozzleActual,
              nozzleTargetC: nozzleTarget,
              bedActualC: bedActual,
              bedTargetC: bedTarget,
            },
          ].slice(-120)
        : previousHistory;

    const fileName = st.print_stats?.filename?.trim() || null;
    const displayName = fileName ? fileName.replace(/^.*\//, "").replace(/\.gcode$/i, "") : null;
    const speedFactor = st.gcode_move?.speed_factor;

    const snapshot: PrinterSnapshot = {
      id: config.id,
      label: config.label,
      kind: config.kind,
      connectionState: klipperReady ? "connected" : "degraded",
      online: true,
      lastSyncedAt: nowIso,
      lastUpdatedAt: nowIso,
      stale: false,
      hardware: {
        model: "Klipper / Moonraker",
        name: config.label,
        serial: null,
        firmware: `Klipper (${klipperState})`,
        ipAddress: baseUrl.hostname,
        nozzleSizeMm: null,
        nozzleType: null,
        bedType: null,
        totalUsageHours: null,
        wifiSignalDbm: null,
        sdCardStatus: null,
        connectionMode: "moonraker",
        controlBlocked: !klipperReady,
        ...(!klipperReady
          ? {
              controlBlockedReason: klipperState
                ? `Klipper is in ${klipperState} state.`
                : "Klipper readiness state is unavailable.",
            }
          : {}),
      },
      job: {
        status,
        stage: st.print_stats?.state ?? null,
        stageLabel:
          status === "running"
            ? "Printing"
            : status === "pause"
              ? "Paused"
              : status === "finish"
                ? "Finished"
                : status === "failed"
                  ? "Failed"
                  : status === "unknown"
                    ? "State unknown"
                    : "Idle",
        fileName,
        displayName,
        progressPercent: isActive || status === "finish" ? progress : null,
        currentLayer: st.print_stats?.info?.current_layer ?? null,
        totalLayers: st.print_stats?.info?.total_layer ?? null,
        remainingSeconds,
        elapsedSeconds,
        startedAt: deriveStableJobStartedAt({
          isActive,
          fileName,
          elapsedSeconds,
          previous,
          nowMs,
        }),
        estimatedFinishAt:
          remainingSeconds !== null
            ? DateTime.formatIso(DateTime.add(now, { seconds: remainingSeconds }))
            : null,
        weightGrams: null,
        lengthMeters:
          typeof st.print_stats?.filament_used === "number" && st.print_stats.filament_used > 0
            ? Math.round((st.print_stats.filament_used / 1000) * 100) / 100
            : null,
        timelapse: null,
        printableObjects: [],
      },
      thermals: {
        nozzle: { actualC: nozzleActual, targetC: nozzleTarget, minC: 0, maxC: 300 },
        bed: { actualC: bedActual, targetC: bedTarget, minC: 0, maxC: 120 },
        history,
      },
      fans: {
        coolingPercent: typeof st.fan?.speed === "number" ? Math.round(st.fan.speed * 100) : null,
        auxPercent: null,
        chamberPercent: null,
        heatbreakPercent: null,
      },
      lighting: { chamberLight: null },
      speed: {
        profile: speedProfileFromFactor(speedFactor),
        modifierPercent: typeof speedFactor === "number" ? Math.round(speedFactor * 100) : null,
      },
      filament: {
        extruderLoaded: null,
        externalSpool: null,
        amsUnits: [],
      },
      alerts,
      media: {
        hasCamera: Boolean(config.webcamUrl),
        hasCoverImage: false,
        hasPickImage: false,
        cameraUpdatedAt: config.webcamUrl ? nowIso : null,
        cameraStale: false,
        cameraRevision: (previous?.media.cameraRevision ?? 0) + 1,
        coverUpdatedAt: null,
      },
      capabilities: {
        canPause: klipperReady && status === "running",
        canResume: klipperReady && status === "pause",
        canStop: klipperReady && isActive,
        canSetTemps: klipperReady,
        canSetFans: klipperReady,
        canSetLight: false,
        canSetSpeed: klipperReady && isActive,
        canJog: klipperReady && (status === "idle" || status === "finish"),
        canSkipObjects: false,
      },
    };

    return { snapshot, cache };
  }),

  testConnection: Effect.fn("MoonrakerAdapter.testConnection")(function* (config, secret) {
    const baseUrl = yield* validatePrinterBaseUrl(config.baseUrl, "testConnection", config.id);
    const info = yield* fetchPrinterJson<{ readonly result?: { readonly klippy_state?: string } }>(
      buildPrinterEndpoint(baseUrl, "/server/info"),
      {
        headers: moonrakerHeaders(secret),
        operation: "moonraker.testConnection",
        printerId: config.id,
      },
    );
    const state = info.result?.klippy_state ?? "unknown";
    return {
      ok: true,
      model: "Klipper / Moonraker",
      printerName: config.label,
      online: true,
      hasCamera: Boolean(config.webcamUrl),
      hasCoverImage: false,
      summary: `Connected to Moonraker (Klipper state: ${state}).`,
    };
  }),

  executeAction: Effect.fn("MoonrakerAdapter.executeAction")(function* (
    config,
    secret,
    action: PrinterAction,
  ) {
    const baseUrl = yield* validatePrinterBaseUrl(config.baseUrl, action.kind, config.id);
    switch (action.kind) {
      case "pause":
        return yield* fetchPrinterText(buildPrinterEndpoint(baseUrl, "/printer/print/pause"), {
          method: "POST",
          headers: moonrakerHeaders(secret),
          operation: "moonraker.pause",
          printerId: config.id,
        }).pipe(Effect.asVoid);
      case "resume":
        return yield* fetchPrinterText(buildPrinterEndpoint(baseUrl, "/printer/print/resume"), {
          method: "POST",
          headers: moonrakerHeaders(secret),
          operation: "moonraker.resume",
          printerId: config.id,
        }).pipe(Effect.asVoid);
      case "stop":
        return yield* fetchPrinterText(buildPrinterEndpoint(baseUrl, "/printer/print/cancel"), {
          method: "POST",
          headers: moonrakerHeaders(secret),
          operation: "moonraker.stop",
          printerId: config.id,
        }).pipe(Effect.asVoid);
      case "setNozzleTemp":
        return yield* runMoonrakerGcode(
          baseUrl,
          secret,
          `M104 S${action.targetC}`,
          config.id,
          "moonraker.setNozzleTemp",
        );
      case "setBedTemp":
        return yield* runMoonrakerGcode(
          baseUrl,
          secret,
          `M140 S${action.targetC}`,
          config.id,
          "moonraker.setBedTemp",
        );
      case "setFanSpeed": {
        if (action.fan !== "cooling") {
          return yield* new PrinterOperationError({
            operation: "setFanSpeed",
            printerId: config.id,
            reason: `Moonraker only exposes the primary part cooling fan by default.`,
          });
        }
        const pwm = Math.round((action.percent / 100) * 255);
        return yield* runMoonrakerGcode(
          baseUrl,
          secret,
          `M106 S${pwm}`,
          config.id,
          "moonraker.setFanSpeed",
        );
      }
      case "setSpeedProfile":
        return yield* runMoonrakerGcode(
          baseUrl,
          secret,
          `M220 S${SPEED_FACTOR_BY_PROFILE[action.profile]}`,
          config.id,
          "moonraker.setSpeedProfile",
        );
      case "homeAxes":
        return yield* runMoonrakerGcode(baseUrl, secret, "G28", config.id, "moonraker.homeAxes");
      case "moveAxis": {
        const nowMs = (yield* DateTime.now).epochMilliseconds;
        const stateName = `T3_JOG_${nowMs.toString(36)}_${(++jogStateSeq).toString(36)}`;
        return yield* runMoonrakerGcode(
          baseUrl,
          secret,
          `SAVE_GCODE_STATE NAME=${stateName}\nG91\nG0 ${action.axis}${action.distanceMm} F3000\nRESTORE_GCODE_STATE NAME=${stateName}`,
          config.id,
          "moonraker.moveAxis",
        ).pipe(
          Effect.tapError(() =>
            // Best-effort restore on any failure (HTTP error, timeout, or connection drop after G91).
            // Unique per-attempt stateName ensures restoring a nonexistent state is harmless if the request never arrived.
            runMoonrakerGcode(
              baseUrl,
              secret,
              `RESTORE_GCODE_STATE NAME=${stateName}`,
              config.id,
              "moonraker.moveAxis.restore",
            ).pipe(Effect.ignore),
          ),
        );
      }
      case "refresh":
        return;
      case "setChamberLight":
      case "skipObjects":
        return yield* new PrinterOperationError({
          operation: action.kind,
          printerId: config.id,
          reason: `Action "${action.kind}" is not supported by the Moonraker adapter.`,
        });
    }
  }),

  fetchMedia: Effect.fn("MoonrakerAdapter.fetchMedia")(
    function* (config, secret, kind, current, cache) {
      if (kind !== "camera" || !config.webcamUrl) {
        return yield* new PrinterOperationError({
          operation: `media.${kind}`,
          printerId: config.id,
          reason: `Media asset "${kind}" is not configured for this Moonraker printer.`,
        });
      }
      const baseUrl = yield* validatePrinterBaseUrl(config.baseUrl, "moonraker.camera", config.id);
      const camUrl = yield* validatePrinterBaseUrl(
        config.webcamUrl,
        "moonraker.camera",
        config.id,
        {
          allowQuery: true,
        },
      );
      const result = yield* fetchPrinterBinary(camUrl, {
        // Never leak the printer API key to a different webcam origin.
        ...(camUrl.origin === baseUrl.origin ? { headers: moonrakerHeaders(secret) } : {}),
        operation: "moonraker.camera",
        printerId: config.id,
      });
      const contentType = detectImageMimeType(result.bytes);
      if (contentType === null) {
        return yield* new PrinterOperationError({
          operation: "moonraker.camera",
          printerId: config.id,
          reason: "Moonraker webcam endpoint returned a non-image payload.",
        });
      }
      const hash = fingerprintBytes(result.bytes);
      const nowIso = DateTime.formatIso(yield* DateTime.now);
      return {
        asset: {
          bytes: result.bytes,
          contentType,
          capturedAt: nowIso,
          stale: !(current?.online ?? true),
          online: current?.online ?? true,
          hash,
        },
        cache,
      };
    },
  ),
};
