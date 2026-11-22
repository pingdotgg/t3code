import * as DateTime from "effect/DateTime";
import type {
  BambuLanPrinterConfig,
  PrinterAlert,
  PrinterAmsUnit,
  PrinterJobStatus,
  PrinterSnapshot,
  PrinterSpeedProfile,
  PrinterSpool,
  PrinterThermalPoint,
} from "@t3tools/contracts";

import { decodeBambuHmsError, formatBambuStage, formatNozzleType } from "../BambuHmsCodes.ts";
import { deriveStableJobStartedAt } from "../PrinterAdapter.ts";
import type { BambuVersionInfo } from "./BambuSession.ts";

type JsonObject = Record<string, unknown>;

const isObject = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function num(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

/** Bambu's numeric print stages (`stg_cur`), as named by ha-bambulab's pybambu. */
const BAMBU_STAGE_NAMES: Readonly<Record<number, string>> = {
  0: "printing",
  1: "auto_bed_leveling",
  2: "heatbed_preheating",
  3: "sweeping_xy_mech_mode",
  4: "changing_filament",
  5: "m400_pause",
  6: "paused_filament_runout",
  7: "heating_hotend",
  8: "calibrating_extrusion",
  9: "scanning_bed_surface",
  10: "inspecting_first_layer",
  11: "identifying_build_plate_type",
  12: "calibrating_micro_lidar",
  13: "homing_toolhead",
  14: "cleaning_nozzle_tip",
  15: "checking_extruder_temperature",
  16: "paused_user",
  17: "paused_front_cover_falling",
  18: "calibrating_micro_lidar",
  19: "calibrating_extrusion_flow",
  20: "paused_nozzle_temperature_malfunction",
  21: "paused_heat_bed_temperature_malfunction",
  22: "filament_unloading",
  23: "paused_skipped_step",
  24: "filament_loading",
  25: "calibrating_motor_noise",
  26: "paused_ams_lost",
  27: "paused_low_fan_speed_heat_break",
  28: "paused_chamber_temperature_control_error",
  29: "cooling_chamber",
  30: "paused_user_gcode",
  31: "motor_noise_showoff",
  32: "paused_nozzle_filament_covered_detected",
  33: "paused_cutter_error",
  34: "paused_first_layer_error",
  35: "paused_nozzle_clog",
};

const SPEED_LEVELS: Readonly<Record<number, PrinterSpeedProfile>> = {
  1: "silent",
  2: "standard",
  3: "sport",
  4: "ludicrous",
};

export const SPEED_PROFILE_LEVEL: Readonly<Record<PrinterSpeedProfile, string>> = {
  silent: "1",
  standard: "2",
  sport: "3",
  ludicrous: "4",
};

/** Serial prefixes for models whose prefix is well established. Firmware reports the rest. */
const SERIAL_PREFIX_MODELS: ReadonlyArray<readonly [string, string]> = [
  ["00M", "Bambu Lab X1 Carbon"],
  ["03W", "Bambu Lab X1E"],
  ["01S", "Bambu Lab P1P"],
  ["01P", "Bambu Lab P1S"],
  ["030", "Bambu Lab A1 mini"],
  ["039", "Bambu Lab A1"],
];

export function bambuModelName(serial: string, version: BambuVersionInfo | null): string | null {
  if (version?.productName) return version.productName;
  const upper = serial.toUpperCase();
  return SERIAL_PREFIX_MODELS.find(([prefix]) => upper.startsWith(prefix))?.[1] ?? null;
}

/**
 * P1 and A1 printers serve camera frames on TCP 6000. X1, X2 and H2 printers stream RTSPS on
 * port 322 instead, which this adapter does not read yet.
 */
export function bambuUsesFrameCamera(model: string | null): boolean {
  if (!model) return true;
  return !/\b(X1|X1E|X1 Carbon|X2|H2)/i.test(model);
}

const MQTT_SIGNATURE_REQUIRED = 0x20000000n;
const FLAG3_AUTHORIZATION_CONTROL_ENABLED = 0x10;

/**
 * True when the printer only accepts signed commands from Bambu's own software, which is the
 * case unless it is in LAN only mode with Developer mode on.
 */
export function bambuControlsLocked(report: JsonObject): boolean {
  const fun = str(report.fun);
  if (fun && /^[0-9a-f]+$/i.test(fun)) {
    return (BigInt(`0x${fun}`) & MQTT_SIGNATURE_REQUIRED) !== 0n;
  }
  const flag3 = num(report.flag3);
  return flag3 !== null && (flag3 & FLAG3_AUTHORIZATION_CONTROL_ENABLED) !== 0;
}

export const BAMBU_CONTROLS_LOCKED_REASON =
  "Controls are off because the printer is not in Developer mode. Turn it on at the printer under Settings > LAN only > Developer mode to pause, stop or change temperatures here. The chamber light still works.";

function mapStatus(state: string | null): PrinterJobStatus {
  switch (state?.toUpperCase()) {
    case "IDLE":
      return "idle";
    case "PREPARE":
    case "SLICING":
    case "INIT":
      return "prepare";
    case "RUNNING":
      return "running";
    case "PAUSE":
      return "pause";
    case "FINISH":
      return "finish";
    case "FAILED":
      return "failed";
    default:
      return "unknown";
  }
}

const STATUS_LABELS: Readonly<Record<PrinterJobStatus, string>> = {
  idle: "Idle",
  prepare: "Preparing",
  running: "Printing",
  pause: "Paused",
  finish: "Finished",
  failed: "Failed",
  offline: "Offline",
  unknown: "Unknown",
};

/** Fan speeds arrive as steps from 0 to 15. */
function fanPercent(value: unknown): number | null {
  const steps = num(value);
  if (steps === null) return null;
  return Math.round((Math.max(0, Math.min(15, steps)) / 15) * 100);
}

function colorHex(raw: unknown): string | null {
  const value = str(raw);
  if (!value || !/^[0-9a-f]{6,8}$/i.test(value)) return null;
  return `#${value.slice(0, 6).toUpperCase()}`;
}

function spoolFromTray(
  tray: JsonObject,
  id: string,
  label: string,
  active: boolean,
  external: boolean,
): PrinterSpool {
  const material = str(tray.tray_type);
  const remain = num(tray.remain);
  return {
    id,
    label,
    material,
    colorHex: colorHex(tray.tray_color),
    remainingPercent: remain !== null && remain >= 0 ? remain : null,
    active,
    empty: material === null,
    ...(external ? { external: true } : {}),
  };
}

function amsUnits(report: JsonObject): ReadonlyArray<PrinterAmsUnit> {
  const ams = isObject(report.ams) ? report.ams : null;
  if (!ams || !Array.isArray(ams.ams)) return [];
  const trayNow = num(ams.tray_now);
  return ams.ams.filter(isObject).map((unit, unitIndex) => {
    const unitNumber = num(unit.id) ?? unitIndex;
    const trays = Array.isArray(unit.tray) ? unit.tray.filter(isObject) : [];
    return {
      id: `ams-${unitNumber + 1}`,
      label: `AMS ${unitNumber + 1}`,
      humidityIndex: num(unit.humidity_raw) ?? num(unit.humidity),
      temperatureC: num(unit.temp),
      trays: trays.map((tray, trayIndex) => {
        const trayNumber = num(tray.id) ?? trayIndex;
        return spoolFromTray(
          tray,
          `ams-${unitNumber + 1}-tray-${trayNumber + 1}`,
          `Slot ${trayNumber + 1}`,
          trayNow === unitNumber * 4 + trayNumber,
          false,
        );
      }),
    };
  });
}

function hmsAlerts(report: JsonObject): ReadonlyArray<PrinterAlert> {
  const alerts: PrinterAlert[] = [];
  if (Array.isArray(report.hms)) {
    for (const entry of report.hms.filter(isObject)) {
      const attr = num(entry.attr);
      const code = num(entry.code);
      if (attr === null || code === null) continue;
      const hex = (value: number) => value.toString(16).toUpperCase().padStart(4, "0");
      alerts.push(
        decodeBambuHmsError(
          `${hex(Math.floor(attr / 0x10000))}_${hex(attr & 0xffff)}_${hex(Math.floor(code / 0x10000))}_${hex(code & 0xffff)}`,
        ),
      );
    }
  }
  const printError = num(report.print_error);
  if (printError !== null && printError !== 0) {
    alerts.push({
      code: `PRINT_ERROR_${printError.toString(16).toUpperCase()}`,
      severity: "error",
      message: `The printer reported print error ${printError.toString(16).toUpperCase()}.`,
    });
  }
  return alerts;
}

export interface BambuSnapshotInput {
  readonly config: BambuLanPrinterConfig;
  readonly report: JsonObject | null;
  readonly version: BambuVersionInfo | null;
  readonly connected: boolean;
  readonly lastMessageAtMs: number | null;
  readonly connectionError: string | null;
  readonly previous: PrinterSnapshot | undefined;
  readonly nowMs: number;
}

/** Converts the merged printer report into the panel's snapshot. Pure, for testing. */
export function bambuReportToSnapshot(input: BambuSnapshotInput): PrinterSnapshot {
  const { config, previous, nowMs } = input;
  const report = input.report ?? {};
  const hasReport = input.report !== null;
  const online = input.connected && hasReport;
  const nowIso = DateTime.formatIso(DateTime.makeUnsafe(nowMs));
  const model = bambuModelName(config.serial, input.version);
  const locked = hasReport && bambuControlsLocked(report);

  const status: PrinterJobStatus = online ? mapStatus(str(report.gcode_state)) : "offline";
  const isActive = status === "running" || status === "pause" || status === "prepare";
  const stageId = num(report.stg_cur);
  const stageName =
    isActive && stageId !== null && stageId >= 0 ? (BAMBU_STAGE_NAMES[stageId] ?? null) : null;
  const stageLabel = formatBambuStage(stageName) ?? STATUS_LABELS[status];

  const remainingMinutes = num(report.mc_remaining_time);
  const remainingSeconds =
    isActive && remainingMinutes !== null ? Math.max(0, Math.round(remainingMinutes * 60)) : null;
  const fileName = str(report.gcode_file);
  const progress = num(report.mc_percent);
  const layer = num(report.layer_num);
  const totalLayers = num(report.total_layer_num);

  const nozzleActual = num(report.nozzle_temper);
  const nozzleTarget = num(report.nozzle_target_temper);
  const bedActual = num(report.bed_temper);
  const bedTarget = num(report.bed_target_temper);
  const chamberActual = num(report.chamber_temper);
  const round1 = (value: number | null) => (value === null ? null : Math.round(value * 10) / 10);

  const previousHistory = previous?.thermals.history ?? [];
  const lastPoint = previousHistory.at(-1);
  const history: ReadonlyArray<PrinterThermalPoint> =
    online && (!lastPoint || nowMs - lastPoint.timestampMs >= 2_500)
      ? [
          ...previousHistory,
          {
            timestampMs: nowMs,
            nozzleActualC: round1(nozzleActual),
            nozzleTargetC: nozzleTarget,
            bedActualC: round1(bedActual),
            bedTargetC: bedTarget,
            ...(chamberActual !== null ? { chamberActualC: round1(chamberActual) } : {}),
          },
        ].slice(-120)
      : previousHistory;

  const lights = Array.isArray(report.lights_report) ? report.lights_report.filter(isObject) : [];
  const chamberLight = lights.find((light) => light.node === "chamber_light");
  const speedLevel = num(report.spd_lvl);
  const ams = isObject(report.ams) ? report.ams : null;
  const trayNow = num(ams?.tray_now);
  const vtTray = isObject(report.vt_tray) ? report.vt_tray : null;
  const ipcam = isObject(report.ipcam) ? report.ipcam : null;
  const wifi = num(str(report.wifi_signal)?.replace(/dbm$/i, ""));
  const sdcard = report.sdcard;
  const frameCamera = bambuUsesFrameCamera(model);

  const canControl = online && !locked;
  const settledIdle = status === "idle" || status === "finish" || status === "failed";

  const staleReason = !input.connected
    ? (input.connectionError ?? "Connecting to the printer.")
    : !hasReport
      ? "Waiting for the first report from the printer."
      : undefined;

  return {
    id: config.id,
    label: config.label,
    kind: config.kind,
    connectionState: online ? "connected" : input.connectionError ? "error" : "offline",
    online,
    lastSyncedAt: nowIso,
    lastUpdatedAt:
      input.lastMessageAtMs !== null
        ? DateTime.formatIso(DateTime.makeUnsafe(input.lastMessageAtMs))
        : null,
    stale: !online,
    ...(staleReason ? { staleReason } : {}),
    ...(!online && input.connectionError ? { error: input.connectionError } : {}),
    hardware: {
      model,
      name: config.label,
      serial: config.serial,
      firmware: input.version?.firmware ?? null,
      ipAddress: (() => {
        try {
          return new URL(config.baseUrl).hostname;
        } catch {
          return null;
        }
      })(),
      nozzleSizeMm: num(report.nozzle_diameter),
      nozzleType: formatNozzleType(str(report.nozzle_type)),
      bedType: null,
      totalUsageHours: null,
      wifiSignalDbm: wifi,
      sdCardStatus: typeof sdcard === "boolean" ? (sdcard ? "normal" : "absent") : null,
      connectionMode: locked ? "local, read-only" : "local",
      controlBlocked: !canControl,
      ...(online && locked ? { controlBlockedReason: BAMBU_CONTROLS_LOCKED_REASON } : {}),
    },
    job: {
      status,
      stage: stageName ?? (online ? (str(report.gcode_state)?.toLowerCase() ?? null) : null),
      stageLabel: online ? stageLabel : null,
      fileName,
      displayName: str(report.subtask_name) ?? fileName,
      progressPercent: online && progress !== null ? progress : null,
      currentLayer: online && layer !== null ? Math.round(layer) : null,
      totalLayers:
        online && totalLayers !== null && totalLayers > 0 ? Math.round(totalLayers) : null,
      remainingSeconds,
      elapsedSeconds: null,
      startedAt: deriveStableJobStartedAt({
        isActive,
        fileName,
        elapsedSeconds: null,
        previous,
        nowMs,
      }),
      estimatedFinishAt:
        remainingSeconds !== null
          ? DateTime.formatIso(DateTime.makeUnsafe(nowMs + remainingSeconds * 1000))
          : null,
      weightGrams: null,
      lengthMeters: null,
      timelapse: ipcam ? str(ipcam.timelapse) === "enable" : null,
      printableObjects: [],
    },
    thermals: {
      nozzle: { actualC: round1(nozzleActual), targetC: nozzleTarget, minC: 0, maxC: 320 },
      bed: { actualC: round1(bedActual), targetC: bedTarget, minC: 0, maxC: 120 },
      ...(chamberActual !== null
        ? {
            chamber: { actualC: round1(chamberActual), targetC: num(report.chamber_target_temper) },
          }
        : {}),
      history,
    },
    fans: {
      coolingPercent: fanPercent(report.cooling_fan_speed),
      auxPercent: fanPercent(report.big_fan1_speed),
      chamberPercent: fanPercent(report.big_fan2_speed),
      heatbreakPercent: fanPercent(report.heatbreak_fan_speed),
    },
    lighting: { chamberLight: chamberLight ? str(chamberLight.mode) === "on" : null },
    speed: {
      profile: speedLevel !== null ? (SPEED_LEVELS[speedLevel] ?? null) : null,
      modifierPercent: num(report.spd_mag),
    },
    filament: {
      extruderLoaded: trayNow !== null ? trayNow !== 255 : null,
      externalSpool: vtTray
        ? spoolFromTray(vtTray, "external", "External spool", trayNow === 254, true)
        : null,
      amsUnits: amsUnits(report),
    },
    alerts: online ? hmsAlerts(report) : [],
    media: {
      hasCamera: frameCamera,
      hasCoverImage: false,
      hasPickImage: false,
      cameraUpdatedAt: frameCamera && online ? nowIso : null,
      cameraStale: !online,
      cameraRevision: (previous?.media.cameraRevision ?? 0) + (online && frameCamera ? 1 : 0),
      coverUpdatedAt: null,
    },
    capabilities: {
      canPause: canControl && status === "running",
      canResume: canControl && status === "pause",
      canStop: canControl && isActive,
      canSetTemps: canControl,
      canSetFans: canControl,
      // Bambu firmware accepts the chamber light from any client, even when other controls are locked.
      canSetLight: online && chamberLight !== undefined,
      canSetSpeed: canControl && isActive,
      canJog: canControl && settledIdle,
      canSkipObjects: false,
    },
  };
}
