import {
  type MoonrakerPrinterConfig,
  type OctoPrintPrinterConfig,
  PrinterId,
} from "@t3tools/contracts";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import { HttpClient, HttpClientResponse } from "effect/http";
import { describe, expect } from "vite-plus/test";

import { moonrakerAdapter } from "./adapters/MoonrakerAdapter.ts";
import { octoPrintAdapter } from "./adapters/OctoPrintAdapter.ts";

const MOONRAKER_CONFIG: MoonrakerPrinterConfig = {
  kind: "moonraker",
  id: PrinterId.make("voron-24"),
  label: "Voron 2.4",
  baseUrl: "http://192.168.1.50:7125",
  apiKey: "moonraker-secret",
  webcamUrl: "http://192.168.1.55:8080/webcam/?action=snapshot",
  pollIntervalSeconds: 4,
};

const OCTOPRINT_CONFIG: OctoPrintPrinterConfig = {
  kind: "octoprint",
  id: PrinterId.make("prusa-mk4"),
  label: "Prusa MK4",
  baseUrl: "http://192.168.1.51:5000",
  apiKey: "octo-secret",
  webcamUrl: "http://192.168.1.56:8080/webcam/?action=snapshot",
  pollIntervalSeconds: 4,
};

const SAMPLE_JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);

describe("MoonrakerAdapter", () => {
  it.effect(
    "polls telemetry, blocks jogging on unknown state, and omits API key on cross-origin webcam",
    () =>
      Effect.gen(function* () {
        const seenHeaders: Array<{ url: string; apiKey: string | undefined }> = [];
        const mockClient = Layer.succeed(
          HttpClient.HttpClient,
          HttpClient.make((request) => {
            seenHeaders.push({ url: request.url, apiKey: request.headers["x-api-key"] });
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
                          extruder: { temperature: 205.2, target: 210 },
                          heater_bed: { temperature: 60.1, target: 60 },
                          print_stats: { state: "unexpected_state", filename: "" },
                        },
                      },
                    }),
                    { status: 200, headers: { "content-type": "application/json" } },
                  ),
                ),
              );
            }
            if (url.pathname === "/webcam/") {
              return Effect.succeed(
                HttpClientResponse.fromWeb(
                  request,
                  new Response(SAMPLE_JPEG, {
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

        const polled = yield* moonrakerAdapter
          .poll(MOONRAKER_CONFIG, "moonraker-secret", undefined, {})
          .pipe(Effect.provide(mockClient));
        expect(polled.snapshot.job.status).toBe("unknown");
        expect(polled.snapshot.capabilities.canJog).toBe(false);

        const media = yield* moonrakerAdapter
          .fetchMedia(MOONRAKER_CONFIG, "moonraker-secret", "camera", polled.snapshot, polled.cache)
          .pipe(Effect.provide(mockClient));
        expect(media.asset.contentType).toBe("image/jpeg");

        const webcamReq = seenHeaders.find((entry) => entry.url.includes("/webcam/"));
        expect(webcamReq?.apiKey).toBeUndefined();
        const apiReq = seenHeaders.find((entry) => entry.url.includes("/printer/objects/query"));
        expect(apiReq?.apiKey).toBe("moonraker-secret");

        // Same-origin webcam DOES receive X-Api-Key.
        const sameOriginConfig: MoonrakerPrinterConfig = {
          ...MOONRAKER_CONFIG,
          webcamUrl: `${MOONRAKER_CONFIG.baseUrl}/webcam/?action=snapshot`,
        };
        yield* moonrakerAdapter
          .fetchMedia(sameOriginConfig, "moonraker-secret", "camera", polled.snapshot, polled.cache)
          .pipe(Effect.provide(mockClient));
        const sameOriginWebcamReq = seenHeaders.find(
          (entry) =>
            entry.url.startsWith(MOONRAKER_CONFIG.baseUrl) && entry.url.includes("/webcam/"),
        );
        expect(sameOriginWebcamReq?.apiKey).toBe("moonraker-secret");
      }),
  );

  it.effect("fails closed for jogging when webhooks readiness is absent", () =>
    Effect.gen(function* () {
      const mockClient = Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request) =>
          Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              new Response(
                JSON.stringify({
                  result: {
                    status: {
                      print_stats: { state: "standby", filename: "" },
                    },
                  },
                }),
                { status: 200, headers: { "content-type": "application/json" } },
              ),
            ),
          ),
        ),
      );

      const polled = yield* moonrakerAdapter
        .poll(MOONRAKER_CONFIG, "moonraker-secret", undefined, {})
        .pipe(Effect.provide(mockClient));
      expect(polled.snapshot.job.status).toBe("unknown");
      expect(polled.snapshot.capabilities.canJog).toBe(false);
    }),
  );

  it.effect(
    "preserves Klipper coordinate mode with SAVE/RESTORE_GCODE_STATE and restores on jog failure",
    () =>
      Effect.gen(function* () {
        const scripts: Array<string> = [];
        let failFirst = false;
        const mockClient = Layer.succeed(
          HttpClient.HttpClient,
          HttpClient.make((request) => {
            const url = new URL(request.url);
            const script = url.searchParams.get("script") ?? "";
            scripts.push(script);
            if (failFirst && script.includes("G0 ")) {
              return Effect.succeed(
                HttpClientResponse.fromWeb(
                  request,
                  new Response("Move out of range", { status: 400 }),
                ),
              );
            }
            return Effect.succeed(
              HttpClientResponse.fromWeb(request, new Response("ok", { status: 200 })),
            );
          }),
        );

        yield* moonrakerAdapter
          .executeAction(
            MOONRAKER_CONFIG,
            "moonraker-secret",
            { kind: "moveAxis", axis: "X", distanceMm: 5 },
            {} as never,
            {},
          )
          .pipe(Effect.provide(mockClient));
        expect(scripts).toEqual([
          "SAVE_GCODE_STATE NAME=T3_JOG\nG91\nG0 X5 F3000\nRESTORE_GCODE_STATE NAME=T3_JOG",
        ]);

        scripts.length = 0;
        failFirst = true;
        const exit = yield* Effect.exit(
          moonrakerAdapter
            .executeAction(
              MOONRAKER_CONFIG,
              "moonraker-secret",
              { kind: "moveAxis", axis: "Z", distanceMm: -2 },
              {} as never,
              {},
            )
            .pipe(Effect.provide(mockClient)),
        );
        expect(Exit.isFailure(exit)).toBe(true);
        expect(scripts).toEqual([
          "SAVE_GCODE_STATE NAME=T3_JOG\nG91\nG0 Z-2 F3000\nRESTORE_GCODE_STATE NAME=T3_JOG",
          "RESTORE_GCODE_STATE NAME=T3_JOG",
        ]);
      }),
  );
});

describe("OctoPrintAdapter", () => {
  it.effect(
    "maps cancelling/resuming as active (blocks jog), preserves 401/403/500 errors, and isolates webcam API key by origin",
    () =>
      Effect.gen(function* () {
        let authMode: "cancelling" | "resuming" | "401" | "403" | "500" | "409" = "cancelling";
        const seenHeaders: Array<{ url: string; apiKey: string | undefined }> = [];
        const mockClient = Layer.succeed(
          HttpClient.HttpClient,
          HttpClient.make((request) => {
            seenHeaders.push({ url: request.url, apiKey: request.headers["x-api-key"] });
            const url = new URL(request.url);
            if (url.pathname === "/api/printer") {
              if (authMode === "401") {
                return Effect.succeed(
                  HttpClientResponse.fromWeb(
                    request,
                    new Response("Unauthorized", { status: 401 }),
                  ),
                );
              }
              if (authMode === "403") {
                return Effect.succeed(
                  HttpClientResponse.fromWeb(request, new Response("Forbidden", { status: 403 })),
                );
              }
              if (authMode === "500") {
                return Effect.succeed(
                  HttpClientResponse.fromWeb(
                    request,
                    new Response("Internal Error", { status: 500 }),
                  ),
                );
              }
              if (authMode === "409") {
                return Effect.succeed(
                  HttpClientResponse.fromWeb(
                    request,
                    new Response("Not operational", { status: 409 }),
                  ),
                );
              }
              return Effect.succeed(
                HttpClientResponse.fromWeb(
                  request,
                  new Response(
                    JSON.stringify({
                      state: {
                        text: authMode === "resuming" ? "Resuming" : "Cancelling",
                        flags:
                          authMode === "resuming"
                            ? { operational: true, resuming: true, printing: false }
                            : { operational: true, cancelling: true, printing: false },
                      },
                      temperature: {
                        tool0: { actual: 210, target: 0 },
                        bed: { actual: 60, target: 0 },
                      },
                    }),
                    { status: 200, headers: { "content-type": "application/json" } },
                  ),
                ),
              );
            }
            if (url.pathname === "/api/job") {
              return Effect.succeed(
                HttpClientResponse.fromWeb(
                  request,
                  new Response(
                    JSON.stringify({ job: { file: { name: "part.gcode" } }, progress: {} }),
                    {
                      status: 200,
                      headers: { "content-type": "application/json" },
                    },
                  ),
                ),
              );
            }
            if (url.pathname === "/webcam/") {
              return Effect.succeed(
                HttpClientResponse.fromWeb(
                  request,
                  new Response(SAMPLE_JPEG, {
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

        // 1. Cancelling & resuming must block jogging.
        const cancelling = yield* octoPrintAdapter
          .poll(OCTOPRINT_CONFIG, "octo-secret", undefined, {})
          .pipe(Effect.provide(mockClient));
        expect(cancelling.snapshot.job.status).toBe("running");
        expect(cancelling.snapshot.capabilities.canJog).toBe(false);

        authMode = "resuming";
        const resuming = yield* octoPrintAdapter
          .poll(OCTOPRINT_CONFIG, "octo-secret", undefined, {})
          .pipe(Effect.provide(mockClient));
        expect(resuming.snapshot.job.status).toBe("pause");
        expect(resuming.snapshot.capabilities.canJog).toBe(false);

        // 2. Cross-origin webcam omits X-Api-Key; same-origin webcam includes it.
        yield* octoPrintAdapter
          .fetchMedia(
            OCTOPRINT_CONFIG,
            "octo-secret",
            "camera",
            cancelling.snapshot,
            cancelling.cache,
          )
          .pipe(Effect.provide(mockClient));
        expect(seenHeaders.find((entry) => entry.url.includes("/webcam/"))?.apiKey).toBeUndefined();

        const sameOriginOcto: OctoPrintPrinterConfig = {
          ...OCTOPRINT_CONFIG,
          webcamUrl: `${OCTOPRINT_CONFIG.baseUrl}/webcam/?action=snapshot`,
        };
        yield* octoPrintAdapter
          .fetchMedia(
            sameOriginOcto,
            "octo-secret",
            "camera",
            cancelling.snapshot,
            cancelling.cache,
          )
          .pipe(Effect.provide(mockClient));
        expect(
          seenHeaders.find(
            (entry) =>
              entry.url.startsWith(OCTOPRINT_CONFIG.baseUrl) && entry.url.includes("/webcam/"),
          )?.apiKey,
        ).toBe("octo-secret");

        // 3. HTTP 401/403/500 on /api/printer must fail, not silently map to disconnected.
        for (const mode of ["401", "403", "500"] as const) {
          authMode = mode;
          const failureExit = yield* Effect.exit(
            octoPrintAdapter
              .poll(OCTOPRINT_CONFIG, "octo-secret", undefined, {})
              .pipe(Effect.provide(mockClient)),
          );
          expect(Exit.isFailure(failureExit), `expected HTTP ${mode} to fail`).toBe(true);
        }

        // 4. HTTP 409 on /api/printer gracefully maps to offline/disconnected.
        authMode = "409";
        const disconnected = yield* octoPrintAdapter
          .poll(OCTOPRINT_CONFIG, "octo-secret", undefined, {})
          .pipe(Effect.provide(mockClient));
        expect(disconnected.snapshot.online).toBe(false);
      }),
  );

  it.effect(
    "blocks jogging when OctoPrint is operational but not ready, and maps JSON null to PrinterOperationError",
    () =>
      Effect.gen(function* () {
        let mode: "unready" | "ready" | "null" = "unready";
        const mockClient = Layer.succeed(
          HttpClient.HttpClient,
          HttpClient.make((request) => {
            const url = new URL(request.url);
            if (url.pathname === "/api/printer") {
              if (mode === "null") {
                return Effect.succeed(
                  HttpClientResponse.fromWeb(
                    request,
                    new Response("null", {
                      status: 200,
                      headers: { "content-type": "application/json" },
                    }),
                  ),
                );
              }
              return Effect.succeed(
                HttpClientResponse.fromWeb(
                  request,
                  new Response(
                    JSON.stringify({
                      state: {
                        text: mode === "ready" ? "Operational" : "Transferring file to SD",
                        flags: { operational: true, ready: mode === "ready" },
                      },
                    }),
                    { status: 200, headers: { "content-type": "application/json" } },
                  ),
                ),
              );
            }
            return Effect.succeed(
              HttpClientResponse.fromWeb(
                request,
                new Response(JSON.stringify({ job: {}, progress: {} }), {
                  status: 200,
                  headers: { "content-type": "application/json" },
                }),
              ),
            );
          }),
        );

        const unready = yield* octoPrintAdapter
          .poll(OCTOPRINT_CONFIG, "octo-secret", undefined, {})
          .pipe(Effect.provide(mockClient));
        expect(unready.snapshot.job.status).toBe("prepare");
        expect(unready.snapshot.capabilities.canJog).toBe(false);

        mode = "ready";
        const ready = yield* octoPrintAdapter
          .poll(OCTOPRINT_CONFIG, "octo-secret", undefined, {})
          .pipe(Effect.provide(mockClient));
        expect(ready.snapshot.job.status).toBe("idle");
        expect(ready.snapshot.capabilities.canJog).toBe(true);

        mode = "null";
        const nullExit = yield* Effect.exit(
          octoPrintAdapter
            .poll(OCTOPRINT_CONFIG, "octo-secret", undefined, {})
            .pipe(Effect.provide(mockClient)),
        );
        expect(Exit.isFailure(nullExit)).toBe(true);
      }),
  );
});
