// @effect-diagnostics nodeBuiltinImport:off - real local HTTP server test verifies undici Agent + fetch hostname pinning on Node 24.
import * as NodeHttp from "node:http";
import {
  type HomeAssistantBambuPrinterConfig,
  type MoonrakerPrinterConfig,
  PrinterId,
  SecretProviderId,
  ThreadId,
} from "@t3tools/contracts";
import * as SecretResolverCore from "@t3tools/secret-provider-core/server/SecretResolver";
import { it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import { FetchHttpClient, HttpClient, HttpClientResponse } from "effect/http";
import * as TestClock from "effect/testing/TestClock";
import { describe, expect } from "vite-plus/test";

import * as ServerSettings from "../serverSettings.ts";
import { SECRET_REDACTED } from "../settingsSecrets.ts";
import * as PrinterService from "./PrinterService.ts";
import {
  fetchPrinterBinary,
  fetchPrinterJson,
  PrinterDnsLookup,
  PrinterPinnedAddresses,
  validatePrinterBaseUrl,
} from "./PrinterUrlGuard.ts";

const FRESH_REPORTED_AT = "1970-01-01T00:00:00.000Z";

const P1S_CONFIG: HomeAssistantBambuPrinterConfig = {
  kind: "home-assistant-bambu",
  id: PrinterId.make("studio-p1s"),
  label: "Studio P1S",
  baseUrl: "http://192.168.1.50:8123",
  accessToken: "ha-secret-token",
  deviceId: "test-device-id-0001",
  pollIntervalSeconds: 4,
};

function makeMockHaHttpClient(options: {
  readonly status: "running" | "idle" | "unknown" | "pause";
  readonly fileName?: string | null;
  readonly controlBlocked?: boolean;
  readonly online?: boolean;
  readonly entityPrefix?: string;
  readonly templateDeviceId?: string | null;
  readonly onRequest?: (url: URL, authHeader: string | null) => void;
  readonly onServiceCall?: (path: string, body: unknown, authHeader: string | null) => void;
}) {
  const prefix = options.entityPrefix ?? "p1s_test";
  const makeStates = () => {
    const reported = FRESH_REPORTED_AT;
    return [
      {
        entity_id: `binary_sensor.${prefix}_online`,
        state: options.online === false ? "off" : "on",
        last_reported: reported,
      },
      {
        entity_id: `binary_sensor.${prefix}_hybrid_mqtt_control_blocked`,
        state: options.controlBlocked ? "on" : "off",
      },
      {
        entity_id: `sensor.${prefix}_print_status`,
        state: options.status,
        last_reported: reported,
      },
      ...(options.fileName === null
        ? []
        : [
            {
              entity_id: `sensor.${prefix}_gcode_filename`,
              state: options.fileName ?? "part-a.gcode.3mf",
            },
          ]),
      { entity_id: `sensor.${prefix}_nozzle_temperature`, state: "215" },
      {
        entity_id: `number.${prefix}_nozzle_target_temperature`,
        state: "215",
        attributes: { min: 0, max: 300 },
      },
      { entity_id: `sensor.${prefix}_bed_temperature`, state: "70" },
      {
        entity_id: `number.${prefix}_bed_target_temperature`,
        state: "70",
        attributes: { min: 0, max: 120 },
      },
      { entity_id: `fan.${prefix}_cooling_fan`, state: "on", attributes: { percentage: 60 } },
      { entity_id: `fan.${prefix}_aux_fan`, state: "on", attributes: { percentage: 40 } },
      { entity_id: `fan.${prefix}_chamber_fan`, state: "off", attributes: { percentage: 0 } },
      { entity_id: `select.${prefix}_printing_speed`, state: "standard" },
      { entity_id: `light.${prefix}_chamber_light`, state: "on" },
      { entity_id: `button.${prefix}_pause`, state: "unknown" },
      { entity_id: `button.${prefix}_resume`, state: "unknown" },
      { entity_id: `button.${prefix}_stop`, state: "unknown" },
      {
        entity_id: `sensor.${prefix}_printable_objects`,
        state: "2",
        attributes: { objects: { "1": "part-1.stl", "2": "part-2.stl" } },
      },
      { entity_id: `camera.${prefix}_camera`, state: "streaming" },
    ];
  };

  const client = HttpClient.make((request) => {
    const url = new URL(request.url);
    const authHeader = request.headers["authorization"] ?? null;
    options.onRequest?.(url, authHeader);
    if (url.pathname === "/api/states") {
      return Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          new Response(JSON.stringify(makeStates()), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
        ),
      );
    }
    if (url.pathname === "/api/template") {
      const resolved =
        options.templateDeviceId === undefined ? P1S_CONFIG.deviceId : options.templateDeviceId;
      return Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          new Response(resolved ?? "", {
            status: 200,
            headers: { "content-type": "text/plain" },
          }),
        ),
      );
    }
    if (url.pathname.startsWith("/api/services/")) {
      const bodyText =
        request.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : "{}";
      options.onServiceCall?.(url.pathname, JSON.parse(bodyText), authHeader);
      return Effect.succeed(
        HttpClientResponse.fromWeb(request, new Response("[]", { status: 200 })),
      );
    }
    if (url.pathname.startsWith("/api/camera_proxy/")) {
      const jpeg = new Uint8Array([
        0xff, 0xd8, 0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x0c, 0x00, 0x10, 0x01, 0x01, 0x11, 0x00,
        0xff, 0xd9,
      ]);
      return Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          new Response(jpeg, { status: 200, headers: { "content-type": "image/jpeg" } }),
        ),
      );
    }
    return Effect.succeed(
      HttpClientResponse.fromWeb(request, new Response("Not Found", { status: 404 })),
    );
  });

  return Layer.succeed(HttpClient.HttpClient, client);
}

const mockSecretResolverLayer = Layer.succeed(SecretResolverCore.SecretResolver, {
  read: (refs) => Effect.succeed(refs.map(() => undefined)),
  invalidate: () => Effect.void,
  label: (provider) => Effect.succeed(provider),
});

describe("PrinterUrlGuard", () => {
  it.effect("rejects metadata hosts, IPv4-mapped IPv6 metadata, non-http, and userinfo URLs", () =>
    Effect.gen(function* () {
      const blockedUrls = [
        "http://169.254.169.254/latest/meta-data",
        "http://[::ffff:169.254.169.254]/latest/meta-data",
        "http://[::ffff:a9fe:a9fe]/latest/meta-data",
        "http://[fe80::1]:8123",
        "http://0.0.0.0:8123",
        "http://metadata.google.internal/",
        "http://user:pass@192.168.1.50:8123",
        "file:///etc/passwd",
      ];

      for (const candidate of blockedUrls) {
        const exit = yield* Effect.exit(validatePrinterBaseUrl(candidate, "test"));
        expect(Exit.isFailure(exit), `expected ${candidate} to be rejected`).toBe(true);
      }

      const valid = yield* validatePrinterBaseUrl("http://192.168.1.50:8123", "test");
      expect(valid.origin).toBe("http://192.168.1.50:8123");
    }),
  );

  it.effect("enforces streaming maxBytes cap without buffering oversized responses", () =>
    Effect.gen(function* () {
      const oversizedStream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(64));
          controller.enqueue(new Uint8Array(64));
          controller.enqueue(new Uint8Array(64));
          controller.close();
        },
      });
      const client = HttpClient.make((request) =>
        Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            new Response(oversizedStream, {
              status: 200,
              headers: { "content-type": "image/jpeg" },
            }),
          ),
        ),
      );

      const exit = yield* Effect.exit(
        fetchPrinterBinary(new URL("http://192.168.1.50:8123/api/camera_proxy/camera.test"), {
          maxBytes: 100,
          operation: "oversized image test",
        }).pipe(Effect.provideService(HttpClient.HttpClient, client)),
      );
      expect(Exit.isFailure(exit)).toBe(true);
    }),
  );

  it.effect("fails closed when a printer hostname cannot be resolved via DNS", () =>
    Effect.gen(function* () {
      const client = HttpClient.make((request) =>
        Effect.succeed(HttpClientResponse.fromWeb(request, new Response("ok", { status: 200 }))),
      );
      const exit = yield* Effect.exit(
        fetchPrinterBinary(new URL("http://nonexistent-printer.invalid:8123/api/states"), {
          operation: "dns fail closed test",
        }).pipe(Effect.provideService(HttpClient.HttpClient, client)),
      );
      expect(Exit.isFailure(exit)).toBe(true);
    }),
  );
});

describe("PrinterService safety guards & lifecycle", () => {
  it.effect("refuses axis jog while a print is active and rejects stale expectedJobFileName", () =>
    Effect.gen(function* () {
      const serviceCalls: Array<{ path: string; body: unknown }> = [];
      const testLayer = PrinterService.layer.pipe(
        Layer.provide(
          ServerSettings.layerTest({
            enablePrinterSupport: true,
            printers: [P1S_CONFIG],
          }),
        ),
        Layer.provide(mockSecretResolverLayer),
        Layer.provide(
          makeMockHaHttpClient({
            status: "running",
            fileName: "current-job.gcode.3mf",
            onServiceCall: (path, body) => serviceCalls.push({ path, body }),
          }),
        ),
      );

      yield* Effect.scoped(
        Effect.gen(function* () {
          const service = yield* PrinterService.PrinterService;
          const listed = yield* service.list({ refresh: true });
          expect(listed.printers).toHaveLength(1);
          expect(listed.printers[0]?.job.status).toBe("running");

          const jogExit = yield* Effect.exit(
            service.action({
              printerId: P1S_CONFIG.id,
              action: { kind: "moveAxis", axis: "X", distanceMm: 1 },
            }),
          );
          expect(Exit.isFailure(jogExit)).toBe(true);

          const staleStopExit = yield* Effect.exit(
            service.action({
              printerId: P1S_CONFIG.id,
              action: { kind: "stop", expectedJobFileName: "older-job.gcode.3mf" },
            }),
          );
          expect(Exit.isFailure(staleStopExit)).toBe(true);
          expect(serviceCalls).toHaveLength(0);

          // Chamber light toggle is allowed while printing.
          yield* service.action({
            printerId: P1S_CONFIG.id,
            action: { kind: "setChamberLight", on: false },
          });
          expect(serviceCalls).toEqual([
            {
              path: "/api/services/light/turn_off",
              body: { entity_id: "light.p1s_test_chamber_light" },
            },
          ]);
        }).pipe(Effect.provide(testLayer)),
      );
    }),
  );

  it.effect(
    "fails closed for motion when job status is unknown and refuses expectedJobFileName when filename is missing",
    () =>
      Effect.gen(function* () {
        const serviceCalls: Array<{ path: string; body: unknown }> = [];
        const testLayer = PrinterService.layer.pipe(
          Layer.provide(
            ServerSettings.layerTest({
              enablePrinterSupport: true,
              printers: [P1S_CONFIG],
            }),
          ),
          Layer.provide(mockSecretResolverLayer),
          Layer.provide(
            makeMockHaHttpClient({
              status: "unknown",
              fileName: null,
              onServiceCall: (path, body) => serviceCalls.push({ path, body }),
            }),
          ),
        );

        yield* Effect.scoped(
          Effect.gen(function* () {
            const service = yield* PrinterService.PrinterService;
            const listed = yield* service.list({ refresh: true });
            expect(listed.printers[0]?.capabilities.canJog).toBe(false);

            const jogExit = yield* Effect.exit(
              service.action({
                printerId: P1S_CONFIG.id,
                action: { kind: "moveAxis", axis: "X", distanceMm: 1 },
              }),
            );
            expect(Exit.isFailure(jogExit)).toBe(true);

            const homeExit = yield* Effect.exit(
              service.action({
                printerId: P1S_CONFIG.id,
                action: { kind: "homeAxes" },
              }),
            );
            expect(Exit.isFailure(homeExit)).toBe(true);

            const missingFileExit = yield* Effect.exit(
              service.action({
                printerId: P1S_CONFIG.id,
                action: { kind: "stop", expectedJobFileName: "part-a.gcode.3mf" },
              }),
            );
            expect(Exit.isFailure(missingFileExit)).toBe(true);
            expect(serviceCalls).toHaveLength(0);
          }).pipe(Effect.provide(testLayer)),
        );
      }),
  );

  it.effect(
    "binds saved credentials to their original destination on testConnection and settings persistence, and does not resurrect cleared tokens",
    () =>
      Effect.gen(function* () {
        const seenRequests: Array<{ host: string; authHeader: string | null }> = [];
        const testLayer = PrinterService.layer.pipe(
          Layer.provide(
            ServerSettings.layerTest({
              enablePrinterSupport: true,
              printers: [P1S_CONFIG],
            }),
          ),
          Layer.provide(mockSecretResolverLayer),
          Layer.provide(
            makeMockHaHttpClient({
              status: "idle",
              onRequest: (url, authHeader) => seenRequests.push({ host: url.host, authHeader }),
            }),
          ),
        );

        yield* Effect.scoped(
          Effect.gen(function* () {
            const service = yield* PrinterService.PrinterService;

            // Different origin with SECRET_REDACTED must NOT reuse the saved accessToken.
            const changedOriginExit = yield* Effect.exit(
              service.testConnection({
                config: {
                  ...P1S_CONFIG,
                  baseUrl: "http://192.168.1.99:8123",
                  accessToken: SECRET_REDACTED,
                },
                existingPrinterId: P1S_CONFIG.id,
              }),
            );
            expect(Exit.isFailure(changedOriginExit)).toBe(true);

            // Different adapter kind with SECRET_REDACTED must NOT reuse the saved accessToken.
            const changedKind: MoonrakerPrinterConfig = {
              kind: "moonraker",
              id: P1S_CONFIG.id,
              label: "Switched to Moonraker",
              baseUrl: P1S_CONFIG.baseUrl,
              apiKey: SECRET_REDACTED,
              pollIntervalSeconds: 4,
            };
            const changedKindExit = yield* Effect.exit(
              service.testConnection({
                config: changedKind,
                existingPrinterId: P1S_CONFIG.id,
              }),
            );
            expect(Exit.isFailure(changedKindExit)).toBe(true);

            // Explicitly cleared token ("") must NOT silently resurrect the saved credential.
            seenRequests.length = 0;
            yield* service.testConnection({
              config: {
                ...P1S_CONFIG,
                accessToken: "",
              },
              existingPrinterId: P1S_CONFIG.id,
            });
            expect(seenRequests.every((req) => req.authHeader === null)).toBe(true);

            // Same origin + same kind + SECRET_REDACTED succeeds using the saved credential.
            seenRequests.length = 0;
            const sameOrigin = yield* service.testConnection({
              config: {
                ...P1S_CONFIG,
                accessToken: SECRET_REDACTED,
              },
              existingPrinterId: P1S_CONFIG.id,
            });
            expect(sameOrigin.ok).toBe(true);
            expect(seenRequests.some((req) => req.authHeader === "Bearer ha-secret-token")).toBe(
              true,
            );

            // Saving a printer moved to a new origin with SECRET_REDACTED must clear the kept token
            // in shared persistence so subsequent polls never send the saved token to the new host.
            seenRequests.length = 0;
            yield* service.configure({
              printers: [
                {
                  ...P1S_CONFIG,
                  baseUrl: "http://192.168.1.99:8123",
                  accessToken: SECRET_REDACTED,
                },
              ],
            });
            const newHostRequests = seenRequests.filter((req) => req.host === "192.168.1.99:8123");
            expect(newHostRequests.length).toBeGreaterThan(0);
            expect(newHostRequests.every((req) => req.authHeader === null)).toBe(true);
          }).pipe(Effect.provide(testLayer)),
        );
      }),
  );

  it.effect(
    "refuses reusing a saved secret-provider reference in testConnection when origin or backend changes",
    () =>
      Effect.gen(function* () {
        const savedRef = {
          provider: SecretProviderId.make("personal"),
          reference: "op://Agents/HA/token",
        };
        const refResolverLayer = Layer.succeed(SecretResolverCore.SecretResolver, {
          read: (refs) => Effect.succeed(refs.map(() => "resolved-op-secret")),
          invalidate: () => Effect.void,
          label: (provider) => Effect.succeed(provider),
        });
        const seenAuthHeaders: Array<string | null> = [];
        const testLayer = PrinterService.layer.pipe(
          Layer.provide(
            ServerSettings.layerTest({
              enablePrinterSupport: true,
              printers: [{ ...P1S_CONFIG, accessToken: savedRef }],
            }),
          ),
          Layer.provide(refResolverLayer),
          Layer.provide(
            makeMockHaHttpClient({
              status: "idle",
              onRequest: (_url, authHeader) => seenAuthHeaders.push(authHeader),
            }),
          ),
        );

        yield* Effect.scoped(
          Effect.gen(function* () {
            const service = yield* PrinterService.PrinterService;

            // Redirected host with reused saved SecretReference must FAIL before resolving/sending.
            const changedOriginExit = yield* Effect.exit(
              service.testConnection({
                config: {
                  ...P1S_CONFIG,
                  baseUrl: "http://192.168.1.99:8123",
                  accessToken: savedRef,
                },
                existingPrinterId: P1S_CONFIG.id,
              }),
            );
            expect(Exit.isFailure(changedOriginExit)).toBe(true);

            // Redirected host with reused saved SecretReference must FAIL even when existingPrinterId is omitted.
            const changedOriginOmittedIdExit = yield* Effect.exit(
              service.testConnection({
                config: {
                  ...P1S_CONFIG,
                  baseUrl: "http://192.168.1.99:8123",
                  accessToken: savedRef,
                },
              }),
            );
            expect(Exit.isFailure(changedOriginOmittedIdExit)).toBe(true);

            // Switched backend with reused saved SecretReference must FAIL.
            const changedKindExit = yield* Effect.exit(
              service.testConnection({
                config: {
                  kind: "moonraker",
                  id: P1S_CONFIG.id,
                  label: "Moonraker",
                  baseUrl: P1S_CONFIG.baseUrl,
                  apiKey: savedRef,
                  pollIntervalSeconds: 4,
                },
                existingPrinterId: P1S_CONFIG.id,
              }),
            );
            expect(Exit.isFailure(changedKindExit)).toBe(true);
            expect(seenAuthHeaders.every((h) => h !== "Bearer resolved-op-secret")).toBe(true);

            // Same host + same backend succeeds.
            const sameTarget = yield* service.testConnection({
              config: { ...P1S_CONFIG, accessToken: savedRef },
              existingPrinterId: P1S_CONFIG.id,
            });
            expect(sameTarget.ok).toBe(true);
          }).pipe(Effect.provide(testLayer)),
        );
      }),
  );

  it.effect(
    "revalidates HA device_id live before motion even after an initial poll cached the old device_id",
    () =>
      Effect.gen(function* () {
        let currentHaDeviceId = P1S_CONFIG.deviceId!;
        const serviceCalls: Array<{ path: string; body: unknown }> = [];
        const dynamicClient = Layer.succeed(
          HttpClient.HttpClient,
          HttpClient.make((request) => {
            const url = new URL(request.url);
            if (url.pathname === "/api/states") {
              return Effect.succeed(
                HttpClientResponse.fromWeb(
                  request,
                  new Response(
                    JSON.stringify([
                      {
                        entity_id: "binary_sensor.p1s_test_online",
                        state: "on",
                        last_reported: FRESH_REPORTED_AT,
                      },
                      {
                        entity_id: "sensor.p1s_test_print_status",
                        state: "idle",
                        last_reported: FRESH_REPORTED_AT,
                      },
                      { entity_id: "sensor.p1s_test_nozzle_temperature", state: "25" },
                      { entity_id: "sensor.p1s_test_bed_temperature", state: "25" },
                    ]),
                    { status: 200, headers: { "content-type": "application/json" } },
                  ),
                ),
              );
            }
            if (url.pathname === "/api/template") {
              return Effect.succeed(
                HttpClientResponse.fromWeb(
                  request,
                  new Response(currentHaDeviceId, {
                    status: 200,
                    headers: { "content-type": "text/plain" },
                  }),
                ),
              );
            }
            if (url.pathname.startsWith("/api/services/")) {
              const bodyText =
                request.body._tag === "Uint8Array"
                  ? new TextDecoder().decode(request.body.body)
                  : "{}";
              serviceCalls.push({ path: url.pathname, body: JSON.parse(bodyText) });
              return Effect.succeed(
                HttpClientResponse.fromWeb(request, new Response("[]", { status: 200 })),
              );
            }
            return Effect.succeed(
              HttpClientResponse.fromWeb(request, new Response("Not Found", { status: 404 })),
            );
          }),
        );
        const testLayer = PrinterService.layer.pipe(
          Layer.provide(
            ServerSettings.layerTest({
              enablePrinterSupport: true,
              printers: [P1S_CONFIG],
            }),
          ),
          Layer.provide(mockSecretResolverLayer),
          Layer.provide(dynamicClient),
        );

        yield* Effect.scoped(
          Effect.gen(function* () {
            const service = yield* PrinterService.PrinterService;
            // Initial poll caches matching device_id.
            yield* service.list({ refresh: true });

            // Now HA reassigns sensor.p1s_test_print_status to a different physical device.
            currentHaDeviceId = "reassigned-different-device-id";

            // Motion must re-check HA live and REFUSE instead of trusting the cached device_id.
            const jogExit = yield* Effect.exit(
              service.action({
                printerId: P1S_CONFIG.id,
                action: { kind: "moveAxis", axis: "X", distanceMm: 1 },
              }),
            );
            expect(Exit.isFailure(jogExit)).toBe(true);
            expect(serviceCalls).toHaveLength(0);
          }).pipe(Effect.provide(testLayer)),
        );
      }),
  );

  it.effect(
    "refuses auto-detected HA device motion when device_id changes between safety poll and live pre-dispatch check",
    () =>
      Effect.gen(function* () {
        let templateLookups = 0;
        const serviceCalls: Array<{ path: string; body: unknown }> = [];
        const dynamicClient = Layer.succeed(
          HttpClient.HttpClient,
          HttpClient.make((request) => {
            const url = new URL(request.url);
            if (url.pathname === "/api/states") {
              return Effect.succeed(
                HttpClientResponse.fromWeb(
                  request,
                  new Response(
                    JSON.stringify([
                      {
                        entity_id: "binary_sensor.p1s_test_online",
                        state: "on",
                        last_reported: FRESH_REPORTED_AT,
                      },
                      {
                        entity_id: "sensor.p1s_test_print_status",
                        state: "idle",
                        last_reported: FRESH_REPORTED_AT,
                      },
                      { entity_id: "sensor.p1s_test_nozzle_temperature", state: "25" },
                      { entity_id: "sensor.p1s_test_bed_temperature", state: "25" },
                    ]),
                    { status: 200, headers: { "content-type": "application/json" } },
                  ),
                ),
              );
            }
            if (url.pathname === "/api/template") {
              templateLookups += 1;
              const deviceId =
                templateLookups === 1 ? "auto-detected-device-a" : "reassigned-device-b";
              return Effect.succeed(
                HttpClientResponse.fromWeb(
                  request,
                  new Response(deviceId, {
                    status: 200,
                    headers: { "content-type": "text/plain" },
                  }),
                ),
              );
            }
            if (url.pathname.startsWith("/api/services/")) {
              const bodyText =
                request.body._tag === "Uint8Array"
                  ? new TextDecoder().decode(request.body.body)
                  : "{}";
              serviceCalls.push({ path: url.pathname, body: JSON.parse(bodyText) });
              return Effect.succeed(
                HttpClientResponse.fromWeb(request, new Response("[]", { status: 200 })),
              );
            }
            return Effect.succeed(
              HttpClientResponse.fromWeb(request, new Response("Not Found", { status: 404 })),
            );
          }),
        );
        const { deviceId: _omitted, ...autoDetectConfig } = P1S_CONFIG;
        const testLayer = PrinterService.layer.pipe(
          Layer.provide(
            ServerSettings.layerTest({
              enablePrinterSupport: true,
              printers: [autoDetectConfig],
            }),
          ),
          Layer.provide(mockSecretResolverLayer),
          Layer.provide(dynamicClient),
        );

        yield* Effect.scoped(
          Effect.gen(function* () {
            const service = yield* PrinterService.PrinterService;
            // Safety poll auto-detects device A; live pre-dispatch lookup returns device B -> MUST REFUSE.
            const jogExit = yield* Effect.exit(
              service.action({
                printerId: autoDetectConfig.id,
                action: { kind: "moveAxis", axis: "X", distanceMm: 1 },
              }),
            );
            expect(Exit.isFailure(jogExit)).toBe(true);
            expect(serviceCalls).toHaveLength(0);
          }).pipe(Effect.provide(testLayer)),
        );
      }),
  );

  it.effect(
    "aborts hardware dispatch if printer config changes between preflight and move_axis dispatch",
    () =>
      Effect.gen(function* () {
        const serviceCalls: Array<{ path: string; body: unknown }> = [];
        const enteredPreDispatch = yield* Deferred.make<void>();
        const releasePreDispatch = yield* Deferred.make<void>();
        let armed = false;

        const mockDnsLayer = Layer.succeed(PrinterDnsLookup, () =>
          Effect.succeed([{ address: "192.168.1.50", family: 4 }]),
        );

        const raceConfig: HomeAssistantBambuPrinterConfig = {
          ...P1S_CONFIG,
          baseUrl: "http://printer-race-test.local:8123",
        };
        const raceClient = Layer.succeed(
          HttpClient.HttpClient,
          HttpClient.make((request) => {
            const url = new URL(request.url);
            if (url.pathname === "/api/states") {
              const now = FRESH_REPORTED_AT;
              return Effect.succeed(
                HttpClientResponse.fromWeb(
                  request,
                  new Response(
                    JSON.stringify([
                      {
                        entity_id: "binary_sensor.p1s_test_online",
                        state: "on",
                        last_reported: now,
                      },
                      {
                        entity_id: "sensor.p1s_test_print_status",
                        state: "idle",
                        last_reported: now,
                      },
                      { entity_id: "sensor.p1s_test_nozzle_temperature", state: "25" },
                      { entity_id: "sensor.p1s_test_bed_temperature", state: "25" },
                    ]),
                    { status: 200, headers: { "content-type": "application/json" } },
                  ),
                ),
              );
            }
            if (url.pathname === "/api/template") {
              return Effect.gen(function* () {
                if (armed) {
                  armed = false;
                  yield* Deferred.succeed(enteredPreDispatch, undefined);
                  yield* Deferred.await(releasePreDispatch);
                }
                return HttpClientResponse.fromWeb(
                  request,
                  new Response(raceConfig.deviceId!, {
                    status: 200,
                    headers: { "content-type": "text/plain" },
                  }),
                );
              });
            }
            if (url.pathname.startsWith("/api/services/")) {
              serviceCalls.push({ path: url.pathname, body: null });
              return Effect.succeed(
                HttpClientResponse.fromWeb(request, new Response("[]", { status: 200 })),
              );
            }
            return Effect.succeed(
              HttpClientResponse.fromWeb(request, new Response("Not Found", { status: 404 })),
            );
          }),
        );
        const testLayer = PrinterService.layer.pipe(
          Layer.provide(
            ServerSettings.layerTest({
              enablePrinterSupport: true,
              printers: [raceConfig],
            }),
          ),
          Layer.provide(mockSecretResolverLayer),
          Layer.provide(mockDnsLayer),
          Layer.provide(raceClient),
        );

        yield* Effect.scoped(
          Effect.gen(function* () {
            const service = yield* PrinterService.PrinterService;
            yield* service.list({ refresh: true });
            armed = true;

            const actionFiber = yield* Effect.forkChild(
              Effect.exit(
                service.action({
                  printerId: raceConfig.id,
                  action: { kind: "moveAxis", axis: "X", distanceMm: 1 },
                }),
              ),
            );

            yield* Deferred.await(enteredPreDispatch);

            // Retarget the printer right before move_axis dispatches!
            yield* service.configure({
              printers: [
                {
                  ...raceConfig,
                  baseUrl: "http://192.168.1.51:8123",
                },
              ],
            });

            yield* Deferred.succeed(releasePreDispatch, undefined);
            const actionExit = yield* Fiber.join(actionFiber);
            expect(Exit.isFailure(actionExit)).toBe(true);
            expect(serviceCalls).toHaveLength(0);
          }).pipe(Effect.provide(testLayer)),
        );
      }),
  );

  it.effect(
    "refuses HA device actions when configured deviceId disagrees with entity prefix and supports trailing-dot entityPrefix",
    () =>
      Effect.gen(function* () {
        const serviceCalls: Array<{ path: string; body: unknown }> = [];
        const mismatchedLayer = PrinterService.layer.pipe(
          Layer.provide(
            ServerSettings.layerTest({
              enablePrinterSupport: true,
              printers: [
                {
                  ...P1S_CONFIG,
                  entityPrefix: "p1s_test.",
                  deviceId: "wrong-printer-device-id",
                },
              ],
            }),
          ),
          Layer.provide(mockSecretResolverLayer),
          Layer.provide(
            makeMockHaHttpClient({
              status: "idle",
              entityPrefix: "p1s_test",
              templateDeviceId: "actual-printer-device-id",
              onServiceCall: (path, body) => serviceCalls.push({ path, body }),
            }),
          ),
        );

        yield* Effect.scoped(
          Effect.gen(function* () {
            const service = yield* PrinterService.PrinterService;
            // Polling & media still normalize trailing-dot entityPrefix cleanly.
            const listed = yield* service.list({ refresh: true });
            expect(listed.printers[0]?.online).toBe(true);
            const media = yield* service.fetchMedia(P1S_CONFIG.id, "camera");
            expect(media.contentType).toBe("image/jpeg");

            // Motion must be REFUSED because configured deviceId != HA device_id for entityPrefix.
            const mismatchJogExit = yield* Effect.exit(
              service.action({
                printerId: P1S_CONFIG.id,
                action: { kind: "moveAxis", axis: "X", distanceMm: 1 },
              }),
            );
            expect(Exit.isFailure(mismatchJogExit)).toBe(true);
            expect(serviceCalls).toHaveLength(0);

            // Non-device entity actions still work with trailing-dot entityPrefix normalized.
            yield* service.action({
              printerId: P1S_CONFIG.id,
              action: { kind: "setChamberLight", on: false },
            });
            expect(serviceCalls).toEqual([
              {
                path: "/api/services/light/turn_off",
                body: { entity_id: "light.p1s_test_chamber_light" },
              },
            ]);
          }).pipe(Effect.provide(mismatchedLayer)),
        );
      }),
  );

  it.effect(
    "clears cached snapshot and runtime state when an existing printer ID is retargeted",
    () =>
      Effect.gen(function* () {
        const retargetClient = Layer.succeed(
          HttpClient.HttpClient,
          HttpClient.make((request) => {
            const url = new URL(request.url);
            if (url.hostname === "192.168.1.51") {
              return Effect.succeed(
                HttpClientResponse.fromWeb(
                  request,
                  new Response("Service Unavailable", { status: 503 }),
                ),
              );
            }
            const states = [
              {
                entity_id: "binary_sensor.p1s_test_online",
                state: "on",
                last_reported: FRESH_REPORTED_AT,
              },
              {
                entity_id: "sensor.p1s_test_print_status",
                state: "running",
                last_reported: FRESH_REPORTED_AT,
              },
              { entity_id: "sensor.p1s_test_gcode_filename", state: "old-printer-job.gcode.3mf" },
              { entity_id: "sensor.p1s_test_nozzle_temperature", state: "215" },
              { entity_id: "sensor.p1s_test_bed_temperature", state: "70" },
            ];
            return Effect.succeed(
              HttpClientResponse.fromWeb(
                request,
                new Response(JSON.stringify(states), {
                  status: 200,
                  headers: { "content-type": "application/json" },
                }),
              ),
            );
          }),
        );
        const testLayer = PrinterService.layer.pipe(
          Layer.provide(
            ServerSettings.layerTest({
              enablePrinterSupport: true,
              printers: [P1S_CONFIG],
            }),
          ),
          Layer.provide(mockSecretResolverLayer),
          Layer.provide(retargetClient),
        );

        yield* Effect.scoped(
          Effect.gen(function* () {
            const service = yield* PrinterService.PrinterService;
            const initial = yield* service.list({ refresh: true });
            expect(initial.printers[0]?.job.fileName).toBe("old-printer-job.gcode.3mf");
            expect(initial.printers[0]?.thermals.history.length).toBeGreaterThan(0);

            // Retarget the same printer ID to a different baseUrl that is currently unreachable.
            yield* service.configure({
              printers: [
                {
                  ...P1S_CONFIG,
                  baseUrl: "http://192.168.1.51:8123",
                },
              ],
            });

            // Stale snapshot and thermal history from the previous host must NOT persist.
            const afterRetarget = yield* service.list({ refresh: false });
            expect(afterRetarget.printers[0]?.job.fileName).toBeNull();
            expect(afterRetarget.printers[0]?.job.status).toBe("offline");
            expect(afterRetarget.printers[0]?.thermals.history).toEqual([]);
          }).pipe(Effect.provide(testLayer)),
        );
      }),
  );

  it.effect(
    "dispatches HA Bambu service payloads accurately for controls and tracks sessions",
    () =>
      Effect.gen(function* () {
        const serviceCalls: Array<{ path: string; body: unknown }> = [];
        let currentStatus: "idle" | "running" = "idle";
        const dynamicClient = Layer.succeed(
          HttpClient.HttpClient,
          HttpClient.make((request) => {
            const url = new URL(request.url);
            if (url.pathname === "/api/states") {
              return Effect.succeed(
                HttpClientResponse.fromWeb(
                  request,
                  new Response(
                    JSON.stringify([
                      {
                        entity_id: "binary_sensor.p1s_test_online",
                        state: "on",
                        last_reported: FRESH_REPORTED_AT,
                      },
                      {
                        entity_id: "sensor.p1s_test_print_status",
                        state: currentStatus,
                        last_reported: FRESH_REPORTED_AT,
                      },
                      { entity_id: "sensor.p1s_test_gcode_filename", state: "plate-1.gcode.3mf" },
                      { entity_id: "sensor.p1s_test_nozzle_temperature", state: "215" },
                      { entity_id: "number.p1s_test_nozzle_target_temperature", state: "215" },
                      { entity_id: "sensor.p1s_test_bed_temperature", state: "70" },
                      { entity_id: "number.p1s_test_bed_target_temperature", state: "70" },
                      { entity_id: "fan.p1s_test_cooling_fan", state: "on" },
                      { entity_id: "select.p1s_test_printing_speed", state: "standard" },
                      { entity_id: "button.p1s_test_pause", state: "unknown" },
                      { entity_id: "button.p1s_test_resume", state: "unknown" },
                      { entity_id: "button.p1s_test_stop", state: "unknown" },
                      {
                        entity_id: "sensor.p1s_test_printable_objects",
                        state: "2",
                        attributes: { objects: { "1": "part-1.stl", "2": "part-2.stl" } },
                      },
                      { entity_id: "camera.p1s_test_camera", state: "streaming" },
                    ]),
                    { status: 200, headers: { "content-type": "application/json" } },
                  ),
                ),
              );
            }
            if (url.pathname === "/api/template") {
              return Effect.succeed(
                HttpClientResponse.fromWeb(
                  request,
                  new Response(P1S_CONFIG.deviceId!, {
                    status: 200,
                    headers: { "content-type": "text/plain" },
                  }),
                ),
              );
            }
            if (url.pathname.startsWith("/api/services/")) {
              const bodyText =
                request.body._tag === "Uint8Array"
                  ? new TextDecoder().decode(request.body.body)
                  : "{}";
              serviceCalls.push({ path: url.pathname, body: JSON.parse(bodyText) });
              return Effect.succeed(
                HttpClientResponse.fromWeb(request, new Response("[]", { status: 200 })),
              );
            }
            if (url.pathname.startsWith("/api/camera_proxy/")) {
              return Effect.succeed(
                HttpClientResponse.fromWeb(
                  request,
                  new Response(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]), {
                    status: 200,
                    headers: { "content-type": "image/jpeg" },
                  }),
                ),
              );
            }
            return Effect.succeed(
              HttpClientResponse.fromWeb(request, new Response("Not Found", { status: 404 })),
            );
          }),
        );
        const testLayer = PrinterService.layer.pipe(
          Layer.provide(
            ServerSettings.layerTest({
              enablePrinterSupport: true,
              printers: [P1S_CONFIG],
            }),
          ),
          Layer.provide(mockSecretResolverLayer),
          Layer.provide(dynamicClient),
        );

        yield* Effect.scoped(
          Effect.gen(function* () {
            const service = yield* PrinterService.PrinterService;
            const threadId = ThreadId.make("thread-1");
            yield* service.open({ threadId, printerId: P1S_CONFIG.id });
            expect(yield* service.sessionsForThread(threadId)).toHaveLength(1);

            yield* service.action({
              printerId: P1S_CONFIG.id,
              action: { kind: "setNozzleTemp", targetC: 220 },
            });
            yield* service.action({
              printerId: P1S_CONFIG.id,
              action: { kind: "setBedTemp", targetC: 65 },
            });
            yield* service.action({
              printerId: P1S_CONFIG.id,
              action: { kind: "setFanSpeed", fan: "cooling", percent: 80 },
            });
            yield* service.action({
              printerId: P1S_CONFIG.id,
              action: { kind: "setSpeedProfile", profile: "sport" },
            });
            yield* service.action({
              printerId: P1S_CONFIG.id,
              action: { kind: "moveAxis", axis: "Z", distanceMm: -1 },
            });
            yield* service.action({
              printerId: P1S_CONFIG.id,
              action: { kind: "homeAxes" },
            });
            yield* service.action({
              printerId: P1S_CONFIG.id,
              action: { kind: "pause", expectedJobFileName: "plate-1.gcode.3mf" },
            });
            yield* service.action({
              printerId: P1S_CONFIG.id,
              action: { kind: "resume", expectedJobFileName: "plate-1.gcode.3mf" },
            });
            yield* service.action({
              printerId: P1S_CONFIG.id,
              action: { kind: "stop", expectedJobFileName: "plate-1.gcode.3mf" },
            });

            // Skip objects requires an active print AND matching job filename & object membership.
            const idleSkipExit = yield* Effect.exit(
              service.action({
                printerId: P1S_CONFIG.id,
                action: {
                  kind: "skipObjects",
                  objectIds: [1],
                  expectedJobFileName: "plate-1.gcode.3mf",
                },
              }),
            );
            expect(Exit.isFailure(idleSkipExit)).toBe(true);

            currentStatus = "running";
            const wrongJobSkipExit = yield* Effect.exit(
              service.action({
                printerId: P1S_CONFIG.id,
                action: {
                  kind: "skipObjects",
                  objectIds: [1],
                  expectedJobFileName: "different-job.gcode.3mf",
                },
              }),
            );
            expect(Exit.isFailure(wrongJobSkipExit)).toBe(true);

            const unknownObjSkipExit = yield* Effect.exit(
              service.action({
                printerId: P1S_CONFIG.id,
                action: {
                  kind: "skipObjects",
                  objectIds: [999],
                  expectedJobFileName: "plate-1.gcode.3mf",
                },
              }),
            );
            expect(Exit.isFailure(unknownObjSkipExit)).toBe(true);

            yield* service.action({
              printerId: P1S_CONFIG.id,
              action: {
                kind: "skipObjects",
                objectIds: [1],
                expectedJobFileName: "plate-1.gcode.3mf",
              },
            });

            expect(serviceCalls).toEqual([
              {
                path: "/api/services/number/set_value",
                body: { entity_id: "number.p1s_test_nozzle_target_temperature", value: 220 },
              },
              {
                path: "/api/services/number/set_value",
                body: { entity_id: "number.p1s_test_bed_target_temperature", value: 65 },
              },
              {
                path: "/api/services/fan/set_percentage",
                body: { entity_id: "fan.p1s_test_cooling_fan", percentage: 80 },
              },
              {
                path: "/api/services/select/select_option",
                body: { entity_id: "select.p1s_test_printing_speed", option: "sport" },
              },
              {
                path: "/api/services/bambu_lab/move_axis",
                body: { device_id: P1S_CONFIG.deviceId, axis: "Z", distance: -1 },
              },
              {
                path: "/api/services/bambu_lab/move_axis",
                body: { device_id: P1S_CONFIG.deviceId, axis: "Home", distance: 0 },
              },
              {
                path: "/api/services/button/press",
                body: { entity_id: "button.p1s_test_pause" },
              },
              {
                path: "/api/services/button/press",
                body: { entity_id: "button.p1s_test_resume" },
              },
              {
                path: "/api/services/button/press",
                body: { entity_id: "button.p1s_test_stop" },
              },
              {
                path: "/api/services/bambu_lab/skip_objects",
                body: { device_id: P1S_CONFIG.deviceId, objects: "1" },
              },
            ]);

            const media = yield* service.fetchMedia(P1S_CONFIG.id, "camera");
            expect(media.contentType).toBe("image/jpeg");
            expect(media.stale).toBe(false);

            yield* service.close({ threadId, printerId: P1S_CONFIG.id });
            expect(yield* service.sessionsForThread(threadId)).toHaveLength(0);
          }).pipe(Effect.provide(testLayer)),
        );
      }),
  );

  it.effect(
    "blocks Alibaba Cloud metadata 100.100.100.200 while preserving Tailscale CGNAT and supports hostname DNS pinning on Node fetch",
    () =>
      Effect.gen(function* () {
        expect(
          Exit.isFailure(
            yield* Effect.exit(validatePrinterBaseUrl("http://100.100.100.200/latest", "test")),
          ),
        ).toBe(true);
        expect(
          Exit.isFailure(
            yield* Effect.exit(
              validatePrinterBaseUrl("http://[::ffff:100.100.100.200]/latest", "test"),
            ),
          ),
        ).toBe(true);
        expect(
          Exit.isSuccess(
            yield* Effect.exit(validatePrinterBaseUrl("http://100.64.1.25:8123", "test")),
          ),
        ).toBe(true);

        // Real FetchHttpClient + local HTTP server + hostname DNS pinning proves undici Agent + undici fetch compatibility.
        const server = NodeHttp.createServer((_req, res) => {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
        });
        const port = yield* Effect.acquireRelease(
          Effect.promise(
            () =>
              new Promise<number>((resolve) => {
                server.listen(0, "127.0.0.1", () => {
                  const address = server.address();
                  resolve(typeof address === "object" && address !== null ? address.port : 0);
                });
              }),
          ),
          () => Effect.promise(() => new Promise<void>((resolve) => server.close(() => resolve()))),
        );

        const body = yield* fetchPrinterJson<{ readonly ok: boolean }>(
          new URL(`http://printer.lan.test:${port}/api/version`),
          { operation: "dns.pin.test" },
        ).pipe(
          Effect.provide(FetchHttpClient.layer),
          Effect.provideService(PrinterDnsLookup, () =>
            Effect.succeed([{ address: "127.0.0.1", family: 4 }]),
          ),
        );
        expect(body).toEqual({ ok: true });
      }),
  );

  it.effect(
    "rechecks motion readiness at dispatch guard if a concurrent poll observes printing before move_axis dispatches",
    () =>
      Effect.gen(function* () {
        let currentStatus: "idle" | "running" = "idle";
        let armed = false;
        const enteredPreDispatch = yield* Deferred.make<void>();
        const releasePreDispatch = yield* Deferred.make<void>();
        const serviceCalls: Array<{ path: string; body: unknown }> = [];
        const hostConfig: HomeAssistantBambuPrinterConfig = {
          ...P1S_CONFIG,
          baseUrl: "http://printer-status-race.lan.test:8123",
        };
        const dynamicClient = Layer.succeed(
          HttpClient.HttpClient,
          HttpClient.make((request) => {
            const url = new URL(request.url);
            if (url.pathname === "/api/states") {
              const now = FRESH_REPORTED_AT;
              return Effect.succeed(
                HttpClientResponse.fromWeb(
                  request,
                  new Response(
                    JSON.stringify([
                      {
                        entity_id: "binary_sensor.p1s_test_online",
                        state: "on",
                        last_reported: now,
                      },
                      {
                        entity_id: "sensor.p1s_test_print_status",
                        state: currentStatus,
                        last_reported: now,
                      },
                      { entity_id: "sensor.p1s_test_nozzle_temperature", state: "25" },
                      { entity_id: "sensor.p1s_test_bed_temperature", state: "25" },
                    ]),
                    { status: 200, headers: { "content-type": "application/json" } },
                  ),
                ),
              );
            }
            if (url.pathname === "/api/template") {
              return Effect.gen(function* () {
                if (armed) {
                  armed = false;
                  yield* Deferred.succeed(enteredPreDispatch, undefined);
                  yield* Deferred.await(releasePreDispatch);
                }
                return HttpClientResponse.fromWeb(
                  request,
                  new Response(hostConfig.deviceId!, {
                    status: 200,
                    headers: { "content-type": "text/plain" },
                  }),
                );
              });
            }
            if (url.pathname.startsWith("/api/services/")) {
              serviceCalls.push({ path: url.pathname, body: null });
              return Effect.succeed(
                HttpClientResponse.fromWeb(request, new Response("[]", { status: 200 })),
              );
            }
            return Effect.succeed(
              HttpClientResponse.fromWeb(request, new Response("Not Found", { status: 404 })),
            );
          }),
        );
        const testLayer = PrinterService.layer.pipe(
          Layer.provide(
            ServerSettings.layerTest({
              enablePrinterSupport: true,
              printers: [hostConfig],
            }),
          ),
          Layer.provide(mockSecretResolverLayer),
          Layer.provide(dynamicClient),
          Layer.provide(
            Layer.succeed(PrinterDnsLookup, () =>
              Effect.succeed([{ address: "192.168.1.50", family: 4 }]),
            ),
          ),
        );

        yield* Effect.scoped(
          Effect.gen(function* () {
            const service = yield* PrinterService.PrinterService;
            yield* service.list({ refresh: true });
            armed = true;

            const moveFiber = yield* Effect.forkChild(
              Effect.exit(
                service.action({
                  printerId: hostConfig.id,
                  action: { kind: "moveAxis", axis: "X", distanceMm: 1 },
                }),
              ),
            );
            yield* Deferred.await(enteredPreDispatch);

            // Printer starts printing on the SAME target before the motion POST leaves the socket!
            currentStatus = "running";
            yield* service.list({ refresh: true });

            yield* Deferred.succeed(releasePreDispatch, undefined);
            const moveExit = yield* Fiber.join(moveFiber);
            expect(Exit.isFailure(moveExit)).toBe(true);
            expect(serviceCalls).toHaveLength(0);
          }).pipe(Effect.provide(testLayer)),
        );
      }),
  );

  it.effect(
    "pins one DNS lookup across preflight poll and write action, rejects query/hash backend URLs, and blocks open() when disabled",
    () =>
      Effect.gen(function* () {
        expect(
          Exit.isFailure(
            yield* Effect.exit(validatePrinterBaseUrl("http://192.168.1.50:8123/?token=1", "test")),
          ),
        ).toBe(true);
        expect(
          Exit.isFailure(
            yield* Effect.exit(validatePrinterBaseUrl("http://192.168.1.50:8123/#frag", "test")),
          ),
        ).toBe(true);

        // Disabled printer support refuses open() and makes zero outbound requests.
        let disabledRequests = 0;
        const disabledLayer = PrinterService.layer.pipe(
          Layer.provide(
            ServerSettings.layerTest({
              enablePrinterSupport: false,
              printers: [P1S_CONFIG],
            }),
          ),
          Layer.provide(mockSecretResolverLayer),
          Layer.provide(
            makeMockHaHttpClient({
              status: "idle",
              onRequest: () => {
                disabledRequests += 1;
              },
            }),
          ),
        );
        yield* Effect.scoped(
          Effect.gen(function* () {
            const service = yield* PrinterService.PrinterService;
            const openExit = yield* Effect.exit(
              service.open({
                threadId: ThreadId.make("thread-disabled"),
                printerId: P1S_CONFIG.id,
              }),
            );
            expect(Exit.isFailure(openExit)).toBe(true);
            expect(disabledRequests).toBe(0);
          }).pipe(Effect.provide(disabledLayer)),
        );

        // Action pins ONE DNS lookup across preflight poll + device_id check + write dispatch.
        let dnsLookupsDuringAction = 0;
        let countingDns = false;
        const serviceCalls: Array<{ path: string; body: unknown }> = [];
        const hostConfig: HomeAssistantBambuPrinterConfig = {
          ...P1S_CONFIG,
          baseUrl: "http://pin-once.lan.test:8123",
        };
        const pinnedLayer = PrinterService.layer.pipe(
          Layer.provide(
            ServerSettings.layerTest({
              enablePrinterSupport: true,
              printers: [hostConfig],
            }),
          ),
          Layer.provide(mockSecretResolverLayer),
          Layer.provide(
            Layer.succeed(PrinterDnsLookup, () =>
              Effect.sync(() => {
                if (countingDns) dnsLookupsDuringAction += 1;
                return [{ address: "192.168.1.50", family: 4 }];
              }),
            ),
          ),
          Layer.provide(
            makeMockHaHttpClient({
              status: "idle",
              onServiceCall: (path, body) => serviceCalls.push({ path, body }),
            }),
          ),
        );
        yield* Effect.scoped(
          Effect.gen(function* () {
            const service = yield* PrinterService.PrinterService;
            yield* service.list({ refresh: true });
            countingDns = true;
            yield* service.action({
              printerId: hostConfig.id,
              action: { kind: "moveAxis", axis: "X", distanceMm: 1 },
            });
            expect(dnsLookupsDuringAction).toBe(1);
            expect(serviceCalls).toHaveLength(1);
          }).pipe(Effect.provide(pinnedLayer)),
        );
      }),
  );

  it.effect(
    "serializes concurrent actions per printer, fails closed on skipObjects without printable objects, and keeps media freshness across slow polls",
    () =>
      Effect.gen(function* () {
        // 1. skipObjects fails closed when printableObjects is empty.
        const emptyObjectsClient = Layer.succeed(
          HttpClient.HttpClient,
          HttpClient.make((request) => {
            const url = new URL(request.url);
            if (url.pathname === "/api/states") {
              const now = FRESH_REPORTED_AT;
              return Effect.succeed(
                HttpClientResponse.fromWeb(
                  request,
                  new Response(
                    JSON.stringify([
                      {
                        entity_id: "binary_sensor.p1s_test_online",
                        state: "on",
                        last_reported: now,
                      },
                      {
                        entity_id: "sensor.p1s_test_print_status",
                        state: "running",
                        last_reported: now,
                      },
                      { entity_id: "sensor.p1s_test_gcode_filename", state: "plate.gcode.3mf" },
                    ]),
                    { status: 200, headers: { "content-type": "application/json" } },
                  ),
                ),
              );
            }
            if (url.pathname === "/api/template") {
              return Effect.succeed(
                HttpClientResponse.fromWeb(
                  request,
                  new Response(P1S_CONFIG.deviceId!, { status: 200 }),
                ),
              );
            }
            return Effect.succeed(
              HttpClientResponse.fromWeb(request, new Response("[]", { status: 200 })),
            );
          }),
        );
        yield* Effect.scoped(
          Effect.gen(function* () {
            const service = yield* PrinterService.PrinterService;
            const exit = yield* Effect.exit(
              service.action({
                printerId: P1S_CONFIG.id,
                action: {
                  kind: "skipObjects",
                  objectIds: [1],
                  expectedJobFileName: "plate.gcode.3mf",
                },
              }),
            );
            expect(Exit.isFailure(exit)).toBe(true);
          }).pipe(
            Effect.provide(
              PrinterService.layer.pipe(
                Layer.provide(
                  ServerSettings.layerTest({
                    enablePrinterSupport: true,
                    printers: [P1S_CONFIG],
                  }),
                ),
                Layer.provide(mockSecretResolverLayer),
                Layer.provide(emptyObjectsClient),
              ),
            ),
          ),
        );

        // 2. Concurrent actions on the same printer serialize strictly via per-printer semaphore,
        // and a slow poll finishing after fetchMedia never regresses newer camera freshness.
        const firstWriteEntered = yield* Deferred.make<void>();
        const releaseFirstWrite = yield* Deferred.make<void>();
        const slowPollEntered = yield* Deferred.make<void>();
        const releaseSlowPoll = yield* Deferred.make<void>();
        let holdNextWrite = false;
        let holdNextPoll = false;
        let inFlightActions = 0;
        let maxConcurrentActions = 0;
        let jpegByte = 0x10;

        const overlapClient = Layer.succeed(
          HttpClient.HttpClient,
          HttpClient.make((request) => {
            const url = new URL(request.url);
            if (url.pathname === "/api/states") {
              return Effect.gen(function* () {
                if (holdNextPoll) {
                  holdNextPoll = false;
                  yield* Deferred.succeed(slowPollEntered, undefined);
                  yield* Deferred.await(releaseSlowPoll);
                }
                const now = FRESH_REPORTED_AT;
                return HttpClientResponse.fromWeb(
                  request,
                  new Response(
                    JSON.stringify([
                      {
                        entity_id: "binary_sensor.p1s_test_online",
                        state: "on",
                        last_reported: now,
                      },
                      {
                        entity_id: "sensor.p1s_test_print_status",
                        state: "idle",
                        last_reported: now,
                      },
                      { entity_id: "light.p1s_test_chamber_light", state: "on" },
                      { entity_id: "camera.p1s_test_camera", state: "streaming" },
                    ]),
                    { status: 200, headers: { "content-type": "application/json" } },
                  ),
                );
              });
            }
            if (url.pathname.startsWith("/api/services/")) {
              return Effect.gen(function* () {
                inFlightActions += 1;
                maxConcurrentActions = Math.max(maxConcurrentActions, inFlightActions);
                if (holdNextWrite) {
                  holdNextWrite = false;
                  yield* Deferred.succeed(firstWriteEntered, undefined);
                  yield* Deferred.await(releaseFirstWrite);
                }
                inFlightActions -= 1;
                return HttpClientResponse.fromWeb(request, new Response("[]", { status: 200 }));
              });
            }
            if (url.pathname.startsWith("/api/camera_proxy/")) {
              jpegByte += 1;
              const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, jpegByte, 0xff, 0xd9]);
              return Effect.succeed(
                HttpClientResponse.fromWeb(
                  request,
                  new Response(jpeg, { status: 200, headers: { "content-type": "image/jpeg" } }),
                ),
              );
            }
            return Effect.succeed(
              HttpClientResponse.fromWeb(
                request,
                new Response(P1S_CONFIG.deviceId!, { status: 200 }),
              ),
            );
          }),
        );

        yield* Effect.scoped(
          Effect.gen(function* () {
            const service = yield* PrinterService.PrinterService;
            yield* service.list({ refresh: true });

            // Launch two concurrent actions on the same printer: semaphore guarantees maxConcurrentActions === 1.
            holdNextWrite = true;
            const action1 = yield* Effect.forkChild(
              service.action({
                printerId: P1S_CONFIG.id,
                action: { kind: "setChamberLight", on: false },
              }),
            );
            yield* Deferred.await(firstWriteEntered);
            const action2 = yield* Effect.forkChild(
              service.action({
                printerId: P1S_CONFIG.id,
                action: { kind: "setChamberLight", on: true },
              }),
            );
            yield* Deferred.succeed(releaseFirstWrite, undefined);
            yield* Fiber.join(action1);
            yield* Fiber.join(action2);
            expect(maxConcurrentActions).toBe(1);

            // Start a slow poll, fetch a fresh camera frame while it is in flight, then complete the slow poll.
            holdNextPoll = true;
            const slowPoll = yield* Effect.forkChild(service.list({ refresh: true }));
            yield* Deferred.await(slowPollEntered);
            const media1 = yield* service.fetchMedia(P1S_CONFIG.id, "camera");
            expect(media1.stale).toBe(false);
            yield* Deferred.succeed(releaseSlowPoll, undefined);
            const afterSlowPoll = yield* Fiber.join(slowPoll);
            expect(afterSlowPoll.printers[0]?.media.cameraStale).toBe(false);
          }).pipe(
            Effect.provide(
              PrinterService.layer.pipe(
                Layer.provide(
                  ServerSettings.layerTest({
                    enablePrinterSupport: true,
                    printers: [P1S_CONFIG],
                  }),
                ),
                Layer.provide(mockSecretResolverLayer),
                Layer.provide(overlapClient),
              ),
            ),
          ),
        );
      }),
  );

  it.effect(
    "rejects queued commands if printer ID is retargeted while waiting on the per-printer action lock",
    () =>
      Effect.gen(function* () {
        const firstStopEntered = yield* Deferred.make<void>();
        const releaseFirstStop = yield* Deferred.make<void>();
        const stopHosts: Array<string> = [];
        let holdFirstStop = true;

        const retargetRaceClient = Layer.succeed(
          HttpClient.HttpClient,
          HttpClient.make((request) => {
            const url = new URL(request.url);
            if (url.pathname === "/api/states") {
              return Effect.succeed(
                HttpClientResponse.fromWeb(
                  request,
                  new Response(
                    JSON.stringify([
                      {
                        entity_id: "binary_sensor.p1s_test_online",
                        state: "on",
                        last_reported: FRESH_REPORTED_AT,
                      },
                      {
                        entity_id: "sensor.p1s_test_print_status",
                        state: "running",
                        last_reported: FRESH_REPORTED_AT,
                      },
                      {
                        entity_id: "sensor.p1s_test_gcode_filename",
                        state: "shared-job.gcode.3mf",
                      },
                      { entity_id: "button.p1s_test_stop", state: "unknown" },
                    ]),
                    { status: 200, headers: { "content-type": "application/json" } },
                  ),
                ),
              );
            }
            if (url.pathname.startsWith("/api/services/")) {
              return Effect.gen(function* () {
                stopHosts.push(url.host);
                if (holdFirstStop) {
                  holdFirstStop = false;
                  yield* Deferred.succeed(firstStopEntered, undefined);
                  yield* Deferred.await(releaseFirstStop);
                }
                return HttpClientResponse.fromWeb(request, new Response("[]", { status: 200 }));
              });
            }
            return Effect.succeed(
              HttpClientResponse.fromWeb(
                request,
                new Response(P1S_CONFIG.deviceId!, { status: 200 }),
              ),
            );
          }),
        );

        yield* Effect.scoped(
          Effect.gen(function* () {
            const service = yield* PrinterService.PrinterService;
            yield* service.list({ refresh: true });

            // Hold stop #1 open on host .50.
            const stop1 = yield* Effect.forkChild(
              service.action({
                printerId: P1S_CONFIG.id,
                action: { kind: "stop", expectedJobFileName: "shared-job.gcode.3mf" },
              }),
            );
            yield* Deferred.await(firstStopEntered);

            // Queue stop #2 on the same printerId while stop #1 holds the lock.
            const stop2 = yield* Effect.forkChild(
              Effect.exit(
                service.action({
                  printerId: P1S_CONFIG.id,
                  action: { kind: "stop", expectedJobFileName: "shared-job.gcode.3mf" },
                }),
              ),
            );
            yield* Effect.yieldNow;

            // Retarget printerId to replacement printer .51 (also printing shared-job.gcode.3mf!).
            yield* service.configure({
              printers: [{ ...P1S_CONFIG, baseUrl: "http://192.168.1.51:8123" }],
            });

            yield* Deferred.succeed(releaseFirstStop, undefined);
            yield* Fiber.join(stop1);
            const stop2Exit = yield* Fiber.join(stop2);
            expect(Exit.isFailure(stop2Exit)).toBe(true);
            expect(stopHosts).toEqual(["192.168.1.50:8123"]);
          }).pipe(
            Effect.provide(
              PrinterService.layer.pipe(
                Layer.provide(
                  ServerSettings.layerTest({
                    enablePrinterSupport: true,
                    printers: [P1S_CONFIG],
                  }),
                ),
                Layer.provide(mockSecretResolverLayer),
                Layer.provide(retargetRaceClient),
              ),
            ),
          ),
        );
      }),
  );

  it.effect(
    "rejects bare trailing ? and #, falls back across dual-stack DNS during preflight poll, and pins the answering IP for write",
    () =>
      Effect.gen(function* () {
        expect(
          Exit.isFailure(
            yield* Effect.exit(validatePrinterBaseUrl("http://192.168.1.50:8123/?", "test")),
          ),
        ).toBe(true);
        expect(
          Exit.isFailure(
            yield* Effect.exit(validatePrinterBaseUrl("http://192.168.1.50:8123/#", "test")),
          ),
        ).toBe(true);

        // Start a real IPv4-only server on 127.0.0.1; DNS returns [dead ::1, working 127.0.0.1].
        const receivedMethods: Array<string> = [];
        const server = NodeHttp.createServer((req, res) => {
          receivedMethods.push(`${req.method ?? "GET"} ${req.url ?? "/"}`);
          if (req.url === "/api/states") {
            res.writeHead(200, { "content-type": "application/json" });
            res.end(
              JSON.stringify([
                {
                  entity_id: "binary_sensor.p1s_test_online",
                  state: "on",
                  last_reported: FRESH_REPORTED_AT,
                },
                {
                  entity_id: "sensor.p1s_test_print_status",
                  state: "idle",
                  last_reported: FRESH_REPORTED_AT,
                },
                { entity_id: "light.p1s_test_chamber_light", state: "on" },
              ]),
            );
            return;
          }
          if (req.url === "/api/template") {
            res.writeHead(200, { "content-type": "text/plain" });
            res.end(P1S_CONFIG.deviceId!);
            return;
          }
          res.writeHead(200, { "content-type": "application/json" });
          res.end("[]");
        });
        const port = yield* Effect.acquireRelease(
          Effect.promise(
            () =>
              new Promise<number>((resolve) => {
                server.listen(0, "127.0.0.1", () => {
                  const address = server.address();
                  resolve(typeof address === "object" && address !== null ? address.port : 0);
                });
              }),
          ),
          () => Effect.promise(() => new Promise<void>((resolve) => server.close(() => resolve()))),
        );

        let dnsCallsDuringAction = 0;
        let counting = false;
        const dualStackConfig: HomeAssistantBambuPrinterConfig = {
          ...P1S_CONFIG,
          baseUrl: `http://dualstack.lan.test:${port}`,
        };

        yield* Effect.scoped(
          Effect.gen(function* () {
            const service = yield* PrinterService.PrinterService;
            // Settle startup background poll before measuring DNS lookups during action().
            yield* service.list({ refresh: true });
            counting = true;
            yield* service.action({
              printerId: dualStackConfig.id,
              action: { kind: "setChamberLight", on: false },
            });
            expect(dnsCallsDuringAction).toBe(1);
            expect(receivedMethods).toContain("POST /api/services/light/turn_off");
          }).pipe(
            Effect.provide(
              PrinterService.layer.pipe(
                Layer.provide(
                  ServerSettings.layerTest({
                    enablePrinterSupport: true,
                    printers: [dualStackConfig],
                  }),
                ),
                Layer.provide(mockSecretResolverLayer),
                Layer.provide(FetchHttpClient.layer),
                Layer.provide(
                  Layer.succeed(PrinterDnsLookup, () =>
                    Effect.sync(() => {
                      if (counting) dnsCallsDuringAction += 1;
                      return [
                        { address: "::1", family: 6 },
                        { address: "127.0.0.1", family: 4 },
                      ];
                    }),
                  ),
                ),
              ),
            ),
          ),
        );
      }),
  );

  it.effect(
    "ignores out-of-order older camera responses and sequences camera independently of cover fetches",
    () =>
      Effect.gen(function* () {
        const cam1Entered = yield* Deferred.make<void>();
        const releaseCam1 = yield* Deferred.make<void>();
        let cameraCalls = 0;
        const camClient = Layer.succeed(
          HttpClient.HttpClient,
          HttpClient.make((request) => {
            const url = new URL(request.url);
            if (url.pathname === "/api/states") {
              return Effect.succeed(
                HttpClientResponse.fromWeb(
                  request,
                  new Response(
                    JSON.stringify([
                      {
                        entity_id: "binary_sensor.p1s_test_online",
                        state: "on",
                        last_reported: FRESH_REPORTED_AT,
                      },
                      {
                        entity_id: "sensor.p1s_test_print_status",
                        state: "running",
                        last_reported: FRESH_REPORTED_AT,
                      },
                      { entity_id: "camera.p1s_test_camera", state: "streaming" },
                      { entity_id: "image.p1s_test_cover_image", state: FRESH_REPORTED_AT },
                    ]),
                    { status: 200, headers: { "content-type": "application/json" } },
                  ),
                ),
              );
            }
            if (url.pathname.startsWith("/api/camera_proxy/")) {
              return Effect.gen(function* () {
                const callNum = ++cameraCalls;
                if (callNum === 1) {
                  yield* Deferred.succeed(cam1Entered, undefined);
                  yield* Deferred.await(releaseCam1);
                }
                const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, callNum, 0xff, 0xd9]);
                return HttpClientResponse.fromWeb(
                  request,
                  new Response(jpeg, { status: 200, headers: { "content-type": "image/jpeg" } }),
                );
              });
            }
            if (url.pathname.startsWith("/api/image_proxy/")) {
              const png = new Uint8Array([
                0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00,
              ]);
              return Effect.succeed(
                HttpClientResponse.fromWeb(
                  request,
                  new Response(png, { status: 200, headers: { "content-type": "image/png" } }),
                ),
              );
            }
            return Effect.succeed(
              HttpClientResponse.fromWeb(
                request,
                new Response(P1S_CONFIG.deviceId!, { status: 200 }),
              ),
            );
          }),
        );

        yield* Effect.scoped(
          Effect.gen(function* () {
            const service = yield* PrinterService.PrinterService;
            yield* service.list({ refresh: true });

            // Start slow camera request #1 at t=0.
            const cam1Fiber = yield* Effect.forkChild(service.fetchMedia(P1S_CONFIG.id, "camera"));
            yield* Deferred.await(cam1Entered);

            // Concurrent cover fetch must NOT block camera #1 or #2 sequencing.
            yield* service.fetchMedia(P1S_CONFIG.id, "cover");

            // Advance clock 5s and complete newer camera request #2 first.
            yield* TestClock.adjust(Duration.seconds(5));
            yield* service.fetchMedia(P1S_CONFIG.id, "camera");
            const afterCam2 = (yield* service.state).printers[0]?.media.cameraUpdatedAt;
            expect(afterCam2).toBe("1970-01-01T00:00:05.000Z");

            // Now release slow older camera request #1 -> must NOT regress cameraUpdatedAt back to t=0!
            yield* Deferred.succeed(releaseCam1, undefined);
            yield* Fiber.join(cam1Fiber);
            const afterCam1 = (yield* service.state).printers[0]?.media.cameraUpdatedAt;
            expect(afterCam1).toBe("1970-01-01T00:00:05.000Z");
          }).pipe(
            Effect.provide(
              PrinterService.layer.pipe(
                Layer.provide(
                  ServerSettings.layerTest({
                    enablePrinterSupport: true,
                    printers: [P1S_CONFIG],
                  }),
                ),
                Layer.provide(mockSecretResolverLayer),
                Layer.provide(camClient),
              ),
            ),
          ),
        );
      }),
  );

  it.effect(
    "does not let a slow cover fetch overwrite camera hash, and times out a stalled first DNS candidate to fall back to the second",
    () =>
      Effect.gen(function* () {
        // 1. Slow cover fetch started during Frame A finishes AFTER Frame B -> subsequent identical Frame B
        // must still be recognized as unchanged (must NOT bump cameraUpdatedAt).
        const coverEntered = yield* Deferred.make<void>();
        const releaseCover = yield* Deferred.make<void>();
        let currentFrameByte = 0x0a;

        const coverRaceClient = Layer.succeed(
          HttpClient.HttpClient,
          HttpClient.make((request) => {
            const url = new URL(request.url);
            if (url.pathname === "/api/states") {
              return Effect.succeed(
                HttpClientResponse.fromWeb(
                  request,
                  new Response(
                    JSON.stringify([
                      {
                        entity_id: "binary_sensor.p1s_test_online",
                        state: "on",
                        last_reported: FRESH_REPORTED_AT,
                      },
                      {
                        entity_id: "sensor.p1s_test_print_status",
                        state: "running",
                        last_reported: FRESH_REPORTED_AT,
                      },
                      { entity_id: "camera.p1s_test_camera", state: "streaming" },
                      { entity_id: "image.p1s_test_cover_image", state: FRESH_REPORTED_AT },
                    ]),
                    { status: 200, headers: { "content-type": "application/json" } },
                  ),
                ),
              );
            }
            if (url.pathname.startsWith("/api/camera_proxy/")) {
              const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, currentFrameByte, 0xff, 0xd9]);
              return Effect.succeed(
                HttpClientResponse.fromWeb(
                  request,
                  new Response(jpeg, { status: 200, headers: { "content-type": "image/jpeg" } }),
                ),
              );
            }
            if (url.pathname.startsWith("/api/image_proxy/")) {
              return Effect.gen(function* () {
                yield* Deferred.succeed(coverEntered, undefined);
                yield* Deferred.await(releaseCover);
                const png = new Uint8Array([
                  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00,
                ]);
                return HttpClientResponse.fromWeb(
                  request,
                  new Response(png, { status: 200, headers: { "content-type": "image/png" } }),
                );
              });
            }
            return Effect.succeed(
              HttpClientResponse.fromWeb(
                request,
                new Response(P1S_CONFIG.deviceId!, { status: 200 }),
              ),
            );
          }),
        );

        yield* Effect.scoped(
          Effect.gen(function* () {
            const service = yield* PrinterService.PrinterService;
            yield* service.list({ refresh: true });

            // Fetch Frame A at t=0.
            yield* service.fetchMedia(P1S_CONFIG.id, "camera");
            // Start slow cover fetch while cache holds Frame A's hash.
            const coverFiber = yield* Effect.forkChild(service.fetchMedia(P1S_CONFIG.id, "cover"));
            yield* Deferred.await(coverEntered);

            // Advance clock to t=5s and fetch new Frame B.
            yield* TestClock.adjust(Duration.seconds(5));
            currentFrameByte = 0x0b;
            yield* service.fetchMedia(P1S_CONFIG.id, "camera");
            expect((yield* service.state).printers[0]?.media.cameraUpdatedAt).toBe(
              "1970-01-01T00:00:05.000Z",
            );

            // Release slow cover fetch -> must NOT restore Frame A's hash.
            yield* Deferred.succeed(releaseCover, undefined);
            yield* Fiber.join(coverFiber);

            // Advance clock to t=40s with identical Frame B -> must be detected as frozen (stale=true, timestamp stays t=5s).
            yield* TestClock.adjust(Duration.seconds(35));
            const frozen = yield* service.fetchMedia(P1S_CONFIG.id, "camera");
            expect(frozen.stale).toBe(true);
            expect((yield* service.state).printers[0]?.media.cameraUpdatedAt).toBe(
              "1970-01-01T00:00:05.000Z",
            );
          }).pipe(
            Effect.provide(
              PrinterService.layer.pipe(
                Layer.provide(
                  ServerSettings.layerTest({
                    enablePrinterSupport: true,
                    printers: [P1S_CONFIG],
                  }),
                ),
                Layer.provide(mockSecretResolverLayer),
                Layer.provide(coverRaceClient),
              ),
            ),
          ),
        );

        // 2. Stalled first DNS candidate times out inside the per-candidate budget and falls back to the second candidate.
        let attempts = 0;
        const firstAttemptStarted = yield* Deferred.make<void>();
        const stalledFirstClient = HttpClient.make((request) =>
          Effect.gen(function* () {
            attempts += 1;
            if (attempts === 1) {
              yield* Deferred.succeed(firstAttemptStarted, undefined);
              return yield* Effect.never;
            }
            return HttpClientResponse.fromWeb(
              request,
              new Response(JSON.stringify({ ok: true }), {
                status: 200,
                headers: { "content-type": "application/json" },
              }),
            );
          }),
        );
        const pinMap = new Map([
          [
            "stalled-ipv6.lan.test",
            {
              candidates: [
                { address: "2001:db8::1", family: 6 },
                { address: "192.168.1.50", family: 4 },
              ],
              pinned: null as { readonly address: string; readonly family: number } | null,
            },
          ],
        ]);
        const fetchFiber = yield* Effect.forkChild(
          fetchPrinterJson<{ readonly ok: boolean }>(
            new URL("http://stalled-ipv6.lan.test:8123/api/states"),
            { operation: "stalled.candidate.test" },
          ).pipe(
            Effect.provideService(HttpClient.HttpClient, stalledFirstClient),
            Effect.provideService(PrinterPinnedAddresses, pinMap),
          ),
        );
        yield* Deferred.await(firstAttemptStarted);
        // Advance TestClock past per-candidate timeout (2.5s) but well under overall 8s deadline.
        yield* TestClock.adjust(Duration.seconds(3));
        const res = yield* Fiber.join(fetchFiber);
        expect(res).toEqual({ ok: true });
        expect(attempts).toBe(2);
        expect(pinMap.get("stalled-ipv6.lan.test")?.pinned).toEqual({
          address: "192.168.1.50",
          family: 4,
        });
      }),
  );

  it.effect(
    "rejects stale Stop confirmation when same filename reprints with a new startedAt or missing startedAt",
    () =>
      Effect.gen(function* () {
        const cancelCalls: Array<string> = [];
        let printDuration = 600;
        let printState: "printing" | "standby" = "printing";
        const moonrakerConfig: MoonrakerPrinterConfig = {
          kind: "moonraker",
          id: PrinterId.make("voron-stop-guard"),
          label: "Voron Guard",
          baseUrl: "http://192.168.1.52:7125",
          apiKey: "moonraker-secret",
          pollIntervalSeconds: 4,
        };
        const moonClient = Layer.succeed(
          HttpClient.HttpClient,
          HttpClient.make((request) => {
            const url = new URL(request.url);
            if (url.pathname === "/server/info") {
              return Effect.succeed(
                HttpClientResponse.fromWeb(
                  request,
                  new Response(JSON.stringify({ result: { klippy_state: "ready" } }), {
                    status: 200,
                    headers: { "content-type": "application/json" },
                  }),
                ),
              );
            }
            if (url.pathname === "/printer/objects/query") {
              return Effect.succeed(
                HttpClientResponse.fromWeb(
                  request,
                  new Response(
                    JSON.stringify({
                      result: {
                        status: {
                          webhooks: { state: "ready" },
                          print_stats: {
                            state: printState,
                            filename: "same-plate.gcode",
                            print_duration: printDuration,
                          },
                        },
                      },
                    }),
                    { status: 200, headers: { "content-type": "application/json" } },
                  ),
                ),
              );
            }
            if (
              url.pathname === "/printer/print/cancel" ||
              url.pathname === "/printer/print/pause" ||
              url.pathname === "/printer/gcode/script"
            ) {
              cancelCalls.push(url.pathname);
              return Effect.succeed(
                HttpClientResponse.fromWeb(request, new Response("ok", { status: 200 })),
              );
            }
            return Effect.succeed(
              HttpClientResponse.fromWeb(request, new Response("Not Found", { status: 404 })),
            );
          }),
        );

        yield* Effect.scoped(
          Effect.gen(function* () {
            const service = yield* PrinterService.PrinterService;
            yield* TestClock.adjust(Duration.seconds(1000));
            const initial = yield* service.list({ refresh: true });
            const originalStartedAt = initial.printers[0]?.job.startedAt;
            expect(originalStartedAt).not.toBeNull();

            // Same filename reprints immediately before browser updates (elapsed drops to 2s -> new startedAt).
            yield* TestClock.adjust(Duration.seconds(10));
            printDuration = 2;
            const staleStopExit = yield* Effect.exit(
              service.action({
                printerId: moonrakerConfig.id,
                action: {
                  kind: "stop",
                  expectedJobFileName: "same-plate.gcode",
                  expectedJobStartedAt: originalStartedAt,
                },
              }),
            );
            expect(Exit.isFailure(staleStopExit)).toBe(true);
            const stalePauseExit = yield* Effect.exit(
              service.action({
                printerId: moonrakerConfig.id,
                action: {
                  kind: "pause",
                  expectedJobFileName: "same-plate.gcode",
                  expectedJobStartedAt: originalStartedAt,
                },
              }),
            );
            expect(Exit.isFailure(stalePauseExit)).toBe(true);
            const staleSkipExit = yield* Effect.exit(
              service.action({
                printerId: moonrakerConfig.id,
                action: {
                  kind: "skipObjects",
                  objectIds: [1],
                  expectedJobFileName: "same-plate.gcode",
                  expectedJobStartedAt: originalStartedAt,
                },
              }),
            );
            expect(Exit.isFailure(staleSkipExit)).toBe(true);
            expect(cancelCalls).toHaveLength(0);

            // Missing observed startedAt (e.g. standby/idle) also fails closed when expectedJobStartedAt is supplied.
            printState = "standby";
            const missingStartedExit = yield* Effect.exit(
              service.action({
                printerId: moonrakerConfig.id,
                action: {
                  kind: "stop",
                  expectedJobFileName: "same-plate.gcode",
                  expectedJobStartedAt: originalStartedAt,
                },
              }),
            );
            expect(Exit.isFailure(missingStartedExit)).toBe(true);
            expect(cancelCalls).toHaveLength(0);
          }).pipe(
            Effect.provide(
              PrinterService.layer.pipe(
                Layer.provide(
                  ServerSettings.layerTest({
                    enablePrinterSupport: true,
                    printers: [moonrakerConfig],
                  }),
                ),
                Layer.provide(mockSecretResolverLayer),
                Layer.provide(moonClient),
              ),
            ),
          ),
        );
      }),
  );
});
