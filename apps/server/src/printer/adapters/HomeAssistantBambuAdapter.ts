import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  type HomeAssistantBambuPrinterConfig,
  type PrinterAction,
  type PrinterAlert,
  type PrinterAmsUnit,
  type PrinterJobStatus,
  type PrinterObject,
  PrinterOperationError,
  type PrinterSnapshot,
  type PrinterSpeedProfile,
  type PrinterSpool,
} from "@t3tools/contracts";

import {
  decodeBambuHmsError,
  formatBambuStage,
  formatBedType,
  formatNozzleType,
} from "../BambuHmsCodes.ts";
import {
  detectImageMimeType,
  type PrinterAdapter,
  type PrinterRuntimeCache,
} from "../PrinterAdapter.ts";
import {
  buildPrinterEndpoint,
  fetchPrinterBinary,
  fetchPrinterJson,
  fetchPrinterText,
  fingerprintBytes,
  validatePrinterBaseUrl,
} from "../PrinterUrlGuard.ts";

const isPrinterOperationError = Schema.is(PrinterOperationError);

interface HaEntityState {
  readonly entity_id: string;
  readonly state: string;
  readonly attributes?: Readonly<Record<string, unknown>>;
  readonly last_reported?: string;
  readonly last_updated?: string;
  readonly last_changed?: string;
}

/** Max age of HA control-entity updates (`last_reported` or `last_updated`) before motion fails closed. */
const HA_CONTROL_STALE_MS = 5 * 60 * 1000;

function haEntityFreshnessMs(entity: HaEntityState | undefined): number | null {
  if (!entity) return null;
  for (const candidate of [entity.last_reported, entity.last_updated]) {
    if (typeof candidate === "string") {
      const parsed = Date.parse(candidate);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return null;
}

const SPEED_PROFILES: ReadonlySet<PrinterSpeedProfile> = new Set([
  "silent",
  "standard",
  "sport",
  "ludicrous",
]);

const SPEED_NUMERIC_MAP: Readonly<Record<string, PrinterSpeedProfile>> = {
  "1": "silent",
  "2": "standard",
  "3": "sport",
  "4": "ludicrous",
};

const SPEED_MODIFIERS: Readonly<Record<PrinterSpeedProfile, number>> = {
  silent: 50,
  standard: 100,
  sport: 124,
  ludicrous: 166,
};

function isUnsetHaState(raw: string | undefined | null): boolean {
  if (!raw) return true;
  const lower = raw.trim().toLowerCase();
  return lower === "" || lower === "unknown" || lower === "unavailable" || lower === "none";
}

function haNumber(entity: HaEntityState | undefined): number | null {
  if (!entity || isUnsetHaState(entity.state)) return null;
  const value = Number(entity.state);
  return Number.isFinite(value) ? value : null;
}

function haInt(entity: HaEntityState | undefined): number | null {
  const value = haNumber(entity);
  return value === null ? null : Math.round(value);
}

function haString(entity: HaEntityState | undefined): string | null {
  if (!entity || isUnsetHaState(entity.state)) return null;
  return entity.state.trim();
}

function haIsoTimestamp(entity: HaEntityState | undefined): string | null {
  const raw = haString(entity);
  if (!raw || !/^\d{4}-\d{2}-\d{2}/.test(raw)) return null;
  const parsedMs = Date.parse(raw);
  if (!Number.isFinite(parsedMs)) return null;
  return DateTime.formatIso(DateTime.makeUnsafe(parsedMs));
}

function haBoolean(entity: HaEntityState | undefined): boolean | null {
  if (!entity || isUnsetHaState(entity.state)) return null;
  const lower = entity.state.trim().toLowerCase();
  if (lower === "on" || lower === "true") return true;
  if (lower === "off" || lower === "false") return false;
  return null;
}

function normalizeColorHex(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim().replace(/^#/, "");
  if (/^[0-9a-fA-F]{8}$/.test(trimmed)) {
    // Bambu reports RRGGBBAA; #00000000 means unset/transparent.
    if (trimmed.slice(6, 8) === "00") return null;
    return `#${trimmed.slice(0, 6).toUpperCase()}`;
  }
  if (/^[0-9a-fA-F]{6}$/.test(trimmed)) {
    return `#${trimmed.toUpperCase()}`;
  }
  return null;
}

function normalizeJobStatus(raw: string | null, online: boolean): PrinterJobStatus {
  if (!online) return "offline";
  if (!raw) return "unknown";
  const lower = raw.trim().toLowerCase();
  switch (lower) {
    case "idle":
    case "prepare":
    case "running":
    case "pause":
    case "finish":
    case "failed":
    case "offline":
      return lower;
    case "paused":
      return "pause";
    case "finished":
    case "complete":
    case "completed":
      return "finish";
    case "printing":
      return "running";
    case "init":
    case "slicing":
      return "prepare";
    default:
      return "unknown";
  }
}

function normalizeSpeedProfile(raw: string | null): PrinterSpeedProfile | null {
  if (!raw) return null;
  const lower = raw.trim().toLowerCase();
  if (SPEED_PROFILES.has(lower as PrinterSpeedProfile)) {
    return lower as PrinterSpeedProfile;
  }
  return SPEED_NUMERIC_MAP[lower] ?? null;
}

function inferModelFromPrefixOrName(prefix: string, name: string | null): string | null {
  const source = `${name ?? ""} ${prefix}`.toUpperCase();
  const match = source.match(/\b(X1E|X1C|X1|P1S|P1P|P2S|A1[\s_-]?MINI|A1|H2D)\b/);
  if (!match) return null;
  return `Bambu Lab ${match[1]!.replace(/[_-]/g, " ")}`;
}

function cleanDisplayJobName(fileName: string | null, taskName: string | null): string | null {
  const raw = taskName || fileName;
  if (!raw) return null;
  return raw
    .replace(/^.*\//, "")
    .replace(/\.gcode\.3mf$/i, "")
    .replace(/\.gcode$/i, "")
    .replace(/\.3mf$/i, "")
    .replace(/[_]+/g, " ")
    .trim();
}

const HA_ENTITY_PREFIX_RE = /^[a-z0-9_]+$/;

function normalizeBambuEntityPrefix(raw: string | undefined): string | null {
  if (!raw) return null;
  const normalized = raw.trim().replace(/\.$/, "").toLowerCase();
  return HA_ENTITY_PREFIX_RE.test(normalized) ? normalized : null;
}

export function discoverBambuEntityPrefix(
  states: ReadonlyArray<HaEntityState>,
  configuredPrefix?: string,
): string | null {
  if (configuredPrefix?.trim()) {
    return normalizeBambuEntityPrefix(configuredPrefix);
  }
  for (const entity of states) {
    const match = entity.entity_id.match(/^sensor\.([a-z0-9_]+)_print_status$/);
    if (match?.[1]) return match[1];
  }
  for (const entity of states) {
    const match = entity.entity_id.match(/^sensor\.([a-z0-9_]+)_serial_number$/);
    if (match?.[1]) return match[1];
  }
  for (const entity of states) {
    const match = entity.entity_id.match(/^camera\.([a-z0-9_]+)_camera$/);
    if (match?.[1]) return match[1];
  }
  return null;
}

function parsePrintableObjects(
  printableEntity: HaEntityState | undefined,
  skippedEntity: HaEntityState | undefined,
): ReadonlyArray<PrinterObject> {
  const skippedIds = new Set<number>();
  const rawSkipped = skippedEntity?.attributes?.objects;
  if (Array.isArray(rawSkipped)) {
    for (const item of rawSkipped) {
      const num = Number(item);
      if (Number.isInteger(num)) skippedIds.add(num);
    }
  } else if (rawSkipped && typeof rawSkipped === "object") {
    for (const key of Object.keys(rawSkipped)) {
      const num = Number(key);
      if (Number.isInteger(num)) skippedIds.add(num);
    }
  }

  const objects: PrinterObject[] = [];
  const rawObjects = printableEntity?.attributes?.objects;
  if (rawObjects && typeof rawObjects === "object" && !Array.isArray(rawObjects)) {
    for (const [idStr, nameVal] of Object.entries(rawObjects)) {
      const id = Number(idStr);
      if (!Number.isInteger(id)) continue;
      objects.push({
        id,
        name: typeof nameVal === "string" && nameVal.trim() ? nameVal.trim() : `Object ${id}`,
        skipped: skippedIds.has(id),
      });
    }
  }
  return objects.sort((a, b) => a.id - b.id);
}

function parseHmsAndPrintAlerts(
  hmsEntity: HaEntityState | undefined,
  printErrorEntity: HaEntityState | undefined,
): ReadonlyArray<PrinterAlert> {
  const alerts: PrinterAlert[] = [];
  if (hmsEntity && haBoolean(hmsEntity) === true) {
    const attrs = hmsEntity.attributes ?? {};
    const indexed = new Map<string, { code?: string; error?: string }>();
    const unindexedCodes: string[] = [];

    for (const [key, value] of Object.entries(attrs)) {
      if (typeof value !== "string" || !value.trim()) continue;
      const trimmed = value.trim();
      const idxMatch = key.match(/^(\d+)-(?:error_)?(code|error)$/i);
      if (idxMatch) {
        const indexKey = idxMatch[1]!;
        const field = idxMatch[2]!.toLowerCase();
        const entry = indexed.get(indexKey) ?? {};
        if (field === "code") entry.code = trimmed;
        else entry.error = trimmed;
        indexed.set(indexKey, entry);
      } else if (key.toLowerCase().includes("code") || /hms/i.test(key)) {
        unindexedCodes.push(trimmed);
      }
    }

    for (const entry of indexed.values()) {
      if (entry.code) {
        const decoded = decodeBambuHmsError(entry.code);
        alerts.push({
          code: decoded.code,
          severity: decoded.severity,
          message: entry.error ?? decoded.message,
        });
      } else if (entry.error) {
        alerts.push({
          code: "HMS_ALERT",
          severity: "warning",
          message: entry.error,
        });
      }
    }

    for (const rawCode of unindexedCodes) {
      alerts.push(decodeBambuHmsError(rawCode));
    }

    if (alerts.length === 0) {
      const count = typeof attrs.Count === "number" ? attrs.Count : 1;
      alerts.push({
        code: "HMS_ACTIVE",
        severity: "warning",
        message: `${count} active printer health alert${count === 1 ? "" : "s"}`,
      });
    }
  }
  if (printErrorEntity && haBoolean(printErrorEntity) === true) {
    const code =
      typeof printErrorEntity.attributes?.code === "string"
        ? printErrorEntity.attributes.code
        : "PRINT_ERROR";
    const description =
      typeof printErrorEntity.attributes?.description === "string"
        ? printErrorEntity.attributes.description
        : "Printer reported a print error";
    alerts.push({
      code,
      severity: "error",
      message: description,
    });
  }
  return alerts;
}

function parseSpoolFromEntity(
  id: string,
  label: string,
  entity: HaEntityState,
  activeOverride: boolean | null,
  external: boolean,
): PrinterSpool {
  const attrs = entity.attributes ?? {};
  const stateLabel = haString(entity);
  const nonEmptyAttr = (value: unknown): string | null => {
    if (typeof value !== "string") return null;
    const trimmed = value.trim();
    if (!trimmed || trimmed.toLowerCase() === "empty" || trimmed.toLowerCase() === "unknown") {
      return null;
    }
    return trimmed;
  };
  const rawMaterial =
    nonEmptyAttr(attrs.type) ??
    nonEmptyAttr(attrs.name) ??
    (stateLabel && stateLabel.toLowerCase() !== "empty" ? stateLabel : null);
  const active =
    activeOverride !== null
      ? activeOverride
      : typeof attrs.active === "boolean"
        ? attrs.active
        : false;
  const emptyAttr = typeof attrs.empty === "boolean" ? attrs.empty : null;
  const empty = active
    ? false
    : emptyAttr !== null
      ? emptyAttr && rawMaterial === null
      : stateLabel?.toLowerCase() === "empty" && rawMaterial === null;
  const remainRaw = attrs.remain;
  const remainingPercent =
    typeof remainRaw === "number" &&
    Number.isFinite(remainRaw) &&
    remainRaw >= 0 &&
    remainRaw <= 100
      ? Math.round(remainRaw)
      : null;

  return {
    id,
    label,
    material: rawMaterial,
    colorHex: normalizeColorHex(attrs.color),
    remainingPercent,
    active,
    empty,
    ...(external ? { external: true } : {}),
  };
}

function parseFilament(
  prefix: string,
  byId: ReadonlyMap<string, HaEntityState>,
): {
  readonly extruderLoaded: boolean | null;
  readonly externalSpool: PrinterSpool | null;
  readonly amsUnits: ReadonlyArray<PrinterAmsUnit>;
} {
  const extruderLoaded = haBoolean(byId.get(`binary_sensor.${prefix}_extruder_filament`));
  const extActive = haBoolean(byId.get(`binary_sensor.${prefix}_externalspool_active`));
  const extEntity =
    byId.get(`sensor.${prefix}_externalspool_external_spool`) ??
    byId.get(`sensor.${prefix}_external_spool`);

  const externalSpool = extEntity
    ? parseSpoolFromEntity("external", "External Spool", extEntity, extActive, true)
    : extActive !== null
      ? {
          id: "external",
          label: "External Spool",
          material: null,
          colorHex: null,
          remainingPercent: null,
          active: extActive,
          empty: !extActive,
          external: true,
        }
      : null;

  const amsMap = new Map<
    string,
    {
      humidityIndex: number | null;
      temperatureC: number | null;
      trays: Array<{ index: number; spool: PrinterSpool }>;
    }
  >();

  const amsTrayPattern = new RegExp(`^sensor\\.${prefix}_ams_(\\d+)_tray_(\\d+)$`);
  const amsHumidityPattern = new RegExp(`^sensor\\.${prefix}_ams_(\\d+)_humidity(?:_index)?$`);
  const amsTempPattern = new RegExp(`^sensor\\.${prefix}_ams_(\\d+)_ams_temperature$`);

  for (const [entityId, entity] of byId.entries()) {
    const trayMatch = entityId.match(amsTrayPattern);
    if (trayMatch) {
      const amsIdx = trayMatch[1]!;
      const trayIdx = Number(trayMatch[2]!);
      const entry = amsMap.get(amsIdx) ?? { humidityIndex: null, temperatureC: null, trays: [] };
      entry.trays.push({
        index: trayIdx,
        spool: parseSpoolFromEntity(
          `ams-${amsIdx}-tray-${trayIdx}`,
          `Slot ${trayIdx}`,
          entity,
          null,
          false,
        ),
      });
      amsMap.set(amsIdx, entry);
      continue;
    }
    const humMatch = entityId.match(amsHumidityPattern);
    if (humMatch) {
      const amsIdx = humMatch[1]!;
      const entry = amsMap.get(amsIdx) ?? { humidityIndex: null, temperatureC: null, trays: [] };
      entry.humidityIndex = haNumber(entity);
      amsMap.set(amsIdx, entry);
      continue;
    }
    const tempMatch = entityId.match(amsTempPattern);
    if (tempMatch) {
      const amsIdx = tempMatch[1]!;
      const entry = amsMap.get(amsIdx) ?? { humidityIndex: null, temperatureC: null, trays: [] };
      entry.temperatureC = haNumber(entity);
      amsMap.set(amsIdx, entry);
    }
  }

  const amsUnits: PrinterAmsUnit[] = [...amsMap.entries()]
    .sort(([a], [b]) => Number(a) - Number(b))
    .map(([amsIdx, data]) => ({
      id: `ams-${amsIdx}`,
      label: `AMS ${amsIdx}`,
      humidityIndex: data.humidityIndex,
      temperatureC: data.temperatureC,
      trays: data.trays.sort((a, b) => a.index - b.index).map((item) => item.spool),
    }));

  return { extruderLoaded, externalSpool, amsUnits };
}

function haHeaders(secret: string): Record<string, string> {
  return secret
    ? {
        Authorization: `Bearer ${secret}`,
        "Content-Type": "application/json",
      }
    : { "Content-Type": "application/json" };
}

function callHaService(
  baseUrl: URL,
  secret: string,
  domain: string,
  service: string,
  payload: Readonly<Record<string, unknown>>,
  printerId: string,
) {
  return fetchPrinterText(buildPrinterEndpoint(baseUrl, `/api/services/${domain}/${service}`), {
    method: "POST",
    headers: haHeaders(secret),
    body: JSON.stringify(payload),
    operation: `ha.${domain}.${service}`,
    printerId,
  }).pipe(Effect.asVoid);
}

const lookupHaDeviceIdForPrefix = Effect.fn("HomeAssistantBambuAdapter.lookupHaDeviceIdForPrefix")(
  function* (baseUrl: URL, secret: string, prefix: string, printerId: string) {
    if (!HA_ENTITY_PREFIX_RE.test(prefix)) {
      return yield* new PrinterOperationError({
        operation: "ha.resolveDeviceId",
        printerId,
        reason: "Invalid Home Assistant entity prefix.",
      });
    }
    const text = yield* fetchPrinterText(buildPrinterEndpoint(baseUrl, "/api/template"), {
      method: "POST",
      headers: haHeaders(secret),
      body: `{"template":"{{ device_id('sensor.${prefix}_print_status') or '' }}"}`,
      operation: "ha.resolveDeviceId",
      printerId,
    });
    const trimmed = text.trim();
    return trimmed && trimmed !== "None" ? trimmed : undefined;
  },
);

const resolveVerifiedHaDeviceId = Effect.fn("HomeAssistantBambuAdapter.resolveVerifiedHaDeviceId")(
  function* (options: {
    readonly baseUrl: URL;
    readonly secret: string;
    readonly prefix: string;
    readonly configuredDeviceId: string | undefined;
    readonly cachedDeviceId: string | undefined;
    readonly cachedDeviceIdPrefix: string | undefined;
    readonly printerId: string;
    readonly operation: string;
    readonly bypassCache?: boolean;
  }) {
    const configured = options.configuredDeviceId?.trim() || undefined;
    const pollBoundDeviceId =
      options.cachedDeviceIdPrefix === options.prefix && options.cachedDeviceId?.trim()
        ? options.cachedDeviceId.trim()
        : undefined;

    // Already verified against HA for this exact entity prefix (only when live revalidation is not required).
    if (
      !options.bypassCache &&
      pollBoundDeviceId &&
      (!configured || configured === pollBoundDeviceId)
    ) {
      return pollBoundDeviceId;
    }

    const resolvedFromHa = yield* lookupHaDeviceIdForPrefix(
      options.baseUrl,
      options.secret,
      options.prefix,
      options.printerId,
    );

    if (configured) {
      if (!resolvedFromHa) {
        return yield* new PrinterOperationError({
          operation: options.operation,
          printerId: options.printerId,
          reason: `Could not verify that configured Home Assistant device_id matches entity prefix "${options.prefix}".`,
        });
      }
      if (resolvedFromHa !== configured) {
        return yield* new PrinterOperationError({
          operation: options.operation,
          printerId: options.printerId,
          reason: `Configured Home Assistant device_id does not match entity prefix "${options.prefix}".`,
        });
      }
      return configured;
    }

    if (options.bypassCache) {
      if (!pollBoundDeviceId || !resolvedFromHa || resolvedFromHa !== pollBoundDeviceId) {
        return yield* new PrinterOperationError({
          operation: options.operation,
          printerId: options.printerId,
          reason: `Home Assistant device_id for entity prefix "${options.prefix}" changed or could not be verified against the safety poll.`,
        });
      }
    }

    return resolvedFromHa;
  },
);

export function parseHomeAssistantBambuStates(input: {
  readonly config: HomeAssistantBambuPrinterConfig;
  readonly states: ReadonlyArray<HaEntityState>;
  readonly previous: PrinterSnapshot | undefined;
  readonly cache: PrinterRuntimeCache;
  readonly nowMs: number;
  readonly nowIso: string;
}): { readonly snapshot: PrinterSnapshot; readonly cache: PrinterRuntimeCache } {
  const { config, states, previous, cache, nowMs, nowIso } = input;
  const prefix = discoverBambuEntityPrefix(states, config.entityPrefix ?? cache.entityPrefix);

  if (!prefix) {
    throw new PrinterOperationError({
      operation: "poll",
      printerId: config.id,
      reason:
        "No Bambu Lab entities were found in Home Assistant. Check that the bambu_lab integration is installed or set an explicit entity prefix.",
    });
  }

  const byId = new Map<string, HaEntityState>();
  const prefixMatches: HaEntityState[] = [];
  for (const entity of states) {
    byId.set(entity.entity_id, entity);
    if (entity.entity_id.includes(`.${prefix}_`)) {
      prefixMatches.push(entity);
    }
  }

  const onlineEntity = byId.get(`binary_sensor.${prefix}_online`);
  const printStatusEntity = byId.get(`sensor.${prefix}_print_status`);
  const online =
    onlineEntity !== undefined
      ? haBoolean(onlineEntity) === true
      : !isUnsetHaState(printStatusEntity?.state) &&
        printStatusEntity?.state.toLowerCase() !== "offline";

  const status = normalizeJobStatus(haString(printStatusEntity), online);
  const rawStage = haString(byId.get(`sensor.${prefix}_current_stage`));
  const stageLabel = formatBambuStage(rawStage);

  const gcodeFile = haString(byId.get(`sensor.${prefix}_gcode_filename`));
  const taskName = haString(byId.get(`sensor.${prefix}_task_name`));
  const isJobActive = status === "running" || status === "prepare" || status === "pause";
  const displayName = cleanDisplayJobName(gcodeFile, taskName);

  // Track last completed job name and reset active-only job metrics on job rollover.
  let lastCompletedJobName =
    cache.lastCompletedJobName ?? previous?.job.lastCompletedJobName ?? null;
  if (status === "finish" && displayName) {
    lastCompletedJobName = displayName;
  } else if (
    previous?.job.status === "running" &&
    (status === "idle" || status === "finish") &&
    previous.job.displayName
  ) {
    lastCompletedJobName = previous.job.displayName;
  }

  const remainingEntity = byId.get(`sensor.${prefix}_remaining_time`);
  const remainingRaw = haNumber(remainingEntity);
  const remainingUnit = String(
    remainingEntity?.attributes?.unit_of_measurement ?? "h",
  ).toLowerCase();
  const remainingSeconds =
    remainingRaw === null
      ? null
      : remainingUnit === "min" || remainingUnit === "m"
        ? Math.round(remainingRaw * 60)
        : remainingUnit === "s"
          ? Math.round(remainingRaw)
          : Math.round(remainingRaw * 3600);

  const startedAt = haIsoTimestamp(byId.get(`sensor.${prefix}_start_time`));
  const estimatedFinishAt = haIsoTimestamp(byId.get(`sensor.${prefix}_end_time`));
  const elapsedSeconds =
    isJobActive && startedAt !== null
      ? Math.max(0, Math.round((nowMs - Date.parse(startedAt)) / 1000))
      : null;

  const nozzleTemp = haNumber(byId.get(`sensor.${prefix}_nozzle_temperature`));
  const nozzleTargetEntity =
    byId.get(`number.${prefix}_nozzle_target_temperature`) ??
    byId.get(`sensor.${prefix}_nozzle_target_temperature`);
  const nozzleTarget = haNumber(nozzleTargetEntity);
  const nozzleMin =
    typeof nozzleTargetEntity?.attributes?.min === "number" ? nozzleTargetEntity.attributes.min : 0;
  const nozzleMax =
    typeof nozzleTargetEntity?.attributes?.max === "number"
      ? nozzleTargetEntity.attributes.max
      : 320;

  const bedTemp = haNumber(byId.get(`sensor.${prefix}_bed_temperature`));
  const bedTargetEntity =
    byId.get(`number.${prefix}_bed_target_temperature`) ??
    byId.get(`sensor.${prefix}_bed_target_temperature`);
  const bedTarget = haNumber(bedTargetEntity);
  const bedMin =
    typeof bedTargetEntity?.attributes?.min === "number" ? bedTargetEntity.attributes.min : 0;
  const bedMax =
    typeof bedTargetEntity?.attributes?.max === "number" ? bedTargetEntity.attributes.max : 120;

  // Only include chamber reading if the printer actually reports a chamber sensor (P1S has none natively).
  const chamberTempEntity = byId.get(`sensor.${prefix}_chamber_temperature`);
  const chamberTemp = haNumber(chamberTempEntity);
  const chamberTarget = haNumber(byId.get(`number.${prefix}_chamber_target_temperature`));
  const hasChamberThermal = chamberTemp !== null || chamberTarget !== null;

  const fanPercent = (fanEntityId: string, sensorEntityId: string): number | null => {
    const fanEntity = byId.get(fanEntityId);
    if (fanEntity && !isUnsetHaState(fanEntity.state)) {
      const pct = fanEntity.attributes?.percentage;
      if (typeof pct === "number" && Number.isFinite(pct)) return Math.round(pct);
      if (fanEntity.state === "off") return 0;
    }
    return haInt(byId.get(sensorEntityId));
  };

  const coolingPercent = fanPercent(
    `fan.${prefix}_cooling_fan`,
    `sensor.${prefix}_cooling_fan_speed`,
  );
  const auxPercent = fanPercent(`fan.${prefix}_aux_fan`, `sensor.${prefix}_aux_fan_speed`);
  const chamberFanPercent = fanPercent(
    `fan.${prefix}_chamber_fan`,
    `sensor.${prefix}_chamber_fan_speed`,
  );
  const heatbreakPercent = haInt(byId.get(`sensor.${prefix}_heatbreak_fan_speed`));

  const chamberLightEntity = byId.get(`light.${prefix}_chamber_light`);
  const chamberLight = haBoolean(chamberLightEntity);

  const speedSelectEntity = byId.get(`select.${prefix}_printing_speed`);
  const speedSensorEntity = byId.get(`sensor.${prefix}_speed_profile`);
  const speedProfile =
    normalizeSpeedProfile(haString(speedSelectEntity)) ??
    normalizeSpeedProfile(haString(speedSensorEntity));
  const rawSpeedModifier = speedSensorEntity?.attributes?.modifier;
  const modifierPercent =
    typeof rawSpeedModifier === "number" && Number.isFinite(rawSpeedModifier)
      ? rawSpeedModifier
      : speedProfile
        ? SPEED_MODIFIERS[speedProfile]
        : null;

  const printerName = haString(byId.get(`sensor.${prefix}_printer_name`));
  const serial = haString(byId.get(`sensor.${prefix}_serial_number`));
  const controlBlocked =
    haBoolean(byId.get(`binary_sensor.${prefix}_hybrid_mqtt_control_blocked`)) === true;

  const cameraEntity = byId.get(`camera.${prefix}_camera`);
  const cameraSwitch = byId.get(`switch.${prefix}_camera`);
  const coverEntity = byId.get(`image.${prefix}_cover_image`);
  const pickEntity = byId.get(`image.${prefix}_pick_image`);
  const hasCamera = cameraEntity !== undefined && haBoolean(cameraSwitch) !== false;
  const hasCoverImage = coverEntity !== undefined && !isUnsetHaState(coverEntity.state);
  const hasPickImage = pickEntity !== undefined && !isUnsetHaState(pickEntity.state);

  const newestUpdatedAt =
    prefixMatches
      .map((entity) => entity.last_updated)
      .filter((ts): ts is string => typeof ts === "string" && Number.isFinite(Date.parse(ts)))
      .sort()
      .at(-1) ?? null;

  const cameraEntityHealthy =
    online &&
    hasCamera &&
    !isUnsetHaState(cameraEntity?.state) &&
    cameraEntity?.state.toLowerCase() !== "off";
  const cameraHashStale =
    status === "running" &&
    cache.lastCameraChangedAtMs !== undefined &&
    nowMs - cache.lastCameraChangedAtMs > 30_000;
  const cameraStale = !cameraEntityHealthy || cameraHashStale;

  const onlineTsMs = haEntityFreshnessMs(onlineEntity);
  const printStatusTsMs = haEntityFreshnessMs(printStatusEntity);
  const controlTimestampsFresh =
    printStatusTsMs !== null &&
    nowMs - printStatusTsMs <= HA_CONTROL_STALE_MS &&
    (onlineEntity === undefined ||
      (onlineTsMs !== null && nowMs - onlineTsMs <= HA_CONTROL_STALE_MS));

  const stale = !online || status === "offline" || status === "unknown" || !controlTimestampsFresh;
  const staleReason = !online
    ? "Printer is offline; displayed metrics and camera frame may be from the last session."
    : status === "unknown"
      ? "Home Assistant reported an unknown printer state."
      : !controlTimestampsFresh
        ? "Home Assistant control telemetry (online/print status) is missing or stale; motion controls are locked."
        : undefined;

  const filament = parseFilament(prefix, byId);
  const alerts = parseHmsAndPrintAlerts(
    byId.get(`binary_sensor.${prefix}_hms_errors`),
    byId.get(`binary_sensor.${prefix}_print_error`),
  );

  const previousHistory = previous?.thermals.history ?? [];
  const nextPoint =
    nozzleTemp !== null || bedTemp !== null
      ? {
          timestampMs: nowMs,
          nozzleActualC: nozzleTemp,
          nozzleTargetC: nozzleTarget,
          bedActualC: bedTemp,
          bedTargetC: bedTarget,
          ...(hasChamberThermal ? { chamberActualC: chamberTemp } : {}),
        }
      : null;
  const lastPoint = previousHistory.at(-1);
  const history =
    nextPoint && (!lastPoint || nowMs - lastPoint.timestampMs >= 2_500)
      ? [...previousHistory, nextPoint].slice(-120)
      : previousHistory;

  const pauseButton = byId.get(`button.${prefix}_pause`);
  const resumeButton = byId.get(`button.${prefix}_resume`);
  const stopButton = byId.get(`button.${prefix}_stop`);
  const canControl = online && !controlBlocked;
  const printableObjects = parsePrintableObjects(
    byId.get(`sensor.${prefix}_printable_objects`),
    byId.get(`sensor.${prefix}_skipped_objects`),
  );

  const snapshot: PrinterSnapshot = {
    id: config.id,
    label: config.label,
    kind: config.kind,
    connectionState: online
      ? alerts.some((a) => a.severity === "error")
        ? "degraded"
        : "connected"
      : "offline",
    online,
    lastSyncedAt: nowIso,
    lastUpdatedAt: newestUpdatedAt,
    stale,
    ...(staleReason ? { staleReason } : {}),
    hardware: {
      model: inferModelFromPrefixOrName(prefix, printerName),
      name: printerName,
      serial,
      firmware: haString(byId.get(`sensor.${prefix}_firmware_version`)),
      ipAddress: haString(byId.get(`sensor.${prefix}_ip_address`)),
      nozzleSizeMm: haNumber(byId.get(`sensor.${prefix}_nozzle_size`)),
      nozzleType: formatNozzleType(haString(byId.get(`sensor.${prefix}_nozzle_type`))),
      bedType: formatBedType(haString(byId.get(`sensor.${prefix}_print_bed_type`))),
      totalUsageHours: haNumber(byId.get(`sensor.${prefix}_total_usage`)),
      wifiSignalDbm: haInt(byId.get(`sensor.${prefix}_wi_fi_signal`)),
      sdCardStatus: haString(byId.get(`sensor.${prefix}_sd_card_status`)),
      connectionMode: haString(byId.get(`sensor.${prefix}_mqtt_connection_mode`)),
      controlBlocked,
      ...(controlBlocked
        ? {
            controlBlockedReason:
              "Bambu hybrid MQTT control is blocked by firmware authorization mode.",
          }
        : {}),
    },
    job: {
      status,
      stage: rawStage,
      stageLabel,
      fileName: gcodeFile,
      displayName,
      progressPercent:
        isJobActive || status === "finish"
          ? haInt(byId.get(`sensor.${prefix}_print_progress`))
          : null,
      currentLayer:
        isJobActive || status === "finish"
          ? haInt(byId.get(`sensor.${prefix}_current_layer`))
          : null,
      totalLayers:
        isJobActive || status === "finish"
          ? haInt(byId.get(`sensor.${prefix}_total_layer_count`))
          : null,
      remainingSeconds: isJobActive ? remainingSeconds : null,
      elapsedSeconds,
      startedAt: isJobActive ? startedAt : null,
      estimatedFinishAt: isJobActive ? estimatedFinishAt : null,
      weightGrams: haNumber(byId.get(`sensor.${prefix}_print_weight`)),
      lengthMeters: haNumber(byId.get(`sensor.${prefix}_print_length`)),
      timelapse: haBoolean(byId.get(`binary_sensor.${prefix}_timelapse`)),
      printableObjects: isJobActive ? printableObjects : [],
      lastCompletedJobName,
    },
    thermals: {
      nozzle: {
        actualC: nozzleTemp,
        targetC: nozzleTarget,
        minC: nozzleMin,
        maxC: nozzleMax,
      },
      bed: {
        actualC: bedTemp,
        targetC: bedTarget,
        minC: bedMin,
        maxC: bedMax,
      },
      ...(hasChamberThermal
        ? {
            chamber: {
              actualC: chamberTemp,
              targetC: chamberTarget,
            },
          }
        : {}),
      history,
    },
    fans: {
      coolingPercent,
      auxPercent,
      chamberPercent: chamberFanPercent,
      heatbreakPercent,
    },
    lighting: {
      chamberLight,
    },
    speed: {
      profile: speedProfile,
      modifierPercent,
    },
    filament,
    alerts,
    media: {
      hasCamera,
      hasCoverImage: hasCoverImage && (isJobActive || status === "finish"),
      hasPickImage: hasPickImage && isJobActive,
      cameraUpdatedAt: (() => {
        const entityIso = cameraEntity?.last_updated ?? null;
        const entityMs = entityIso ? Date.parse(entityIso) : Number.NaN;
        const frameMs = cache.lastCameraChangedAtMs;
        if (frameMs !== undefined && (!Number.isFinite(entityMs) || frameMs >= entityMs)) {
          return DateTime.formatIso(DateTime.makeUnsafe(frameMs));
        }
        return entityIso;
      })(),
      cameraStale,
      cameraRevision: (previous?.media.cameraRevision ?? 0) + (online ? 1 : 0),
      coverUpdatedAt: coverEntity?.last_updated ?? null,
    },
    capabilities: {
      canPause:
        canControl &&
        pauseButton !== undefined &&
        pauseButton.state !== "unavailable" &&
        status === "running",
      canResume:
        canControl &&
        resumeButton !== undefined &&
        resumeButton.state !== "unavailable" &&
        status === "pause",
      canStop:
        canControl && stopButton !== undefined && stopButton.state !== "unavailable" && isJobActive,
      canSetTemps:
        canControl &&
        (byId.has(`number.${prefix}_nozzle_target_temperature`) ||
          byId.has(`number.${prefix}_bed_target_temperature`)),
      canSetFans:
        canControl &&
        (byId.has(`fan.${prefix}_cooling_fan`) ||
          byId.has(`fan.${prefix}_aux_fan`) ||
          byId.has(`fan.${prefix}_chamber_fan`)),
      canSetLight: canControl && chamberLightEntity !== undefined,
      canSetSpeed: canControl && speedSelectEntity !== undefined && isJobActive,
      canJog: canControl && !stale && (status === "idle" || status === "finish"),
      canSkipObjects:
        canControl && isJobActive && printableObjects.filter((o) => !o.skipped).length > 1,
    },
  };

  const { deviceId: _droppedDeviceId, deviceIdPrefix: _droppedPrefix, ...baseCache } = cache;
  const keepDeviceId = cache.deviceIdPrefix === prefix && cache.deviceId !== undefined;

  return {
    snapshot,
    cache: {
      ...baseCache,
      entityPrefix: prefix,
      cameraEntityHealthy,
      ...(keepDeviceId ? { deviceId: cache.deviceId, deviceIdPrefix: prefix } : {}),
      lastCompletedJobName,
    },
  };
}

function filterValidHaEntityStates(raw: ReadonlyArray<unknown>): ReadonlyArray<HaEntityState> {
  const valid: Array<HaEntityState> = [];
  for (const entry of raw) {
    if (
      entry !== null &&
      typeof entry === "object" &&
      !Array.isArray(entry) &&
      typeof (entry as { entity_id?: unknown }).entity_id === "string" &&
      typeof (entry as { state?: unknown }).state === "string"
    ) {
      valid.push(entry as HaEntityState);
    }
  }
  return valid;
}

export const homeAssistantBambuAdapter: PrinterAdapter<HomeAssistantBambuPrinterConfig> = {
  poll: Effect.fn("HomeAssistantBambuAdapter.poll")(function* (config, secret, previous, cache) {
    const baseUrl = yield* validatePrinterBaseUrl(config.baseUrl, "poll", config.id);
    const rawStates = yield* fetchPrinterJson<ReadonlyArray<unknown>>(
      buildPrinterEndpoint(baseUrl, "/api/states"),
      {
        headers: haHeaders(secret),
        operation: "ha.states",
        printerId: config.id,
        expectedType: "array",
      },
    );
    const states = filterValidHaEntityStates(rawStates);
    const now = yield* DateTime.now;
    const nowMs = DateTime.toEpochMillis(now);
    const nowIso = DateTime.formatIso(now);
    const parsed = yield* Effect.try({
      try: () =>
        parseHomeAssistantBambuStates({
          config,
          states,
          previous,
          cache,
          nowMs,
          nowIso,
        }),
      catch: (error) =>
        isPrinterOperationError(error)
          ? error
          : new PrinterOperationError({
              operation: "poll",
              printerId: config.id,
              reason:
                error instanceof Error
                  ? error.message
                  : "Failed to parse Home Assistant printer state.",
            }),
    });
    const deviceId = yield* resolveVerifiedHaDeviceId({
      baseUrl,
      secret,
      prefix: parsed.cache.entityPrefix!,
      configuredDeviceId: config.deviceId,
      cachedDeviceId: parsed.cache.deviceId,
      cachedDeviceIdPrefix: parsed.cache.deviceIdPrefix,
      printerId: config.id,
      operation: "poll",
    }).pipe(Effect.orElseSucceed(() => undefined));
    const {
      deviceId: _prevDeviceId,
      deviceIdPrefix: _prevDeviceIdPrefix,
      ...restCache
    } = parsed.cache;
    return {
      snapshot: parsed.snapshot,
      cache: {
        ...restCache,
        ...(deviceId && parsed.cache.entityPrefix
          ? { deviceId, deviceIdPrefix: parsed.cache.entityPrefix }
          : {}),
      },
    };
  }),

  testConnection: Effect.fn("HomeAssistantBambuAdapter.testConnection")(function* (config, secret) {
    const baseUrl = yield* validatePrinterBaseUrl(config.baseUrl, "testConnection", config.id);
    if (config.entityPrefix?.trim() && !normalizeBambuEntityPrefix(config.entityPrefix)) {
      return yield* new PrinterOperationError({
        operation: "testConnection",
        printerId: config.id,
        reason:
          "Entity prefix may only contain letters, digits, and underscores (with an optional trailing dot).",
      });
    }
    const rawStates = yield* fetchPrinterJson<ReadonlyArray<unknown>>(
      buildPrinterEndpoint(baseUrl, "/api/states"),
      {
        headers: haHeaders(secret),
        operation: "ha.testConnection",
        printerId: config.id,
        expectedType: "array",
      },
    );
    const states = filterValidHaEntityStates(rawStates);
    const prefix = discoverBambuEntityPrefix(states, config.entityPrefix);
    if (!prefix) {
      return yield* new PrinterOperationError({
        operation: "testConnection",
        printerId: config.id,
        reason: "Connected to Home Assistant, but no Bambu Lab printer entities were found.",
      });
    }
    const entityCount = states.filter((s) => s.entity_id.includes(`.${prefix}_`)).length;
    const now = yield* DateTime.now;
    const parsed = parseHomeAssistantBambuStates({
      config,
      states,
      previous: undefined,
      cache: { entityPrefix: prefix },
      nowMs: DateTime.toEpochMillis(now),
      nowIso: DateTime.formatIso(now),
    });
    const verifyDeviceId = resolveVerifiedHaDeviceId({
      baseUrl,
      secret,
      prefix,
      configuredDeviceId: config.deviceId,
      cachedDeviceId: undefined,
      cachedDeviceIdPrefix: undefined,
      printerId: config.id,
      operation: "testConnection",
    });
    const deviceId = config.deviceId?.trim()
      ? yield* verifyDeviceId
      : yield* verifyDeviceId.pipe(Effect.orElseSucceed(() => undefined));
    return {
      ok: true,
      model: parsed.snapshot.hardware.model,
      printerName: parsed.snapshot.hardware.name,
      detectedEntityPrefix: prefix,
      ...(deviceId ? { detectedDeviceId: deviceId } : {}),
      online: parsed.snapshot.online,
      hasCamera: parsed.snapshot.media.hasCamera,
      hasCoverImage: parsed.snapshot.media.hasCoverImage,
      entityCount,
      summary: `Connected to ${parsed.snapshot.hardware.model ?? parsed.snapshot.hardware.name ?? prefix} (${entityCount} entities, ${parsed.snapshot.online ? "online" : "offline"}).`,
    };
  }),

  executeAction: Effect.fn("HomeAssistantBambuAdapter.executeAction")(function* (
    config,
    secret,
    action: PrinterAction,
    _current,
    cache,
  ) {
    const baseUrl = yield* validatePrinterBaseUrl(config.baseUrl, action.kind, config.id);
    if (config.entityPrefix?.trim() && !normalizeBambuEntityPrefix(config.entityPrefix)) {
      return yield* new PrinterOperationError({
        operation: action.kind,
        printerId: config.id,
        reason:
          "Entity prefix may only contain letters, digits, and underscores (with an optional trailing dot).",
      });
    }
    const prefix =
      normalizeBambuEntityPrefix(config.entityPrefix) ??
      normalizeBambuEntityPrefix(cache.entityPrefix);
    if (!prefix) {
      return yield* new PrinterOperationError({
        operation: action.kind,
        printerId: config.id,
        reason: "Printer entity prefix has not been discovered yet. Refresh the printer first.",
      });
    }

    switch (action.kind) {
      case "pause":
        return yield* callHaService(
          baseUrl,
          secret,
          "button",
          "press",
          { entity_id: `button.${prefix}_pause` },
          config.id,
        );
      case "resume":
        return yield* callHaService(
          baseUrl,
          secret,
          "button",
          "press",
          { entity_id: `button.${prefix}_resume` },
          config.id,
        );
      case "stop":
        return yield* callHaService(
          baseUrl,
          secret,
          "button",
          "press",
          { entity_id: `button.${prefix}_stop` },
          config.id,
        );
      case "setChamberLight":
        return yield* callHaService(
          baseUrl,
          secret,
          "light",
          action.on ? "turn_on" : "turn_off",
          { entity_id: `light.${prefix}_chamber_light` },
          config.id,
        );
      case "setSpeedProfile":
        return yield* callHaService(
          baseUrl,
          secret,
          "select",
          "select_option",
          { entity_id: `select.${prefix}_printing_speed`, option: action.profile },
          config.id,
        );
      case "setFanSpeed": {
        const entityMap = {
          cooling: `fan.${prefix}_cooling_fan`,
          aux: `fan.${prefix}_aux_fan`,
          chamber: `fan.${prefix}_chamber_fan`,
        } as const;
        if (action.percent <= 0) {
          return yield* callHaService(
            baseUrl,
            secret,
            "fan",
            "turn_off",
            { entity_id: entityMap[action.fan] },
            config.id,
          );
        }
        return yield* callHaService(
          baseUrl,
          secret,
          "fan",
          "set_percentage",
          { entity_id: entityMap[action.fan], percentage: action.percent },
          config.id,
        );
      }
      case "setNozzleTemp":
        return yield* callHaService(
          baseUrl,
          secret,
          "number",
          "set_value",
          { entity_id: `number.${prefix}_nozzle_target_temperature`, value: action.targetC },
          config.id,
        );
      case "setBedTemp":
        return yield* callHaService(
          baseUrl,
          secret,
          "number",
          "set_value",
          { entity_id: `number.${prefix}_bed_target_temperature`, value: action.targetC },
          config.id,
        );
      case "homeAxes":
      case "moveAxis": {
        const deviceId = yield* resolveVerifiedHaDeviceId({
          baseUrl,
          secret,
          prefix,
          configuredDeviceId: config.deviceId,
          cachedDeviceId: cache.deviceId,
          cachedDeviceIdPrefix: cache.deviceIdPrefix,
          printerId: config.id,
          operation: action.kind,
          bypassCache: true,
        });
        if (!deviceId) {
          return yield* new PrinterOperationError({
            operation: action.kind,
            printerId: config.id,
            reason:
              "Home Assistant device_id is required for axis movement. Configure it in Settings -> 3D Printers.",
          });
        }
        return yield* callHaService(
          baseUrl,
          secret,
          "bambu_lab",
          "move_axis",
          action.kind === "homeAxes"
            ? { device_id: deviceId, axis: "Home", distance: 0 }
            : { device_id: deviceId, axis: action.axis, distance: action.distanceMm },
          config.id,
        );
      }
      case "skipObjects": {
        const deviceId = yield* resolveVerifiedHaDeviceId({
          baseUrl,
          secret,
          prefix,
          configuredDeviceId: config.deviceId,
          cachedDeviceId: cache.deviceId,
          cachedDeviceIdPrefix: cache.deviceIdPrefix,
          printerId: config.id,
          operation: action.kind,
          bypassCache: true,
        });
        if (!deviceId) {
          return yield* new PrinterOperationError({
            operation: action.kind,
            printerId: config.id,
            reason:
              "Home Assistant device_id is required to skip objects. Configure it in Settings -> 3D Printers.",
          });
        }
        return yield* callHaService(
          baseUrl,
          secret,
          "bambu_lab",
          "skip_objects",
          { device_id: deviceId, objects: action.objectIds.join(",") },
          config.id,
        );
      }
      case "refresh":
        return yield* callHaService(
          baseUrl,
          secret,
          "button",
          "press",
          { entity_id: `button.${prefix}_force_refresh` },
          config.id,
        ).pipe(Effect.ignore);
    }
  }),

  fetchMedia: Effect.fn("HomeAssistantBambuAdapter.fetchMedia")(
    function* (config, secret, kind, current, cache) {
      const baseUrl = yield* validatePrinterBaseUrl(config.baseUrl, `media.${kind}`, config.id);
      if (config.entityPrefix?.trim() && !normalizeBambuEntityPrefix(config.entityPrefix)) {
        return yield* new PrinterOperationError({
          operation: `media.${kind}`,
          printerId: config.id,
          reason:
            "Entity prefix may only contain letters, digits, and underscores (with an optional trailing dot).",
        });
      }
      const prefix =
        normalizeBambuEntityPrefix(config.entityPrefix) ??
        normalizeBambuEntityPrefix(cache.entityPrefix);
      if (!prefix) {
        return yield* new PrinterOperationError({
          operation: `media.${kind}`,
          printerId: config.id,
          reason: "Printer entity prefix has not been discovered yet.",
        });
      }
      const path =
        kind === "camera"
          ? `/api/camera_proxy/camera.${prefix}_camera`
          : kind === "cover"
            ? `/api/image_proxy/image.${prefix}_cover_image`
            : `/api/image_proxy/image.${prefix}_pick_image`;
      const result = yield* fetchPrinterBinary(buildPrinterEndpoint(baseUrl, path), {
        ...(secret ? { headers: { Authorization: `Bearer ${secret}` } } : {}),
        operation: `ha.media.${kind}`,
        printerId: config.id,
      });
      const contentType = detectImageMimeType(result.bytes);
      if (contentType === null) {
        return yield* new PrinterOperationError({
          operation: `ha.media.${kind}`,
          printerId: config.id,
          reason: `Home Assistant returned a non-image payload for "${kind}".`,
        });
      }
      const hash = fingerprintBytes(result.bytes);
      const now = yield* DateTime.now;
      const nowMs = DateTime.toEpochMillis(now);
      const nowIso = DateTime.formatIso(now);
      const online = current?.online ?? true;

      let nextCache = cache;
      const cameraEntityHealthy = cache.cameraEntityHealthy ?? online;
      let stale = !online || (kind === "camera" && !cameraEntityHealthy);
      let capturedAt = nowIso;
      if (kind === "camera") {
        const changed = cache.lastCameraHash !== hash;
        const lastChangedAtMs =
          changed && cameraEntityHealthy ? nowMs : (cache.lastCameraChangedAtMs ?? nowMs);
        nextCache = {
          ...cache,
          lastCameraHash: hash,
          lastCameraChangedAtMs: lastChangedAtMs,
        };
        capturedAt = DateTime.formatIso(DateTime.makeUnsafe(lastChangedAtMs));
        // If printer or HA camera entity is offline/unavailable, camera proxy serves a cached frame forever; mark stale honestly.
        // If printer is actively running and frame hash hasn't moved for >30s, flag stale too.
        if (!online || !cameraEntityHealthy) {
          stale = true;
        } else if (current?.job.status === "running" && nowMs - lastChangedAtMs > 30_000) {
          stale = true;
        }
      }

      return {
        asset: {
          bytes: result.bytes,
          contentType,
          capturedAt,
          stale,
          online,
          hash,
        },
        cache: nextCache,
      };
    },
  ),
};
