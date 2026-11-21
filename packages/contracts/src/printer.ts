import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { EnvironmentId, ThreadId, TrimmedNonEmptyString, TrimmedString } from "./baseSchemas.ts";
import { OrchestratorMcpEnvironmentTarget } from "./orchestratorMcp.ts";
import { SettingsSecretValue } from "./settingsSecretValue.ts";

export const PRINTER_MEDIA_ROUTE_PREFIX = "/api/printer-media";

export const PrinterId = TrimmedNonEmptyString.check(
  Schema.isMaxLength(128),
  Schema.isPattern(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/),
);
export type PrinterId = typeof PrinterId.Type;

export const PrinterKind = Schema.Literals(["home-assistant-bambu", "moonraker", "octoprint"]);
export type PrinterKind = typeof PrinterKind.Type;

const PrinterBaseUrl = TrimmedNonEmptyString.check(
  Schema.isPattern(/^https?:\/\/[^\s/]+(?:\/[^\s]*)?$/),
  Schema.makeFilter((value) => {
    try {
      const parsed = new URL(value);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        return "Only http:// and https:// printer URLs are supported.";
      }
      if (parsed.username !== "" || parsed.password !== "") {
        return "Printer URLs must not include embedded credentials; use the token field instead.";
      }
      return true;
    } catch {
      return "Must be a valid http:// or https:// URL.";
    }
  }),
);

const PrinterPollIntervalSeconds = Schema.Int.check(
  Schema.isBetween({ minimum: 2, maximum: 60 }),
).pipe(Schema.withDecodingDefaultKey(Effect.succeed(4)));

const HomeAssistantEntityPrefix = TrimmedNonEmptyString.check(
  Schema.isMaxLength(128),
  Schema.isPattern(/^[a-zA-Z0-9_]+\.?$/),
);

const HomeAssistantDeviceId = TrimmedNonEmptyString.check(
  Schema.isMaxLength(128),
  Schema.isPattern(/^[a-zA-Z0-9_-]+$/),
);

export const HomeAssistantBambuPrinterConfig = Schema.Struct({
  kind: Schema.Literal("home-assistant-bambu"),
  id: PrinterId,
  label: TrimmedNonEmptyString,
  /** Home Assistant origin, e.g. http://homeassistant.local:8123. */
  baseUrl: PrinterBaseUrl,
  /** Home Assistant long-lived access token or secret reference. */
  accessToken: SettingsSecretValue.pipe(
    Schema.withDecodingDefaultKey(Effect.succeed("")),
    Schema.annotateKey({ settingsSecret: true }),
  ),
  /** Optional entity prefix (e.g. p1s_01p00a000000000). Auto-detected when omitted. */
  entityPrefix: Schema.optional(HomeAssistantEntityPrefix),
  /** Optional HA device registry id used for bambu_lab.* service calls. */
  deviceId: Schema.optional(HomeAssistantDeviceId),
  pollIntervalSeconds: PrinterPollIntervalSeconds,
});
export type HomeAssistantBambuPrinterConfig = typeof HomeAssistantBambuPrinterConfig.Type;

export const MoonrakerPrinterConfig = Schema.Struct({
  kind: Schema.Literal("moonraker"),
  id: PrinterId,
  label: TrimmedNonEmptyString,
  /** Moonraker origin, e.g. http://192.168.1.50:7125. */
  baseUrl: PrinterBaseUrl,
  /** Optional Moonraker API key or secret reference. */
  apiKey: SettingsSecretValue.pipe(
    Schema.withDecodingDefaultKey(Effect.succeed("")),
    Schema.annotateKey({ settingsSecret: true }),
  ),
  /** Optional snapshot URL override (defaults to /webcam/?action=snapshot). */
  webcamUrl: Schema.optional(PrinterBaseUrl),
  pollIntervalSeconds: PrinterPollIntervalSeconds,
});
export type MoonrakerPrinterConfig = typeof MoonrakerPrinterConfig.Type;

export const OctoPrintPrinterConfig = Schema.Struct({
  kind: Schema.Literal("octoprint"),
  id: PrinterId,
  label: TrimmedNonEmptyString,
  /** OctoPrint origin, e.g. http://octopi.local. */
  baseUrl: PrinterBaseUrl,
  /** OctoPrint application/API key or secret reference. */
  apiKey: SettingsSecretValue.pipe(
    Schema.withDecodingDefaultKey(Effect.succeed("")),
    Schema.annotateKey({ settingsSecret: true }),
  ),
  /** Optional snapshot URL override (defaults to /webcam/?action=snapshot). */
  webcamUrl: Schema.optional(PrinterBaseUrl),
  pollIntervalSeconds: PrinterPollIntervalSeconds,
});
export type OctoPrintPrinterConfig = typeof OctoPrintPrinterConfig.Type;

export const PrinterConfig = Schema.Union([
  HomeAssistantBambuPrinterConfig,
  MoonrakerPrinterConfig,
  OctoPrintPrinterConfig,
]);
export type PrinterConfig = typeof PrinterConfig.Type;

const uniquePrinterIds = Schema.makeFilter(
  (printers: ReadonlyArray<{ readonly id: string }>) =>
    new Set(printers.map((printer) => printer.id)).size === printers.length ||
    "Printer ids must be unique.",
);

export const PrinterConfigs = Schema.Array(PrinterConfig).check(uniquePrinterIds);
export type PrinterConfigs = typeof PrinterConfigs.Type;

export const PrinterConnectionState = Schema.Literals([
  "connected",
  "degraded",
  "offline",
  "error",
]);
export type PrinterConnectionState = typeof PrinterConnectionState.Type;

export const PrinterJobStatus = Schema.Literals([
  "idle",
  "prepare",
  "running",
  "pause",
  "finish",
  "failed",
  "offline",
  "unknown",
]);
export type PrinterJobStatus = typeof PrinterJobStatus.Type;

export const PrinterSpeedProfile = Schema.Literals(["silent", "standard", "sport", "ludicrous"]);
export type PrinterSpeedProfile = typeof PrinterSpeedProfile.Type;

export const PrinterThermalReading = Schema.Struct({
  actualC: Schema.NullOr(Schema.Number),
  targetC: Schema.NullOr(Schema.Number),
  minC: Schema.optional(Schema.Number),
  maxC: Schema.optional(Schema.Number),
});
export type PrinterThermalReading = typeof PrinterThermalReading.Type;

export const PrinterThermalPoint = Schema.Struct({
  timestampMs: Schema.Number,
  nozzleActualC: Schema.NullOr(Schema.Number),
  nozzleTargetC: Schema.NullOr(Schema.Number),
  bedActualC: Schema.NullOr(Schema.Number),
  bedTargetC: Schema.NullOr(Schema.Number),
  chamberActualC: Schema.optional(Schema.NullOr(Schema.Number)),
});
export type PrinterThermalPoint = typeof PrinterThermalPoint.Type;

export const PrinterSpool = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  material: Schema.NullOr(Schema.String),
  colorHex: Schema.NullOr(Schema.String),
  remainingPercent: Schema.NullOr(Schema.Number),
  active: Schema.Boolean,
  empty: Schema.Boolean,
  external: Schema.optional(Schema.Boolean),
});
export type PrinterSpool = typeof PrinterSpool.Type;

export const PrinterAmsUnit = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  humidityIndex: Schema.NullOr(Schema.Number),
  temperatureC: Schema.NullOr(Schema.Number),
  trays: Schema.Array(PrinterSpool),
});
export type PrinterAmsUnit = typeof PrinterAmsUnit.Type;

export const PrinterObject = Schema.Struct({
  id: Schema.Int,
  name: Schema.String,
  skipped: Schema.Boolean,
});
export type PrinterObject = typeof PrinterObject.Type;

export const PrinterAlert = Schema.Struct({
  code: Schema.String,
  severity: Schema.Literals(["warning", "error"]),
  message: Schema.String,
});
export type PrinterAlert = typeof PrinterAlert.Type;

export const PrinterHardwareInfo = Schema.Struct({
  model: Schema.NullOr(Schema.String),
  name: Schema.NullOr(Schema.String),
  serial: Schema.NullOr(Schema.String),
  firmware: Schema.NullOr(Schema.String),
  ipAddress: Schema.NullOr(Schema.String),
  nozzleSizeMm: Schema.NullOr(Schema.Number),
  nozzleType: Schema.NullOr(Schema.String),
  bedType: Schema.NullOr(Schema.String),
  totalUsageHours: Schema.NullOr(Schema.Number),
  wifiSignalDbm: Schema.NullOr(Schema.Number),
  sdCardStatus: Schema.NullOr(Schema.String),
  connectionMode: Schema.NullOr(Schema.String),
  controlBlocked: Schema.Boolean,
  controlBlockedReason: Schema.optional(Schema.String),
});
export type PrinterHardwareInfo = typeof PrinterHardwareInfo.Type;

export const PrinterJobInfo = Schema.Struct({
  status: PrinterJobStatus,
  stage: Schema.NullOr(Schema.String),
  stageLabel: Schema.NullOr(Schema.String),
  fileName: Schema.NullOr(Schema.String),
  displayName: Schema.NullOr(Schema.String),
  progressPercent: Schema.NullOr(Schema.Number),
  currentLayer: Schema.NullOr(Schema.Int),
  totalLayers: Schema.NullOr(Schema.Int),
  remainingSeconds: Schema.NullOr(Schema.Number),
  elapsedSeconds: Schema.NullOr(Schema.Number),
  startedAt: Schema.NullOr(Schema.String),
  estimatedFinishAt: Schema.NullOr(Schema.String),
  weightGrams: Schema.NullOr(Schema.Number),
  lengthMeters: Schema.NullOr(Schema.Number),
  timelapse: Schema.NullOr(Schema.Boolean),
  printableObjects: Schema.Array(PrinterObject),
  lastCompletedJobName: Schema.optional(Schema.NullOr(Schema.String)),
});
export type PrinterJobInfo = typeof PrinterJobInfo.Type;

export const PrinterFansInfo = Schema.Struct({
  coolingPercent: Schema.NullOr(Schema.Number),
  auxPercent: Schema.NullOr(Schema.Number),
  chamberPercent: Schema.NullOr(Schema.Number),
  heatbreakPercent: Schema.NullOr(Schema.Number),
});
export type PrinterFansInfo = typeof PrinterFansInfo.Type;

export const PrinterMediaInfo = Schema.Struct({
  hasCamera: Schema.Boolean,
  hasCoverImage: Schema.Boolean,
  hasPickImage: Schema.Boolean,
  cameraUpdatedAt: Schema.NullOr(Schema.String),
  cameraStale: Schema.Boolean,
  cameraRevision: Schema.Int,
  coverUpdatedAt: Schema.NullOr(Schema.String),
});
export type PrinterMediaInfo = typeof PrinterMediaInfo.Type;

export const PrinterCapabilities = Schema.Struct({
  canPause: Schema.Boolean,
  canResume: Schema.Boolean,
  canStop: Schema.Boolean,
  canSetTemps: Schema.Boolean,
  canSetFans: Schema.Boolean,
  canSetLight: Schema.Boolean,
  canSetSpeed: Schema.Boolean,
  canJog: Schema.Boolean,
  canSkipObjects: Schema.Boolean,
});
export type PrinterCapabilities = typeof PrinterCapabilities.Type;

export const PrinterSnapshot = Schema.Struct({
  id: PrinterId,
  label: TrimmedNonEmptyString,
  kind: PrinterKind,
  connectionState: PrinterConnectionState,
  online: Schema.Boolean,
  lastSyncedAt: Schema.NullOr(Schema.String),
  lastUpdatedAt: Schema.NullOr(Schema.String),
  stale: Schema.Boolean,
  staleReason: Schema.optional(Schema.String),
  error: Schema.optional(Schema.String),
  hardware: PrinterHardwareInfo,
  job: PrinterJobInfo,
  thermals: Schema.Struct({
    nozzle: PrinterThermalReading,
    bed: PrinterThermalReading,
    chamber: Schema.optional(PrinterThermalReading),
    history: Schema.Array(PrinterThermalPoint),
  }),
  fans: PrinterFansInfo,
  lighting: Schema.Struct({
    chamberLight: Schema.NullOr(Schema.Boolean),
  }),
  speed: Schema.Struct({
    profile: Schema.NullOr(PrinterSpeedProfile),
    modifierPercent: Schema.NullOr(Schema.Number),
  }),
  filament: Schema.Struct({
    extruderLoaded: Schema.NullOr(Schema.Boolean),
    externalSpool: Schema.NullOr(PrinterSpool),
    amsUnits: Schema.Array(PrinterAmsUnit),
  }),
  alerts: Schema.Array(PrinterAlert),
  media: PrinterMediaInfo,
  capabilities: PrinterCapabilities,
});
export type PrinterSnapshot = typeof PrinterSnapshot.Type;

export const PrinterSession = Schema.Struct({
  threadId: ThreadId,
  printerId: PrinterId,
  /** When the printer is hosted by another environment in T3 Connect, route UI & media there. */
  proxyEnvironmentId: Schema.optional(EnvironmentId),
  printerLabel: Schema.optional(TrimmedNonEmptyString),
  openedAt: Schema.String,
});
export type PrinterSession = typeof PrinterSession.Type;

export const PrinterServiceState = Schema.Struct({
  enabled: Schema.Boolean,
  agentAccessEnabled: Schema.Boolean,
  mediaBasePath: Schema.String,
  printers: Schema.Array(PrinterSnapshot),
  sessions: Schema.Array(PrinterSession),
  revision: Schema.Int,
});
export type PrinterServiceState = typeof PrinterServiceState.Type;

export const PrinterConfigureInput = Schema.Struct({
  enabled: Schema.optional(Schema.Boolean),
  agentAccessEnabled: Schema.optional(Schema.Boolean),
  printers: Schema.optional(PrinterConfigs),
});
export type PrinterConfigureInput = typeof PrinterConfigureInput.Type;

export const PrinterTestConnectionInput = Schema.Struct({
  config: PrinterConfig,
  /** When testing an edited saved printer whose token is unchanged, reuse the stored secret. */
  existingPrinterId: Schema.optional(PrinterId),
});
export type PrinterTestConnectionInput = typeof PrinterTestConnectionInput.Type;

export const PrinterTestConnectionResult = Schema.Struct({
  ok: Schema.Boolean,
  model: Schema.NullOr(Schema.String),
  printerName: Schema.NullOr(Schema.String),
  detectedEntityPrefix: Schema.optional(Schema.String),
  detectedDeviceId: Schema.optional(Schema.String),
  online: Schema.Boolean,
  hasCamera: Schema.Boolean,
  hasCoverImage: Schema.Boolean,
  entityCount: Schema.optional(Schema.Int),
  summary: Schema.String,
});
export type PrinterTestConnectionResult = typeof PrinterTestConnectionResult.Type;

export const PrinterListInput = Schema.Struct({
  printerId: Schema.optional(PrinterId),
  refresh: Schema.optional(Schema.Boolean),
});
export type PrinterListInput = typeof PrinterListInput.Type;

export const PrinterOpenInput = Schema.Struct({
  threadId: ThreadId,
  printerId: PrinterId,
  /** Optional T3 Connect environment hosting the printer when proxied from another machine. */
  proxyEnvironmentId: Schema.optional(EnvironmentId),
  printerLabel: Schema.optional(TrimmedNonEmptyString),
});
export type PrinterOpenInput = typeof PrinterOpenInput.Type;

export const PrinterCloseInput = Schema.Struct({
  threadId: ThreadId,
  printerId: Schema.optional(PrinterId),
  /** `EnvironmentId` targets that proxy environment; `null` targets local sessions only; omitted matches any environment. */
  proxyEnvironmentId: Schema.optional(Schema.NullOr(EnvironmentId)),
});
export type PrinterCloseInput = typeof PrinterCloseInput.Type;

export const PrinterAction = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("pause"),
    expectedJobFileName: Schema.optional(Schema.NullOr(Schema.String)),
    expectedJobStartedAt: Schema.optional(Schema.NullOr(Schema.String)),
  }),
  Schema.Struct({
    kind: Schema.Literal("resume"),
    expectedJobFileName: Schema.optional(Schema.NullOr(Schema.String)),
    expectedJobStartedAt: Schema.optional(Schema.NullOr(Schema.String)),
  }),
  Schema.Struct({
    kind: Schema.Literal("stop"),
    expectedJobFileName: Schema.optional(Schema.NullOr(Schema.String)),
    expectedJobStartedAt: Schema.optional(Schema.NullOr(Schema.String)),
  }),
  Schema.Struct({
    kind: Schema.Literal("setChamberLight"),
    on: Schema.Boolean,
  }),
  Schema.Struct({
    kind: Schema.Literal("setSpeedProfile"),
    profile: PrinterSpeedProfile,
  }),
  Schema.Struct({
    kind: Schema.Literal("setFanSpeed"),
    fan: Schema.Literals(["cooling", "aux", "chamber"]),
    percent: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 100 })),
  }),
  Schema.Struct({
    kind: Schema.Literal("setNozzleTemp"),
    targetC: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 320 })),
  }),
  Schema.Struct({
    kind: Schema.Literal("setBedTemp"),
    targetC: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 120 })),
  }),
  Schema.Struct({
    kind: Schema.Literal("homeAxes"),
  }),
  Schema.Struct({
    kind: Schema.Literal("moveAxis"),
    axis: Schema.Literals(["X", "Y", "Z"]),
    distanceMm: Schema.Number.check(Schema.isBetween({ minimum: -10, maximum: 10 })),
  }),
  Schema.Struct({
    kind: Schema.Literal("skipObjects"),
    objectIds: Schema.Array(Schema.Int).check(Schema.isMinLength(1)),
    expectedJobFileName: Schema.optional(Schema.NullOr(Schema.String)),
    expectedJobStartedAt: Schema.optional(Schema.NullOr(Schema.String)),
  }),
  Schema.Struct({
    kind: Schema.Literal("refresh"),
  }),
]);
export type PrinterAction = typeof PrinterAction.Type;

export const PrinterActionInput = Schema.Struct({
  printerId: PrinterId,
  action: PrinterAction,
});
export type PrinterActionInput = typeof PrinterActionInput.Type;

export class PrinterOperationError extends Schema.TaggedError<PrinterOperationError>()(
  "PrinterOperationError",
  {
    operation: Schema.String,
    reason: Schema.String,
    printerId: Schema.optional(Schema.String),
  },
) {
  override get message(): string {
    return this.reason;
  }
}

export class PrinterSafetyError extends Schema.TaggedError<PrinterSafetyError>()(
  "PrinterSafetyError",
  {
    action: Schema.String,
    reason: Schema.String,
    printerId: Schema.String,
  },
) {
  override get message(): string {
    return this.reason;
  }
}

export const PrinterError = Schema.Union([PrinterOperationError, PrinterSafetyError]);
export type PrinterError = typeof PrinterError.Type;

export class PrinterToolUnavailableError extends Schema.TaggedError<PrinterToolUnavailableError>()(
  "PrinterToolUnavailableError",
  {
    reason: Schema.String,
  },
) {
  override get message(): string {
    return this.reason;
  }
}

export const PrinterToolError = Schema.Union([PrinterError, PrinterToolUnavailableError]);
export type PrinterToolError = typeof PrinterToolError.Type;

export const PrinterToolListResult = Schema.Struct({
  enabled: Schema.Boolean,
  printers: Schema.Array(
    Schema.Struct({
      id: PrinterId,
      label: Schema.String,
      kind: PrinterKind,
      model: Schema.NullOr(Schema.String),
      online: Schema.Boolean,
      stale: Schema.Boolean,
      status: PrinterJobStatus,
      stageLabel: Schema.NullOr(Schema.String),
      fileName: Schema.NullOr(Schema.String),
      progressPercent: Schema.NullOr(Schema.Number),
      hasCamera: Schema.Boolean,
      openInThread: Schema.Boolean,
      environmentId: Schema.optional(EnvironmentId),
      environmentLabel: Schema.optional(Schema.String),
    }),
  ),
});

export const PrinterToolTargetInput = Schema.Struct({
  environmentId: OrchestratorMcpEnvironmentTarget,
  printerId: Schema.optional(
    TrimmedString.annotate({
      description:
        "Printer id or label from `printer_list`. Omit when only one printer is configured or open.",
    }),
  ),
});

export const PrinterToolPanelTargetInput = Schema.Struct({
  environmentId: Schema.optional(
    EnvironmentId.annotate({
      description: "Optional linked environment hosting the printer. Omit to auto-discover.",
    }),
  ),
  printerId: Schema.optional(
    TrimmedString.annotate({
      description:
        "Printer id or label from `printer_list`. Omit when only one printer is configured or open.",
    }),
  ),
});

export const PrinterToolStatusResult = Schema.Struct({
  printer: PrinterSnapshot,
  cameraAgeSeconds: Schema.NullOr(Schema.Number),
  environmentId: Schema.optional(EnvironmentId),
  environmentLabel: Schema.optional(Schema.String),
  note: Schema.String,
});

export const PrinterToolOpenResult = Schema.Struct({
  printer: PrinterSnapshot,
  environmentId: Schema.optional(EnvironmentId),
  environmentLabel: Schema.optional(Schema.String),
  note: Schema.String,
});

export const PrinterToolSnapshotResult = Schema.Struct({
  printerId: PrinterId,
  printerLabel: Schema.String,
  online: Schema.Boolean,
  stale: Schema.Boolean,
  capturedAt: Schema.String,
  cameraAgeSeconds: Schema.NullOr(Schema.Number),
  environmentId: Schema.optional(EnvironmentId),
  environmentLabel: Schema.optional(Schema.String),
  screenshot: Schema.Struct({
    mimeType: Schema.Literals(["image/jpeg", "image/png"]),
    data: Schema.String,
    width: Schema.Int,
    height: Schema.Int,
  }),
});
