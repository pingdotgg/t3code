import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import {
  type OctoPrintPrinterConfig,
  type PrinterAction,
  type PrinterJobStatus,
  PrinterOperationError,
  type PrinterSnapshot,
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

interface OctoPrinterResponse {
  readonly state?: {
    readonly text?: string;
    readonly flags?: {
      readonly operational?: boolean;
      readonly printing?: boolean;
      readonly paused?: boolean;
      readonly pausing?: boolean;
      readonly resuming?: boolean;
      readonly cancelling?: boolean;
      readonly error?: boolean;
      readonly ready?: boolean;
    };
  };
  readonly temperature?: {
    readonly tool0?: { readonly actual?: number; readonly target?: number };
    readonly bed?: { readonly actual?: number; readonly target?: number };
    readonly chamber?: { readonly actual?: number; readonly target?: number };
  };
}

interface OctoJobResponse {
  readonly job?: {
    readonly file?: { readonly name?: string | null; readonly display?: string | null };
    readonly filament?: { readonly tool0?: { readonly length?: number } };
  };
  readonly progress?: {
    readonly completion?: number | null;
    readonly printTime?: number | null;
    readonly printTimeLeft?: number | null;
  };
}

function octoHeaders(secret: string): Record<string, string> {
  return secret
    ? { "X-Api-Key": secret, "Content-Type": "application/json" }
    : { "Content-Type": "application/json" };
}

function mapOctoStatus(
  flags: NonNullable<OctoPrinterResponse["state"]>["flags"],
): PrinterJobStatus {
  if (!flags) return "unknown";
  if (flags.error) return "failed";
  if (flags.paused || flags.pausing || flags.resuming) return "pause";
  if (flags.printing || flags.cancelling) return "running";
  if (flags.operational === true && flags.ready === true) return "idle";
  if (flags.operational === true) return "prepare";
  return "offline";
}

export const octoPrintAdapter: PrinterAdapter<OctoPrintPrinterConfig> = {
  poll: Effect.fn("OctoPrintAdapter.poll")(function* (config, secret, previous, cache) {
    const baseUrl = yield* validatePrinterBaseUrl(config.baseUrl, "poll", config.id);
    const headers = octoHeaders(secret);
    const [printerResult, jobData] = yield* Effect.all([
      Effect.result(
        fetchPrinterJson<OctoPrinterResponse>(buildPrinterEndpoint(baseUrl, "/api/printer"), {
          headers,
          operation: "octoprint.printer",
          printerId: config.id,
        }),
      ),
      fetchPrinterJson<OctoJobResponse>(buildPrinterEndpoint(baseUrl, "/api/job"), {
        headers,
        operation: "octoprint.job",
        printerId: config.id,
      }),
    ]);
    // OctoPrint returns HTTP 409 when OctoPrint is up but the serial printer is disconnected.
    const printerData: OctoPrinterResponse =
      printerResult._tag === "Success"
        ? printerResult.success
        : printerResult.failure.reason.includes("HTTP 409")
          ? {}
          : yield* printerResult.failure;

    const now = yield* DateTime.now;
    const nowMs = DateTime.toEpochMillis(now);
    const nowIso = DateTime.formatIso(now);
    const flags = printerData.state?.flags;
    const online = Boolean(flags?.operational || flags?.printing || flags?.paused || flags?.ready);
    const status = mapOctoStatus(flags);
    const isActive = status === "running" || status === "pause";

    const nozzleActual =
      typeof printerData.temperature?.tool0?.actual === "number"
        ? Math.round(printerData.temperature.tool0.actual * 10) / 10
        : null;
    const nozzleTarget =
      typeof printerData.temperature?.tool0?.target === "number"
        ? Math.round(printerData.temperature.tool0.target)
        : null;
    const bedActual =
      typeof printerData.temperature?.bed?.actual === "number"
        ? Math.round(printerData.temperature.bed.actual * 10) / 10
        : null;
    const bedTarget =
      typeof printerData.temperature?.bed?.target === "number"
        ? Math.round(printerData.temperature.bed.target)
        : null;

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

    const remainingSeconds =
      typeof jobData.progress?.printTimeLeft === "number"
        ? Math.round(jobData.progress.printTimeLeft)
        : null;

    const isTransitional = Boolean(flags?.pausing || flags?.resuming || flags?.cancelling);
    const isSettledReadyIdle = Boolean(
      online &&
      flags?.operational === true &&
      flags?.ready === true &&
      !flags?.printing &&
      !flags?.paused &&
      !isTransitional &&
      !flags?.error,
    );

    const snapshot: PrinterSnapshot = {
      id: config.id,
      label: config.label,
      kind: config.kind,
      connectionState: online ? "connected" : "offline",
      online,
      lastSyncedAt: nowIso,
      lastUpdatedAt: nowIso,
      stale: !online,
      ...(!online ? { staleReason: "OctoPrint is not connected to a serial printer." } : {}),
      hardware: {
        model: "OctoPrint",
        name: config.label,
        serial: null,
        firmware: null,
        ipAddress: baseUrl.hostname,
        nozzleSizeMm: null,
        nozzleType: null,
        bedType: null,
        totalUsageHours: null,
        wifiSignalDbm: null,
        sdCardStatus: null,
        connectionMode: "octoprint",
        controlBlocked: !online,
      },
      job: {
        status,
        stage: printerData.state?.text ?? null,
        stageLabel: printerData.state?.text ?? null,
        fileName: jobData.job?.file?.name ?? null,
        displayName: jobData.job?.file?.display ?? jobData.job?.file?.name ?? null,
        progressPercent:
          typeof jobData.progress?.completion === "number"
            ? Math.round(jobData.progress.completion)
            : null,
        currentLayer: null,
        totalLayers: null,
        remainingSeconds: isActive ? remainingSeconds : null,
        elapsedSeconds:
          isActive && typeof jobData.progress?.printTime === "number"
            ? Math.round(jobData.progress.printTime)
            : null,
        startedAt: deriveStableJobStartedAt({
          isActive,
          fileName: jobData.job?.file?.name ?? null,
          elapsedSeconds:
            isActive && typeof jobData.progress?.printTime === "number"
              ? Math.round(jobData.progress.printTime)
              : null,
          previous,
          nowMs,
        }),
        estimatedFinishAt:
          isActive && remainingSeconds !== null
            ? DateTime.formatIso(DateTime.add(now, { seconds: remainingSeconds }))
            : null,
        weightGrams: null,
        lengthMeters:
          typeof jobData.job?.filament?.tool0?.length === "number"
            ? Math.round((jobData.job.filament.tool0.length / 1000) * 100) / 100
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
        coolingPercent: null,
        auxPercent: null,
        chamberPercent: null,
        heatbreakPercent: null,
      },
      lighting: { chamberLight: null },
      speed: { profile: null, modifierPercent: null },
      filament: { extruderLoaded: null, externalSpool: null, amsUnits: [] },
      alerts: flags?.error
        ? [
            {
              code: "OCTOPRINT_ERROR",
              severity: "error",
              message: printerData.state?.text || "Printer error",
            },
          ]
        : [],
      media: {
        hasCamera: Boolean(config.webcamUrl),
        hasCoverImage: false,
        hasPickImage: false,
        cameraUpdatedAt: config.webcamUrl ? nowIso : null,
        cameraStale: !online,
        cameraRevision: (previous?.media.cameraRevision ?? 0) + (online ? 1 : 0),
        coverUpdatedAt: null,
      },
      capabilities: {
        canPause: Boolean(
          online &&
          flags?.operational === true &&
          flags?.printing === true &&
          !flags?.paused &&
          !isTransitional,
        ),
        canResume: Boolean(
          online && flags?.operational === true && flags?.paused === true && !isTransitional,
        ),
        canStop: Boolean(
          online &&
          flags?.operational === true &&
          (flags?.printing === true || flags?.paused === true) &&
          !flags?.cancelling,
        ),
        canSetTemps: Boolean(online && flags?.operational === true),
        canSetFans: false,
        canSetLight: false,
        canSetSpeed: false,
        canJog: isSettledReadyIdle,
        canSkipObjects: false,
      },
    };

    return { snapshot, cache };
  }),

  testConnection: Effect.fn("OctoPrintAdapter.testConnection")(function* (config, secret) {
    const baseUrl = yield* validatePrinterBaseUrl(config.baseUrl, "testConnection", config.id);
    const version = yield* fetchPrinterJson<{ readonly server?: string; readonly text?: string }>(
      buildPrinterEndpoint(baseUrl, "/api/version"),
      {
        headers: octoHeaders(secret),
        operation: "octoprint.testConnection",
        printerId: config.id,
      },
    );
    return {
      ok: true,
      model: "OctoPrint",
      printerName: config.label,
      online: true,
      hasCamera: Boolean(config.webcamUrl),
      hasCoverImage: false,
      summary: `Connected to ${version.text ?? `OctoPrint ${version.server ?? ""}`}.`,
    };
  }),

  executeAction: Effect.fn("OctoPrintAdapter.executeAction")(function* (
    config,
    secret,
    action: PrinterAction,
  ) {
    const baseUrl = yield* validatePrinterBaseUrl(config.baseUrl, action.kind, config.id);
    const headers = octoHeaders(secret);
    const post = (path: string, body: unknown, operation: string) =>
      fetchPrinterText(buildPrinterEndpoint(baseUrl, path), {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        operation,
        printerId: config.id,
      }).pipe(Effect.asVoid);

    switch (action.kind) {
      case "pause":
        return yield* post("/api/job", { command: "pause", action: "pause" }, "octoprint.pause");
      case "resume":
        return yield* post("/api/job", { command: "pause", action: "resume" }, "octoprint.resume");
      case "stop":
        return yield* post("/api/job", { command: "cancel" }, "octoprint.stop");
      case "setNozzleTemp":
        return yield* post(
          "/api/printer/tool",
          { command: "target", targets: { tool0: action.targetC } },
          "octoprint.setNozzleTemp",
        );
      case "setBedTemp":
        return yield* post(
          "/api/printer/bed",
          { command: "target", target: action.targetC },
          "octoprint.setBedTemp",
        );
      case "homeAxes":
        return yield* post(
          "/api/printer/printhead",
          { command: "home", axes: ["x", "y", "z"] },
          "octoprint.homeAxes",
        );
      case "moveAxis":
        return yield* post(
          "/api/printer/printhead",
          {
            command: "jog",
            [action.axis.toLowerCase()]: action.distanceMm,
          },
          "octoprint.moveAxis",
        );
      case "refresh":
        return;
      case "setChamberLight":
      case "setSpeedProfile":
      case "setFanSpeed":
      case "skipObjects":
        return yield* new PrinterOperationError({
          operation: action.kind,
          printerId: config.id,
          reason: `Action "${action.kind}" is not supported by the OctoPrint adapter.`,
        });
    }
  }),

  fetchMedia: Effect.fn("OctoPrintAdapter.fetchMedia")(
    function* (config, secret, kind, current, cache) {
      if (kind !== "camera" || !config.webcamUrl) {
        return yield* new PrinterOperationError({
          operation: `media.${kind}`,
          printerId: config.id,
          reason: `Media asset "${kind}" is not configured for this OctoPrint printer.`,
        });
      }
      const baseUrl = yield* validatePrinterBaseUrl(config.baseUrl, "octoprint.camera", config.id);
      const camUrl = yield* validatePrinterBaseUrl(
        config.webcamUrl,
        "octoprint.camera",
        config.id,
        {
          allowQuery: true,
        },
      );
      const result = yield* fetchPrinterBinary(camUrl, {
        // Never leak the OctoPrint API key to a different webcam origin.
        ...(secret && camUrl.origin === baseUrl.origin ? { headers: { "X-Api-Key": secret } } : {}),
        operation: "octoprint.camera",
        printerId: config.id,
      });
      const contentType = detectImageMimeType(result.bytes);
      if (contentType === null) {
        return yield* new PrinterOperationError({
          operation: "octoprint.camera",
          printerId: config.id,
          reason: "OctoPrint webcam endpoint returned a non-image payload.",
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
