import { describe, expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  PrinterId,
  type PrinterServiceState,
  type PrinterSnapshot,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { McpSchema, McpServer } from "effect/ai";

import * as PrinterService from "../printer/PrinterService.ts";
import * as McpHttpServer from "./McpHttpServer.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";
import * as McpToolAccessTestkit from "./McpToolAccess.testkit.ts";

const environmentId = EnvironmentId.make("environment-printer-test");
const threadId = ThreadId.make("thread-printer-test");
const printerId = PrinterId.make("p1s-studio");

const invocation = (capabilities: ReadonlyArray<McpInvocationContext.McpCapability>) => ({
  environmentId,
  requestNamespace: "provider-session-printer-test",
  thread: {
    threadId,
    providerSessionId: "provider-session-printer-test",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
  capabilities: new Set(capabilities),
  issuedAt: 1,
});

const client = McpSchema.McpServerClient.of({
  clientId: 1,
  clientCapabilities: {},
  clientInfo: { name: "mcp-test", version: "1.0.0" },
  protocolVersion: "2025-06-18",
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "mcp-test", version: "1.0.0" },
  },
  getClient: Effect.die("unused"),
});

const mockPrinterSnapshot: PrinterSnapshot = {
  id: printerId,
  label: "Studio P1S",
  kind: "home-assistant-bambu",
  connectionState: "connected",
  online: true,
  lastSyncedAt: "2026-11-21T01:00:00.000Z",
  lastUpdatedAt: "2026-11-21T00:59:58.000Z",
  stale: false,
  hardware: {
    model: "Bambu Lab P1S",
    name: "Studio P1S",
    serial: "01P00TEST0001",
    firmware: "01.08.02.00",
    ipAddress: null,
    nozzleSizeMm: 0.4,
    nozzleType: "Hardened Steel",
    bedType: "Textured PEI Plate",
    totalUsageHours: 420,
    wifiSignalDbm: -54,
    sdCardStatus: "present",
    connectionMode: "LAN",
    controlBlocked: false,
  },
  job: {
    status: "running",
    stage: "printing",
    stageLabel: "Printing",
    fileName: "desk-jig.gcode.3mf",
    displayName: "desk-jig",
    progressPercent: 42,
    currentLayer: 50,
    totalLayers: 120,
    remainingSeconds: 2700,
    elapsedSeconds: 1800,
    startedAt: "2026-11-21T00:30:00.000Z",
    estimatedFinishAt: "2026-11-21T01:45:00.000Z",
    weightGrams: 34.2,
    lengthMeters: 11.4,
    timelapse: false,
    printableObjects: [{ id: 1, name: "desk-jig.stl", skipped: false }],
  },
  thermals: {
    nozzle: { actualC: 215, targetC: 215 },
    bed: { actualC: 70, targetC: 70 },
    chamber: { actualC: 36, targetC: null },
    history: [
      {
        timestampMs: 1795222800000,
        nozzleActualC: 215,
        nozzleTargetC: 215,
        bedActualC: 70,
        bedTargetC: 70,
        chamberActualC: 36,
      },
    ],
  },
  fans: {
    coolingPercent: 80,
    auxPercent: 40,
    chamberPercent: 50,
    heatbreakPercent: 100,
  },
  lighting: {
    chamberLight: true,
  },
  speed: {
    profile: "standard",
    modifierPercent: 100,
  },
  filament: {
    extruderLoaded: true,
    amsUnits: [],
    externalSpool: {
      id: "external",
      label: "External Spool",
      material: "PETG",
      colorHex: "#38bdf8",
      remainingPercent: null,
      active: true,
      empty: false,
      external: true,
    },
  },
  alerts: [],
  media: {
    hasCamera: true,
    hasCoverImage: true,
    hasPickImage: true,
    cameraUpdatedAt: "2026-11-21T00:59:58.000Z",
    cameraStale: false,
    cameraRevision: 1,
    coverUpdatedAt: "2026-11-21T00:30:00.000Z",
  },
  capabilities: {
    canPause: true,
    canResume: false,
    canStop: true,
    canSetTemps: true,
    canSetFans: true,
    canSetLight: true,
    canSetSpeed: true,
    canJog: false,
    canSkipObjects: true,
  },
};

const mockState: PrinterServiceState = {
  enabled: true,
  agentAccessEnabled: true,
  printers: [mockPrinterSnapshot],
  sessions: [],
  mediaBasePath: "/api/printer-media",
  revision: 1,
};

// Minimal valid JPEG SOI + SOF0 (16x12) + EOI
const sampleJpeg = new Uint8Array([
  0xff, 0xd8, 0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x0c, 0x00, 0x10, 0x01, 0x01, 0x11, 0x00, 0xff,
  0xd9,
]);

const layerPrinterServiceMock = Layer.mock(PrinterService.PrinterService)({
  state: Effect.succeed(mockState),
  list: () => Effect.succeed(mockState),
  open: (input) =>
    Effect.succeed({
      threadId: input.threadId,
      printerId: input.printerId,
      openedAt: "2026-11-21T01:00:00.000Z",
    }),
  close: () => Effect.void,
  sessionsForThread: () => Effect.succeed([]),
  fetchMedia: () =>
    Effect.succeed({
      bytes: sampleJpeg,
      contentType: "image/jpeg",
      capturedAt: "2026-11-21T01:00:00.000Z",
      stale: false,
      online: true,
      hash: "abc123",
    }),
});

const layerTest = McpHttpServer.layerPrinterToolkit.pipe(
  Layer.provideMerge(McpHttpServer.layerInProcessMcpServer),
  Layer.provideMerge(McpToolAccessTestkit.liveThreadsLayer),
  Layer.provideMerge(layerPrinterServiceMock),
);

describe("McpPrinterToolkit", () => {
  it.effect(
    "registers read-only printer tools, enforces capability gating, and returns camera snapshots",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const server = yield* McpServer.McpServer;
          const names = server.tools.map(({ tool }) => tool.name).toSorted();
          expect(names).toEqual([
            "printer_camera_snapshot",
            "printer_close",
            "printer_list",
            "printer_open",
            "printer_status",
          ]);

          const callWith = (capabilities: ReadonlyArray<McpInvocationContext.McpCapability>) =>
            Effect.provideService(
              McpInvocationContext.McpInvocationContext,
              invocation(capabilities),
            );

          // Denied when printer capability is absent.
          const denied = yield* server
            .callTool({ name: "printer_list", arguments: {} })
            .pipe(callWith([]), Effect.provideService(McpSchema.McpServerClient, client));
          expect(denied.isError).toBe(true);

          // Listed with printer capability.
          const listed = yield* server
            .callTool({ name: "printer_list", arguments: {} })
            .pipe(callWith(["printer"]), Effect.provideService(McpSchema.McpServerClient, client));
          expect(listed.isError).toBe(false);
          expect(listed.structuredContent).toMatchObject({
            enabled: true,
            printers: [{ id: "p1s-studio", label: "Studio P1S", progressPercent: 42 }],
          });

          // Open panel for the sole printer without specifying printerId.
          const opened = yield* server
            .callTool({ name: "printer_open", arguments: {} })
            .pipe(callWith(["printer"]), Effect.provideService(McpSchema.McpServerClient, client));
          expect(opened.isError, JSON.stringify(opened.content)).toBe(false);
          expect(opened.structuredContent).toMatchObject({
            printer: { id: "p1s-studio", label: "Studio P1S" },
          });

          // Status returns structured telemetry.
          const status = yield* server
            .callTool({ name: "printer_status", arguments: {} })
            .pipe(callWith(["printer"]), Effect.provideService(McpSchema.McpServerClient, client));
          expect(status.isError).toBe(false);
          expect(status.structuredContent).toMatchObject({
            printer: { id: "p1s-studio", job: { progressPercent: 42 } },
          });

          // Snapshot returns both text metadata and image content block.
          const snap = yield* server
            .callTool({ name: "printer_camera_snapshot", arguments: {} })
            .pipe(callWith(["printer"]), Effect.provideService(McpSchema.McpServerClient, client));
          expect(snap.isError).toBe(false);
          expect(snap.content.map((entry) => entry.type)).toEqual(["text", "image"]);
          expect(snap.structuredContent).toMatchObject({
            printerId: "p1s-studio",
            printerLabel: "Studio P1S",
            online: true,
            stale: false,
            screenshot: { mimeType: "image/jpeg", width: 16, height: 12 },
          });

          // Close succeeds cleanly.
          const closed = yield* server
            .callTool({ name: "printer_close", arguments: {} })
            .pipe(callWith(["printer"]), Effect.provideService(McpSchema.McpServerClient, client));
          expect(closed.isError).toBe(false);
        }).pipe(Effect.provide(layerTest)),
      ),
  );
});
