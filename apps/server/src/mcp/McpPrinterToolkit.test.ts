import { describe, expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  OrchestratorMcpFailure,
  PrinterId,
  type PrinterServiceState,
  type PrinterSnapshot,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { McpSchema, McpServer } from "effect/ai";

import * as PeerForwarding from "../peer/PeerForwarding.ts";
import * as PeerLinks from "../peer/PeerLinks.ts";
import * as PrinterService from "../printer/PrinterService.ts";
import * as ServerSettings from "../serverSettings.ts";
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
  Layer.provideMerge(
    ServerSettings.layerTest({
      enablePrinterSupport: true,
      enableAgentPrinterAccess: true,
      linkedEnvironmentsEnabled: true,
    }),
  ),
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

  it.effect(
    "routes printer_list, printer_status, printer_camera_snapshot, and printer_open through linked T3 Connect proxies",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const proxyEnvId = EnvironmentId.make("env-home-proxy");
          const openedSessions: Array<PrinterServiceState["sessions"][number]> = [];
          const forwardedCalls: Array<{ readonly tool: string; readonly env: EnvironmentId }> = [];

          let localEnabled = false;
          let localAgentAccessEnabled = false;
          let localPrinters: ReadonlyArray<PrinterSnapshot> = [];
          const emptyLocalState = (): PrinterServiceState => ({
            enabled: localEnabled,
            agentAccessEnabled: localAgentAccessEnabled,
            mediaBasePath: "/api/printer-media",
            printers: localPrinters,
            sessions: [...openedSessions],
            revision: 1,
          });

          const layerRemoteNode = McpHttpServer.layerPrinterToolkit.pipe(
            Layer.provideMerge(McpHttpServer.layerInProcessMcpServer),
            Layer.provideMerge(McpToolAccessTestkit.liveThreadsLayer),
            Layer.provideMerge(
              ServerSettings.layerTest({
                enablePrinterSupport: true,
                enableAgentPrinterAccess: true,
                linkedEnvironmentsEnabled: true,
              }),
            ),
            Layer.provideMerge(
              Layer.mock(PrinterService.PrinterService)({
                state: Effect.sync(emptyLocalState),
                list: () => Effect.sync(emptyLocalState),
                open: (input) =>
                  Effect.sync(() => {
                    const session = {
                      threadId: input.threadId,
                      printerId: input.printerId,
                      ...(input.proxyEnvironmentId
                        ? { proxyEnvironmentId: input.proxyEnvironmentId }
                        : {}),
                      ...(input.printerLabel ? { printerLabel: input.printerLabel } : {}),
                      openedAt: "2026-11-21T07:00:00.000Z",
                    };
                    openedSessions.push(session);
                    return session;
                  }),
                close: (input) =>
                  Effect.sync(() => {
                    for (let i = openedSessions.length - 1; i >= 0; i -= 1) {
                      const session = openedSessions[i]!;
                      if (session.threadId !== input.threadId) continue;
                      if (input.printerId !== undefined && session.printerId !== input.printerId) {
                        continue;
                      }
                      if (
                        input.proxyEnvironmentId === null &&
                        session.proxyEnvironmentId !== undefined
                      ) {
                        continue;
                      }
                      if (
                        input.proxyEnvironmentId !== undefined &&
                        input.proxyEnvironmentId !== null &&
                        session.proxyEnvironmentId !== input.proxyEnvironmentId
                      ) {
                        continue;
                      }
                      openedSessions.splice(i, 1);
                    }
                  }),
                sessionsForThread: () => Effect.sync(() => [...openedSessions]),
              }),
            ),
            Layer.provideMerge(
              Layer.mock(PeerLinks.PeerLinks)({
                enabled: Effect.succeed(true),
                list: Effect.succeed([
                  {
                    environmentId: proxyEnvId,
                    label: "Home Proxy",
                    urls: ["https://home.t3.test"],
                    status: "reachable",
                    access: "read-only",
                    linkedAt: DateTime.makeUnsafe(0),
                    expiresAt: DateTime.makeUnsafe("2099-01-01T00:00:00.000Z"),
                    lastReachedAt: null,
                    lastError: null,
                  },
                ]),
                get: (id) =>
                  Effect.succeed(
                    id === proxyEnvId
                      ? Option.some({
                          environmentId: proxyEnvId,
                          label: "Home Proxy",
                          urls: ["https://home.t3.test"],
                          access: "read-only" as const,
                          linkedAt: DateTime.makeUnsafe(0),
                          expiresAt: DateTime.makeUnsafe("2099-01-01T00:00:00.000Z"),
                          lastReachedAt: null,
                          lastError: null,
                        })
                      : Option.none(),
                  ),
              }),
            ),
            Layer.provideMerge(
              Layer.mock(PeerForwarding.PeerForwarding)({
                call: (_scope, tool, targetEnvId) => {
                  forwardedCalls.push({ tool: tool.name, env: targetEnvId });
                  if (tool.name === "printer_list") {
                    return Effect.succeed({
                      enabled: true,
                      printers: [
                        {
                          id: printerId,
                          label: "Studio P1S",
                          kind: "home-assistant-bambu",
                          model: "Bambu Lab P1S",
                          online: true,
                          stale: false,
                          status: "running",
                          stageLabel: "Printing",
                          fileName: "desk-jig.gcode.3mf",
                          progressPercent: 42,
                          hasCamera: true,
                          openInThread: false,
                          environmentId: proxyEnvId,
                        },
                      ],
                    }) as never;
                  }
                  if (tool.name === "printer_status") {
                    return Effect.succeed({
                      printer: mockPrinterSnapshot,
                      cameraAgeSeconds: 2,
                      environmentId: proxyEnvId,
                      note: "Live via Home Proxy.",
                    }) as never;
                  }
                  if (tool.name === "printer_camera_snapshot") {
                    return Effect.succeed({
                      printerId,
                      printerLabel: "Studio P1S",
                      online: true,
                      stale: false,
                      capturedAt: "2026-11-21T07:00:00.000Z",
                      cameraAgeSeconds: 2,
                      environmentId: proxyEnvId,
                      screenshot: {
                        mimeType: "image/jpeg",
                        data: Buffer.from(sampleJpeg).toString("base64"),
                        width: 16,
                        height: 12,
                      },
                    }) as never;
                  }
                  return Effect.die(`Unexpected forwarded tool ${tool.name}`);
                },
              }),
            ),
          );

          yield* Effect.gen(function* () {
            const server = yield* McpServer.McpServer;
            const callAsThread = Effect.provideService(McpInvocationContext.McpInvocationContext, {
              ...invocation(["printer"]),
              linkedEnvironments: true,
            });

            // Auto-discovers printer on Home Proxy with 0 local printers.
            const listed = yield* server
              .callTool({ name: "printer_list", arguments: {} })
              .pipe(callAsThread, Effect.provideService(McpSchema.McpServerClient, client));
            expect(listed.isError, JSON.stringify(listed.content)).toBe(false);
            expect(listed.structuredContent).toMatchObject({
              enabled: true,
              printers: [
                {
                  id: "p1s-studio",
                  environmentId: proxyEnvId,
                  environmentLabel: "Home Proxy",
                },
              ],
            });

            // Auto-routes printer_open and records proxyEnvironmentId on the local thread's session.
            const opened = yield* server
              .callTool({ name: "printer_open", arguments: {} })
              .pipe(callAsThread, Effect.provideService(McpSchema.McpServerClient, client));
            expect(opened.isError, JSON.stringify(opened.content)).toBe(false);
            expect(opened.structuredContent).toMatchObject({
              printer: { id: "p1s-studio" },
              environmentId: proxyEnvId,
              environmentLabel: "Home Proxy",
            });
            expect(openedSessions).toHaveLength(1);
            expect(openedSessions[0]?.proxyEnvironmentId).toBe(proxyEnvId);

            // Subsequent printer_status and printer_camera_snapshot reuse the open proxied session directly.
            const callsBeforeReuse = forwardedCalls.length;
            const status = yield* server
              .callTool({ name: "printer_status", arguments: {} })
              .pipe(callAsThread, Effect.provideService(McpSchema.McpServerClient, client));
            expect(status.isError, JSON.stringify(status.content)).toBe(false);
            expect(status.structuredContent).toMatchObject({
              printer: { id: "p1s-studio" },
              environmentId: proxyEnvId,
              environmentLabel: "Home Proxy",
            });

            const snap = yield* server
              .callTool({ name: "printer_camera_snapshot", arguments: {} })
              .pipe(callAsThread, Effect.provideService(McpSchema.McpServerClient, client));
            expect(snap.isError, JSON.stringify(snap.content)).toBe(false);
            expect(snap.content.map((entry) => entry.type)).toEqual(["text", "image"]);
            expect(snap.structuredContent).toMatchObject({
              printerId: "p1s-studio",
              environmentId: proxyEnvId,
              environmentLabel: "Home Proxy",
              screenshot: { mimeType: "image/jpeg", width: 16, height: 12 },
            });
            expect(forwardedCalls.slice(callsBeforeReuse)).toEqual([
              { tool: "printer_status", env: proxyEnvId },
              { tool: "printer_camera_snapshot", env: proxyEnvId },
            ]);

            // Explicit environmentId printer_list preserves openInThread for the originating thread.
            const targetedList = yield* server
              .callTool({ name: "printer_list", arguments: { environmentId: proxyEnvId } })
              .pipe(callAsThread, Effect.provideService(McpSchema.McpServerClient, client));
            expect(targetedList.isError, JSON.stringify(targetedList.content)).toBe(false);
            expect(targetedList.structuredContent).toMatchObject({
              enabled: true,
              printers: [
                {
                  id: "p1s-studio",
                  environmentId: proxyEnvId,
                  environmentLabel: "Home Proxy",
                  openInThread: true,
                },
              ],
            });

            // A caller without the "printer" capability cannot bypass it via explicit environmentId.
            const withoutPrinterCap = Effect.provideService(
              McpInvocationContext.McpInvocationContext,
              {
                ...invocation([]),
                linkedEnvironments: true,
              },
            );
            const callsBeforeDenied = forwardedCalls.length;
            const deniedTargeted = yield* server
              .callTool({ name: "printer_status", arguments: { environmentId: proxyEnvId } })
              .pipe(withoutPrinterCap, Effect.provideService(McpSchema.McpServerClient, client));
            expect(deniedTargeted.isError).toBe(true);
            expect(forwardedCalls.length).toBe(callsBeforeDenied);

            // When an unrelated local printer is also configured, an untargeted read prefers the thread's sole open proxy printer.
            localEnabled = true;
            localAgentAccessEnabled = true;
            localPrinters = [
              {
                ...mockPrinterSnapshot,
                id: PrinterId.make("local-other"),
                label: "Local Other",
              },
            ];
            const callsBeforeMixed = forwardedCalls.length;
            const mixedStatus = yield* server
              .callTool({ name: "printer_status", arguments: {} })
              .pipe(callAsThread, Effect.provideService(McpSchema.McpServerClient, client));
            expect(mixedStatus.isError, JSON.stringify(mixedStatus.content)).toBe(false);
            expect(mixedStatus.structuredContent).toMatchObject({
              printer: { id: "p1s-studio" },
              environmentId: proxyEnvId,
            });
            expect(forwardedCalls.slice(callsBeforeMixed)).toEqual([
              { tool: "printer_status", env: proxyEnvId },
            ]);

            // printer_close scoped by environmentId closes only that environment's session.
            openedSessions.push({
              threadId,
              printerId,
              openedAt: "2026-11-21T07:05:00.000Z",
            });
            yield* server
              .callTool({
                name: "printer_close",
                arguments: { printerId: "p1s-studio", environmentId: proxyEnvId },
              })
              .pipe(callAsThread, Effect.provideService(McpSchema.McpServerClient, client));
            expect(openedSessions).toHaveLength(1);
            expect(openedSessions[0]?.proxyEnvironmentId).toBeUndefined();

            // Linked peer callers never hop onward (single-hop fence) and require local agentAccessEnabled opt-in even when printer support is on with a configured printer.
            localEnabled = true;
            localAgentAccessEnabled = false;
            const linkedCaller = Effect.provideService(McpInvocationContext.McpInvocationContext, {
              environmentId,
              requestNamespace: "client:peer-1",
              thread: undefined,
              client: {
                sessionId: "peer-1",
                label: "T3 Code · Other",
                access: "read-only",
                linked: true,
              },
              capabilities: new Set<McpInvocationContext.McpCapability>(["printer"]),
              issuedAt: 1,
              linkedEnvironments: true,
            });
            const callsBeforePeer = forwardedCalls.length;
            const peerList = yield* server
              .callTool({ name: "printer_list", arguments: {} })
              .pipe(linkedCaller, Effect.provideService(McpSchema.McpServerClient, client));
            expect(peerList.isError).toBe(false);
            expect(peerList.structuredContent).toEqual({ enabled: false, printers: [] });
            const peerStatus = yield* server
              .callTool({ name: "printer_status", arguments: {} })
              .pipe(linkedCaller, Effect.provideService(McpSchema.McpServerClient, client));
            expect(peerStatus.isError).toBe(true);
            expect(forwardedCalls.length).toBe(callsBeforePeer);

            // Explicit local environmentId stays strictly local and never returns a remote open session or peer printers.
            localEnabled = true;
            localAgentAccessEnabled = true;
            localPrinters = [];
            openedSessions.length = 0;
            openedSessions.push({
              threadId,
              printerId,
              proxyEnvironmentId: proxyEnvId,
              openedAt: "2026-11-21T07:10:00.000Z",
            });
            const callsBeforeExplicitLocal = forwardedCalls.length;
            const localOnlyList = yield* server
              .callTool({ name: "printer_list", arguments: { environmentId } })
              .pipe(callAsThread, Effect.provideService(McpSchema.McpServerClient, client));
            expect(localOnlyList.isError).toBe(false);
            expect(localOnlyList.structuredContent).toEqual({ enabled: true, printers: [] });

            const localOnlyStatus = yield* server
              .callTool({ name: "printer_status", arguments: { environmentId } })
              .pipe(callAsThread, Effect.provideService(McpSchema.McpServerClient, client));
            expect(localOnlyStatus.isError).toBe(true);

            const localOnlySnap = yield* server
              .callTool({ name: "printer_camera_snapshot", arguments: { environmentId } })
              .pipe(callAsThread, Effect.provideService(McpSchema.McpServerClient, client));
            expect(localOnlySnap.isError).toBe(true);
            expect(forwardedCalls.length).toBe(callsBeforeExplicitLocal);
          }).pipe(Effect.provide(layerRemoteNode));
        }),
      ),
  );

  it.effect(
    "enforces invocation-time project deny across both local reads and explicit peer forwarding, rejects 0x0 images, and reports unreachable peers",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const proxyEnvId = EnvironmentId.make("env-home-proxy");
          const flakyEnvId = EnvironmentId.make("env-flaky-proxy");
          const forwardedCalls: Array<{ readonly tool: string; readonly env: EnvironmentId }> = [];

          // 1. Project override enableAgentPrinterAccess=false blocks BOTH local and explicit remote forwarding.
          const projectDeniedLayer = McpHttpServer.layerPrinterToolkit.pipe(
            Layer.provideMerge(McpHttpServer.layerInProcessMcpServer),
            Layer.provideMerge(McpToolAccessTestkit.liveThreadsLayer),
            Layer.provideMerge(layerPrinterServiceMock),
            Layer.provideMerge(
              ServerSettings.layerTest({
                enablePrinterSupport: true,
                enableAgentPrinterAccess: true,
                projectSettingsOverrides: {
                  [ProjectId.make("project:mcp-test")]: { enableAgentPrinterAccess: false },
                },
              }),
            ),
            Layer.provideMerge(
              Layer.mock(PeerForwarding.PeerForwarding)({
                call: (_scope, tool, targetEnvId) => {
                  forwardedCalls.push({ tool: tool.name, env: targetEnvId });
                  return Effect.succeed({ enabled: true, printers: [] }) as never;
                },
              }),
            ),
          );

          yield* Effect.gen(function* () {
            const server = yield* McpServer.McpServer;
            const callAsThread = Effect.provideService(McpInvocationContext.McpInvocationContext, {
              ...invocation(["printer"]),
              linkedEnvironments: true,
            });
            const localStatus = yield* server
              .callTool({ name: "printer_status", arguments: {} })
              .pipe(callAsThread, Effect.provideService(McpSchema.McpServerClient, client));
            expect(localStatus.isError).toBe(true);

            const forwardedStatus = yield* server
              .callTool({ name: "printer_status", arguments: { environmentId: proxyEnvId } })
              .pipe(callAsThread, Effect.provideService(McpSchema.McpServerClient, client));
            expect(forwardedStatus.isError).toBe(true);

            const forwardedSnap = yield* server
              .callTool({
                name: "printer_camera_snapshot",
                arguments: { environmentId: proxyEnvId },
              })
              .pipe(callAsThread, Effect.provideService(McpSchema.McpServerClient, client));
            expect(forwardedSnap.isError).toBe(true);
            expect(forwardedCalls).toHaveLength(0);
          }).pipe(Effect.provide(projectDeniedLayer));

          // 2. Truncated 0x0 image bytes fail printer_camera_snapshot instead of returning width=0/height=0.
          const truncatedImageLayer = McpHttpServer.layerPrinterToolkit.pipe(
            Layer.provideMerge(McpHttpServer.layerInProcessMcpServer),
            Layer.provideMerge(McpToolAccessTestkit.liveThreadsLayer),
            Layer.provideMerge(
              ServerSettings.layerTest({
                enablePrinterSupport: true,
                enableAgentPrinterAccess: true,
                linkedEnvironmentsEnabled: true,
              }),
            ),
            Layer.provideMerge(
              Layer.mock(PrinterService.PrinterService)({
                state: Effect.succeed(mockState),
                list: () => Effect.succeed(mockState),
                sessionsForThread: () => Effect.succeed([]),
                fetchMedia: () =>
                  Effect.succeed({
                    bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]),
                    contentType: "image/jpeg",
                    capturedAt: "2026-11-21T01:00:00.000Z",
                    stale: false,
                    online: true,
                    hash: "tiny",
                  }),
              }),
            ),
          );
          yield* Effect.gen(function* () {
            const server = yield* McpServer.McpServer;
            const snap = yield* server
              .callTool({ name: "printer_camera_snapshot", arguments: {} })
              .pipe(
                Effect.provideService(
                  McpInvocationContext.McpInvocationContext,
                  invocation(["printer"]),
                ),
                Effect.provideService(McpSchema.McpServerClient, client),
              );
            expect(snap.isError).toBe(true);
          }).pipe(Effect.provide(truncatedImageLayer));

          // 3. Unreachable/unavailable peers are surfaced clearly and prevent ambiguous printerId auto-selection without environmentId.
          const emptyLocal: PrinterServiceState = {
            enabled: false,
            agentAccessEnabled: false,
            mediaBasePath: "/api/printer-media",
            printers: [],
            sessions: [],
            revision: 1,
          };
          const unreachableLayer = McpHttpServer.layerPrinterToolkit.pipe(
            Layer.provideMerge(McpHttpServer.layerInProcessMcpServer),
            Layer.provideMerge(McpToolAccessTestkit.liveThreadsLayer),
            Layer.provideMerge(
              ServerSettings.layerTest({
                enablePrinterSupport: false,
                enableAgentPrinterAccess: true,
                linkedEnvironmentsEnabled: true,
              }),
            ),
            Layer.provideMerge(
              Layer.mock(PrinterService.PrinterService)({
                state: Effect.succeed(emptyLocal),
                list: () => Effect.succeed(emptyLocal),
                sessionsForThread: () => Effect.succeed([]),
              }),
            ),
            Layer.provideMerge(
              Layer.mock(PeerLinks.PeerLinks)({
                enabled: Effect.succeed(true),
                list: Effect.succeed([
                  {
                    environmentId: proxyEnvId,
                    label: "Home Proxy",
                    urls: ["https://home.t3.test"],
                    status: "reachable",
                    access: "read-only",
                    linkedAt: DateTime.makeUnsafe(0),
                    expiresAt: DateTime.makeUnsafe("2099-01-01T00:00:00.000Z"),
                    lastReachedAt: null,
                    lastError: null,
                  },
                  {
                    environmentId: flakyEnvId,
                    label: "Garage Proxy",
                    urls: ["https://garage.t3.test"],
                    status: "unreachable",
                    access: "read-only",
                    linkedAt: DateTime.makeUnsafe(0),
                    expiresAt: DateTime.makeUnsafe("2099-01-01T00:00:00.000Z"),
                    lastReachedAt: null,
                    lastError: "offline",
                  },
                ]),
                get: () => Effect.succeedNone,
              }),
            ),
            Layer.provideMerge(
              Layer.mock(PeerForwarding.PeerForwarding)({
                call: (_scope, tool, targetEnvId) => {
                  if (targetEnvId === proxyEnvId && tool.name === "printer_list") {
                    return Effect.succeed({
                      enabled: true,
                      printers: [
                        {
                          id: printerId,
                          label: "Studio P1S",
                          kind: "home-assistant-bambu",
                          model: "Bambu Lab P1S",
                          online: true,
                          stale: false,
                          status: "running",
                          stageLabel: "Printing",
                          fileName: "desk-jig.gcode.3mf",
                          progressPercent: 42,
                          hasCamera: true,
                          openInThread: false,
                          environmentId: proxyEnvId,
                        },
                      ],
                    }) as never;
                  }
                  if (targetEnvId === proxyEnvId && tool.name === "printer_camera_snapshot") {
                    return Effect.succeed({
                      printerId,
                      printerLabel: "Studio P1S",
                      online: true,
                      stale: false,
                      capturedAt: "2026-11-21T07:00:00.000Z",
                      cameraAgeSeconds: 2,
                      environmentId: proxyEnvId,
                      screenshot: {
                        mimeType: "image/jpeg",
                        data: Buffer.from(sampleJpeg).toString("base64"),
                        width: 16,
                        height: 12,
                      },
                    }) as never;
                  }
                  return Effect.fail(
                    new OrchestratorMcpFailure({
                      code: "orchestration_error",
                      message: "Connection refused",
                    }),
                  );
                },
              }),
            ),
          );
          yield* Effect.gen(function* () {
            const server = yield* McpServer.McpServer;
            const callFleet = Effect.provideService(McpInvocationContext.McpInvocationContext, {
              ...invocation(["printer"]),
              linkedEnvironments: true,
            });
            // Even with an explicit printerId, an unreachable non-expired peer could host the same ID -> must require environmentId.
            const ambiguousSnap = yield* server
              .callTool({
                name: "printer_camera_snapshot",
                arguments: { printerId: "p1s-studio" },
              })
              .pipe(callFleet, Effect.provideService(McpSchema.McpServerClient, client));
            expect(ambiguousSnap.isError).toBe(true);
            expect(JSON.stringify(ambiguousSnap.content)).toContain("Garage Proxy");

            // Passing explicit environmentId succeeds cleanly.
            const targetedSnap = yield* server
              .callTool({
                name: "printer_camera_snapshot",
                arguments: { printerId: "p1s-studio", environmentId: proxyEnvId },
              })
              .pipe(callFleet, Effect.provideService(McpSchema.McpServerClient, client));
            expect(targetedSnap.isError).toBe(false);
          }).pipe(Effect.provide(unreachableLayer));
        }),
      ),
  );
});
