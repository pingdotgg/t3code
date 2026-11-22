import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import {
  type BambuLanPrinterConfig,
  type PrinterAction,
  PrinterOperationError,
} from "@t3tools/contracts";

import { detectImageMimeType, type PrinterAdapter } from "../PrinterAdapter.ts";
import {
  fingerprintBytes,
  pinPrinterHostAddress,
  validatePrinterBaseUrl,
} from "../PrinterUrlGuard.ts";
import { fetchBambuCameraFrame } from "../bambu/bambuCamera.ts";
import {
  BAMBU_CONTROLS_LOCKED_REASON,
  SPEED_PROFILE_LEVEL,
  bambuControlsLocked,
  bambuModelName,
  bambuReportToSnapshot,
  bambuUsesFrameCamera,
} from "../bambu/bambuReport.ts";
import { BambuSession, getBambuSession, type BambuSessionTarget } from "../bambu/BambuSession.ts";
import { bambuTrustedCertificates } from "../bambu/bambuTls.ts";

const FIRST_REPORT_WAIT_MS = 4_000;
const TEST_CONNECTION_WAIT_MS = 10_000;

const failure = (config: BambuLanPrinterConfig, operation: string, reason: string) =>
  new PrinterOperationError({ operation, printerId: config.id, reason });

/** Validates the configured address and resolves it to a checked IP to dial. */
const resolveTarget = Effect.fn("BambuLanAdapter.resolveTarget")(function* (
  config: BambuLanPrinterConfig,
  secret: string,
  operation: string,
) {
  if (!secret.trim()) {
    return yield* failure(
      config,
      operation,
      "Enter the printer's access code. It is on the printer under Settings > Network.",
    );
  }
  const url = yield* validatePrinterBaseUrl(config.baseUrl, operation, config.id);
  const pins = yield* pinPrinterHostAddress(config.baseUrl, operation, config.id);
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const resolved = [...pins.values()][0]?.candidates[0]?.address ?? host;
  const target: BambuSessionTarget = {
    address: resolved,
    host,
    serial: config.serial.trim(),
    accessCode: secret.trim(),
    ca: bambuTrustedCertificates(),
  };
  return target;
});

function commandFor(action: PrinterAction): Record<string, unknown> | null {
  const gcode = (param: string) => ({ print: { command: "gcode_line", param: `${param}\n` } });
  switch (action.kind) {
    case "pause":
    case "resume":
    case "stop":
      return { print: { command: action.kind } };
    case "setChamberLight":
      return {
        system: {
          command: "ledctrl",
          led_node: "chamber_light",
          led_mode: action.on ? "on" : "off",
          led_on_time: 500,
          led_off_time: 500,
          loop_times: 0,
          interval_time: 0,
        },
      };
    case "setSpeedProfile":
      return { print: { command: "print_speed", param: SPEED_PROFILE_LEVEL[action.profile] } };
    case "setFanSpeed": {
      const fanIndex = action.fan === "cooling" ? 1 : action.fan === "aux" ? 2 : 3;
      return gcode(`M106 P${fanIndex} S${Math.round(action.percent * 2.55)}`);
    }
    case "setNozzleTemp":
      return gcode(`M104 S${action.targetC}`);
    case "setBedTemp":
      return gcode(`M140 S${action.targetC}`);
    case "homeAxes":
      return gcode("G28");
    case "moveAxis":
      return gcode(`G91\nG1 ${action.axis}${action.distanceMm} F3000\nG90`);
    case "skipObjects":
      return { print: { command: "skip_objects", obj_list: [...action.objectIds] } };
    case "refresh":
      return null;
  }
}

function sessionError(session: BambuSession): string | null {
  return session.connected ? null : session.lastError;
}

export const bambuLanAdapter: PrinterAdapter<BambuLanPrinterConfig> = {
  poll: Effect.fn("BambuLanAdapter.poll")(function* (config, secret, previous, cache) {
    const target = yield* resolveTarget(config, secret, "poll");
    const session = getBambuSession(target);
    if (!session.report) {
      yield* Effect.promise(() => session.waitForReport(FIRST_REPORT_WAIT_MS));
    }
    if (!session.report) {
      return yield* failure(
        config,
        "poll",
        session.lastError ?? "Waiting for the first report from the printer.",
      );
    }
    session.requestFullRefresh();
    const now = yield* DateTime.now;
    const snapshot = bambuReportToSnapshot({
      config,
      report: session.report,
      version: session.version,
      connected: session.connected,
      lastMessageAtMs: session.lastMessageAtMs,
      connectionError: sessionError(session),
      previous,
      nowMs: DateTime.toEpochMillis(now),
    });
    return { snapshot, cache };
  }),

  testConnection: Effect.fn("BambuLanAdapter.testConnection")(function* (config, secret) {
    const target = yield* resolveTarget(config, secret, "testConnection");
    // A separate short-lived session, so a test never disturbs the one feeding the panel.
    const session = new BambuSession(target);
    session.ensureStarted();
    const gotReport = yield* Effect.promise(() => session.waitForReport(TEST_CONNECTION_WAIT_MS));
    const report = session.report;
    const version = session.version;
    const error = session.lastError;
    session.dispose();
    if (!gotReport || !report) {
      return yield* failure(
        config,
        "testConnection",
        error ?? "Connected, but the printer sent no status. Check the serial number.",
      );
    }
    const model = bambuModelName(config.serial, version);
    const locked = bambuControlsLocked(report);
    const camera = bambuUsesFrameCamera(model);
    const modelText = model ?? "Bambu Lab printer";
    const firmware = version?.firmware ? ` (firmware ${version.firmware})` : "";
    return {
      ok: true,
      model,
      printerName: config.label,
      online: true,
      hasCamera: camera,
      hasCoverImage: false,
      summary: locked
        ? `Connected to ${modelText}${firmware}. Developer mode is off: status and camera work, and controls stay read-only.`
        : `Connected to ${modelText}${firmware}. Developer mode is on: status, camera and controls all work.`,
    };
  }),

  executeAction: Effect.fn("BambuLanAdapter.executeAction")(function* (
    config,
    secret,
    action: PrinterAction,
  ) {
    const target = yield* resolveTarget(config, secret, action.kind);
    const session = getBambuSession(target);
    if (action.kind === "refresh") {
      session.requestFullRefresh(true);
      return;
    }
    const report = session.report;
    if (report && bambuControlsLocked(report) && action.kind !== "setChamberLight") {
      return yield* failure(config, action.kind, BAMBU_CONTROLS_LOCKED_REASON);
    }
    const command = commandFor(action);
    if (!command) return;
    yield* Effect.try({
      try: () => session.send(command),
      catch: (cause) =>
        failure(config, action.kind, cause instanceof Error ? cause.message : String(cause)),
    });
  }),

  fetchMedia: Effect.fn("BambuLanAdapter.fetchMedia")(
    function* (config, secret, kind, current, cache) {
      if (kind !== "camera") {
        return yield* failure(
          config,
          `media.${kind}`,
          `The direct Bambu connection does not provide the "${kind}" image yet.`,
        );
      }
      const target = yield* resolveTarget(config, secret, "bambu.camera");
      const bytes = yield* Effect.tryPromise({
        try: () =>
          fetchBambuCameraFrame({
            address: target.address,
            accessCode: target.accessCode,
            ca: target.ca,
          }),
        catch: (cause) =>
          failure(config, "bambu.camera", cause instanceof Error ? cause.message : String(cause)),
      });
      const contentType = detectImageMimeType(bytes);
      if (contentType === null) {
        return yield* failure(config, "bambu.camera", "The printer camera sent a non-image frame.");
      }
      const nowIso = DateTime.formatIso(yield* DateTime.now);
      return {
        asset: {
          bytes,
          contentType,
          capturedAt: nowIso,
          stale: !(current?.online ?? true),
          online: current?.online ?? true,
          hash: fingerprintBytes(bytes),
        },
        cache,
      };
    },
  ),
};
