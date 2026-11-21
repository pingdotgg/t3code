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
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import { HttpClient, HttpClientResponse } from "effect/http";
import { describe, expect } from "vite-plus/test";

import * as ServerSettings from "../serverSettings.ts";
import { SECRET_REDACTED } from "../settingsSecrets.ts";
import * as PrinterService from "./PrinterService.ts";
import { fetchPrinterBinary, PrinterDnsLookup, validatePrinterBaseUrl } from "./PrinterUrlGuard.ts";

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
  const states = [
    { entity_id: `binary_sensor.${prefix}_online`, state: options.online === false ? "off" : "on" },
    {
      entity_id: `binary_sensor.${prefix}_hybrid_mqtt_control_blocked`,
      state: options.controlBlocked ? "on" : "off",
    },
    { entity_id: `sensor.${prefix}_print_status`, state: options.status },
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

  const client = HttpClient.make((request) => {
    const url = new URL(request.url);
    const authHeader = request.headers["authorization"] ?? null;
    options.onRequest?.(url, authHeader);
    if (url.pathname === "/api/states") {
      return Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          new Response(JSON.stringify(states), {
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
                      { entity_id: "binary_sensor.p1s_test_online", state: "on" },
                      { entity_id: "sensor.p1s_test_print_status", state: "idle" },
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
                      { entity_id: "binary_sensor.p1s_test_online", state: "on" },
                      { entity_id: "sensor.p1s_test_print_status", state: "idle" },
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
    "aborts hardware dispatch if printer config changes while awaiting DNS lookup before client.execute",
    () =>
      Effect.gen(function* () {
        const serviceCalls: Array<{ path: string; body: unknown }> = [];
        const enteredDispatchDns = yield* Deferred.make<void>();
        const releaseDispatchDns = yield* Deferred.make<void>();
        let armed = false;
        let actionLookupCount = 0;

        const mockDnsLayer = Layer.succeed(PrinterDnsLookup, () =>
          Effect.gen(function* () {
            if (armed) {
              actionLookupCount += 1;
              // 1: safety poll /api/states, 2: live pre-dispatch /api/template, 3: move_axis service call DNS.
              if (actionLookupCount === 3) {
                yield* Deferred.succeed(enteredDispatchDns, undefined);
                yield* Deferred.await(releaseDispatchDns);
              }
            }
            return [{ address: "192.168.1.50", family: 4 }];
          }),
        );

        const raceConfig: HomeAssistantBambuPrinterConfig = {
          ...P1S_CONFIG,
          baseUrl: "http://printer-race-test.local:8123",
        };
        const testLayer = PrinterService.layer.pipe(
          Layer.provide(
            ServerSettings.layerTest({
              enablePrinterSupport: true,
              printers: [raceConfig],
            }),
          ),
          Layer.provide(mockSecretResolverLayer),
          Layer.provide(mockDnsLayer),
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
            // Warm up initial poll so cache has verified device_id (only /api/states + live /api/template + move_axis run during action).
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

            yield* Deferred.await(enteredDispatchDns);

            // Retarget the printer while move_axis is waiting on DNS resolution!
            yield* service.configure({
              printers: [
                {
                  ...raceConfig,
                  baseUrl: "http://192.168.1.51:8123",
                },
              ],
            });

            yield* Deferred.succeed(releaseDispatchDns, undefined);
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
              { entity_id: "binary_sensor.p1s_test_online", state: "on" },
              { entity_id: "sensor.p1s_test_print_status", state: "running" },
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
              fileName: "plate-1.gcode.3mf",
              onServiceCall: (path, body) => serviceCalls.push({ path, body }),
            }),
          ),
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
            yield* service.action({
              printerId: P1S_CONFIG.id,
              action: {
                kind: "skipObjects",
                objectIds: [1],
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
});
