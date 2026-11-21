import {
  type PrinterServiceState,
  type PrinterSnapshot,
  PrinterToolUnavailableError,
  type ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import { imageDimensions } from "../../../printer/PrinterAdapter.ts";
import * as PrinterService from "../../../printer/PrinterService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { PrinterSnapshotToolkit, PrinterStandardToolkit, type PrinterToolkit } from "./tools.ts";

const requirePrinterAccess = McpInvocationContext.requireThreadMcpCapability("printer").pipe(
  Effect.mapError(
    () =>
      new PrinterToolUnavailableError({
        reason:
          "3D Printer agent access is disabled in T3 Code. Enable 3D Printers and Agent printer access in Settings -> 3D Printers; the change applies when the agent session next starts.",
      }),
  ),
);

function resolvePrinter(
  state: PrinterServiceState,
  threadId: ThreadId,
  requested: string | undefined,
): Effect.Effect<PrinterSnapshot, PrinterToolUnavailableError> {
  if (!state.enabled) {
    return Effect.fail(
      new PrinterToolUnavailableError({
        reason: "3D Printer support is disabled in Settings -> 3D Printers.",
      }),
    );
  }
  if (state.printers.length === 0) {
    return Effect.fail(
      new PrinterToolUnavailableError({
        reason: "No 3D printers are configured. Add one in Settings -> 3D Printers.",
      }),
    );
  }

  const trimmed = requested?.trim();
  if (!trimmed) {
    const openSessions = state.sessions.filter((session) => session.threadId === threadId);
    if (openSessions.length === 1) {
      const openPrinter = state.printers.find((p) => p.id === openSessions[0]!.printerId);
      if (openPrinter) return Effect.succeed(openPrinter);
    }
    if (state.printers.length === 1) {
      return Effect.succeed(state.printers[0]!);
    }
    const candidates = state.printers.map((p) => `${p.id} (${p.label})`).join(", ");
    return Effect.fail(
      new PrinterToolUnavailableError({
        reason: `Multiple 3D printers are configured (${candidates}). Pass printerId to choose one.`,
      }),
    );
  }

  const exactId = state.printers.find((p) => p.id === trimmed);
  if (exactId) return Effect.succeed(exactId);

  const lower = trimmed.toLowerCase();
  const labelMatches = state.printers.filter(
    (p) =>
      p.id.toLowerCase() === lower ||
      p.label.toLowerCase() === lower ||
      p.hardware.name?.toLowerCase() === lower,
  );
  if (labelMatches.length === 1) return Effect.succeed(labelMatches[0]!);
  if (labelMatches.length > 1) {
    const candidates = labelMatches.map((p) => `${p.id} (${p.label})`).join(", ");
    return Effect.fail(
      new PrinterToolUnavailableError({
        reason: `Printer selector "${trimmed}" is ambiguous (${candidates}). Pass the exact printerId.`,
      }),
    );
  }

  const available = state.printers.map((p) => `${p.id} (${p.label})`).join(", ");
  return Effect.fail(
    new PrinterToolUnavailableError({
      reason: `Printer "${trimmed}" was not found. Available printers: ${available}.`,
    }),
  );
}

function cameraAgeSeconds(printer: PrinterSnapshot, nowMs: number): number | null {
  if (!printer.media.cameraUpdatedAt) return null;
  const parsed = Date.parse(printer.media.cameraUpdatedAt);
  if (!Number.isFinite(parsed)) return null;
  return Math.max(0, Math.round((nowMs - parsed) / 1000));
}

const handlers = {
  printer_list: McpToolAccess.readsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* requirePrinterAccess;
      const printers = yield* PrinterService.PrinterService;
      const state = yield* printers.list({ refresh: input.refresh ?? true });
      const openIds = new Set(
        state.sessions
          .filter((session) => session.threadId === scope.thread.threadId)
          .map((session) => session.printerId),
      );
      return {
        enabled: state.enabled,
        printers: state.printers.map((printer) => ({
          id: printer.id,
          label: printer.label,
          kind: printer.kind,
          model: printer.hardware.model,
          online: printer.online,
          stale: printer.stale,
          status: printer.job.status,
          stageLabel: printer.job.stageLabel,
          fileName: printer.job.fileName,
          progressPercent: printer.job.progressPercent,
          hasCamera: printer.media.hasCamera,
          openInThread: openIds.has(printer.id),
        })),
      };
    }),
  ),

  printer_open: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* requirePrinterAccess;
      const printers = yield* PrinterService.PrinterService;
      const state = yield* printers.list({ refresh: false });
      const target = yield* resolvePrinter(state, scope.thread.threadId, input.printerId);
      yield* printers.open({ threadId: scope.thread.threadId, printerId: target.id });
      const refreshedState = yield* printers.state;
      const updated = refreshedState.printers.find((p) => p.id === target.id) ?? target;
      return {
        printer: updated,
        note: `Opened ${updated.label} in the Printer panel. Hardware write controls stay in the panel UI for human confirmation.`,
      };
    }),
  ),

  printer_status: McpToolAccess.readsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* requirePrinterAccess;
      const printers = yield* PrinterService.PrinterService;
      const state = yield* printers.list({ refresh: false });
      const target = yield* resolvePrinter(state, scope.thread.threadId, input.printerId);
      const refreshed = yield* printers.list({ printerId: target.id, refresh: true });
      const updated = refreshed.printers.find((p) => p.id === target.id) ?? target;
      const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
      const age = cameraAgeSeconds(updated, nowMs);
      const note = updated.stale
        ? (updated.staleReason ??
          "Telemetry is stale or printer is offline; do not treat values as live.")
        : "Telemetry is live. ETA values are printer estimates; recommend pause or stop to the user rather than modifying hardware directly.";
      return {
        printer: updated,
        cameraAgeSeconds: age,
        note,
      };
    }),
  ),

  printer_camera_snapshot: McpToolAccess.readsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* requirePrinterAccess;
      const printers = yield* PrinterService.PrinterService;
      const state = yield* printers.list({ refresh: false });
      const target = yield* resolvePrinter(state, scope.thread.threadId, input.printerId);
      if (!target.media.hasCamera) {
        return yield* new PrinterToolUnavailableError({
          reason: `Printer "${target.label}" does not expose a live camera feed.`,
        });
      }
      const asset = yield* printers.fetchMedia(target.id, "camera");
      const dims = imageDimensions(asset.bytes, asset.contentType);
      const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
      const latestState = yield* printers.state;
      const updatedTarget = latestState.printers.find((p) => p.id === target.id) ?? target;
      const parsedCapturedMs = Date.parse(asset.capturedAt);
      const age =
        cameraAgeSeconds(updatedTarget, nowMs) ??
        (Number.isFinite(parsedCapturedMs)
          ? Math.max(0, Math.round((nowMs - parsedCapturedMs) / 1000))
          : null);
      return {
        printerId: target.id,
        printerLabel: target.label,
        online: asset.online,
        stale: asset.stale,
        capturedAt: asset.capturedAt,
        cameraAgeSeconds: age,
        screenshot: {
          mimeType: asset.contentType,
          data: Buffer.from(asset.bytes).toString("base64"),
          width: dims.width,
          height: dims.height,
        },
      };
    }),
  ),

  printer_close: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* requirePrinterAccess;
      const printers = yield* PrinterService.PrinterService;
      if (input.printerId) {
        const state = yield* printers.state;
        const target = yield* resolvePrinter(state, scope.thread.threadId, input.printerId);
        yield* printers.close({ threadId: scope.thread.threadId, printerId: target.id });
      } else {
        yield* printers.close({ threadId: scope.thread.threadId });
      }
      return {};
    }),
  ),
} satisfies McpToolAccess.Handlers<typeof PrinterToolkit.tools>;

const { printer_camera_snapshot, ...standardHandlers } = handlers;

export const layerStandard = McpToolAccess.toLayer(PrinterStandardToolkit, standardHandlers);

export const layerSnapshot = McpToolAccess.toLayer(PrinterSnapshotToolkit, {
  printer_camera_snapshot,
});
