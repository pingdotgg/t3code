import {
  type MoonrakerPrinterConfig,
  type OctoPrintPrinterConfig,
  PrinterId,
} from "@t3tools/contracts";
import { it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import { HttpClient, HttpClientResponse } from "effect/http";
import * as TestClock from "effect/testing/TestClock";
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
    "preserves Klipper coordinate mode with unique per-attempt SAVE/RESTORE_GCODE_STATE and attempts restore on HTTP and transport failures",
    () =>
      Effect.gen(function* () {
        const scripts: Array<string> = [];
        let mode: "ok" | "http400" | "transport" = "ok";
        const mockClient = Layer.succeed(
          HttpClient.HttpClient,
          HttpClient.make((request) => {
            const url = new URL(request.url);
            const script = url.searchParams.get("script") ?? "";
            scripts.push(script);
            if (mode === "http400" && script.includes("G0 ")) {
              return Effect.succeed(
                HttpClientResponse.fromWeb(
                  request,
                  new Response("Move out of range", { status: 400 }),
                ),
              );
            }
            if (mode === "transport" && script.includes("G0 ")) {
              return Effect.fail(new Error("ECONNREFUSED") as never);
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
        expect(scripts).toHaveLength(1);
        const firstMatch =
          /^SAVE_GCODE_STATE NAME=(T3_JOG_[a-z0-9_]+)\nG91\nG0 X5 F3000\nRESTORE_GCODE_STATE NAME=(T3_JOG_[a-z0-9_]+)$/.exec(
            scripts[0]!,
          );
        expect(firstMatch).not.toBeNull();
        expect(firstMatch?.[1]).toBe(firstMatch?.[2]);

        scripts.length = 0;
        mode = "http400";
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
        expect(scripts).toHaveLength(2);
        const secondMatch =
          /^SAVE_GCODE_STATE NAME=(T3_JOG_[a-z0-9_]+)\nG91\nG0 Z-2 F3000\nRESTORE_GCODE_STATE NAME=(T3_JOG_[a-z0-9_]+)$/.exec(
            scripts[0]!,
          );
        expect(secondMatch).not.toBeNull();
        expect(secondMatch?.[1]).toBe(secondMatch?.[2]);
        expect(secondMatch?.[1]).not.toBe(firstMatch?.[1]);
        expect(scripts[1]).toBe(`RESTORE_GCODE_STATE NAME=${secondMatch?.[1]}`);

        // Transport failure/timeout can occur after G91 ran on Klipper, so best-effort restore uses the same unique state name.
        scripts.length = 0;
        mode = "transport";
        const transportExit = yield* Effect.exit(
          moonrakerAdapter
            .executeAction(
              MOONRAKER_CONFIG,
              "moonraker-secret",
              { kind: "moveAxis", axis: "Y", distanceMm: 1 },
              {} as never,
              {},
            )
            .pipe(Effect.provide(mockClient)),
        );
        expect(Exit.isFailure(transportExit)).toBe(true);
        expect(scripts).toHaveLength(2);
        const thirdMatch =
          /^SAVE_GCODE_STATE NAME=(T3_JOG_[a-z0-9_]+)\nG91\nG0 Y1 F3000\nRESTORE_GCODE_STATE NAME=(T3_JOG_[a-z0-9_]+)$/.exec(
            scripts[0]!,
          );
        expect(thirdMatch).not.toBeNull();
        expect(thirdMatch?.[1]).toBe(thirdMatch?.[2]);
        expect(thirdMatch?.[1]).not.toBe(secondMatch?.[1]);
        expect(scripts[1]).toBe(`RESTORE_GCODE_STATE NAME=${thirdMatch?.[1]}`);
      }),
  );

  it.effect("rejects non-image HTML payload returned by Moonraker webcam URL", () =>
    Effect.gen(function* () {
      const mockClient = Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request) =>
          Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              new Response("<html>404</html>", {
                status: 200,
                headers: { "content-type": "text/html" },
              }),
            ),
          ),
        ),
      );
      const exit = yield* Effect.exit(
        moonrakerAdapter
          .fetchMedia(MOONRAKER_CONFIG, "moonraker-secret", "camera", {} as never, {})
          .pipe(Effect.provide(mockClient)),
      );
      expect(Exit.isFailure(exit)).toBe(true);
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

        // 1. Cancelling & resuming must suppress settled print/motion controls.
        const cancelling = yield* octoPrintAdapter
          .poll(OCTOPRINT_CONFIG, "octo-secret", undefined, {})
          .pipe(Effect.provide(mockClient));
        expect(cancelling.snapshot.job.status).toBe("running");
        expect(cancelling.snapshot.capabilities.canJog).toBe(false);
        expect(cancelling.snapshot.capabilities.canPause).toBe(false);
        expect(cancelling.snapshot.capabilities.canResume).toBe(false);
        expect(cancelling.snapshot.capabilities.canStop).toBe(false);

        authMode = "resuming";
        const resuming = yield* octoPrintAdapter
          .poll(OCTOPRINT_CONFIG, "octo-secret", undefined, {})
          .pipe(Effect.provide(mockClient));
        expect(resuming.snapshot.job.status).toBe("pause");
        expect(resuming.snapshot.capabilities.canJog).toBe(false);
        expect(resuming.snapshot.capabilities.canPause).toBe(false);
        expect(resuming.snapshot.capabilities.canResume).toBe(false);
        expect(resuming.snapshot.capabilities.canStop).toBe(false);

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
    "requires settled operational+ready flags for idle/jog, rejects ready without operational, and maps JSON null to PrinterOperationError",
    () =>
      Effect.gen(function* () {
        let mode: "unready" | "readyNotOperational" | "pausing" | "ready" | "null" = "unready";
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
              const flags =
                mode === "ready"
                  ? { operational: true, ready: true }
                  : mode === "readyNotOperational"
                    ? { operational: false, ready: true }
                    : mode === "pausing"
                      ? { operational: true, pausing: true, printing: true }
                      : { operational: true, ready: false };
              return Effect.succeed(
                HttpClientResponse.fromWeb(
                  request,
                  new Response(
                    JSON.stringify({
                      state: {
                        text:
                          mode === "ready"
                            ? "Operational"
                            : mode === "pausing"
                              ? "Pausing"
                              : "Transferring file to SD",
                        flags,
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

        mode = "readyNotOperational";
        const notOp = yield* octoPrintAdapter
          .poll(OCTOPRINT_CONFIG, "octo-secret", undefined, {})
          .pipe(Effect.provide(mockClient));
        expect(notOp.snapshot.job.status).toBe("offline");
        expect(notOp.snapshot.capabilities.canJog).toBe(false);

        mode = "pausing";
        const pausing = yield* octoPrintAdapter
          .poll(OCTOPRINT_CONFIG, "octo-secret", undefined, {})
          .pipe(Effect.provide(mockClient));
        expect(pausing.snapshot.capabilities.canPause).toBe(false);
        expect(pausing.snapshot.capabilities.canResume).toBe(false);
        // Stop/cancel remains available while pausing an active print, but not while already cancelling.
        expect(pausing.snapshot.capabilities.canStop).toBe(true);
        expect(pausing.snapshot.capabilities.canJog).toBe(false);

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

  it.effect(
    "derives stable startedAt during an active print and rotates it when elapsed time resets on reprint for Moonraker and OctoPrint",
    () =>
      Effect.gen(function* () {
        let elapsedSec = 600;
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
            return Effect.succeed(
              HttpClientResponse.fromWeb(
                request,
                new Response(
                  JSON.stringify({
                    result: {
                      status: {
                        webhooks: { state: "ready" },
                        print_stats: {
                          state: "printing",
                          filename: "part.gcode",
                          print_duration: elapsedSec,
                        },
                      },
                    },
                  }),
                  { status: 200, headers: { "content-type": "application/json" } },
                ),
              ),
            );
          }),
        );

        yield* TestClock.adjust(Duration.seconds(1000));
        const m1 = yield* moonrakerAdapter
          .poll(MOONRAKER_CONFIG, "moonraker-secret", undefined, {})
          .pipe(Effect.provide(moonClient));
        expect(m1.snapshot.job.startedAt).not.toBeNull();

        // Normal progress keeps the exact same startedAt without jitter.
        yield* TestClock.adjust(Duration.seconds(5));
        elapsedSec = 604;
        const m2 = yield* moonrakerAdapter
          .poll(MOONRAKER_CONFIG, "moonraker-secret", m1.snapshot, m1.cache)
          .pipe(Effect.provide(moonClient));
        expect(m2.snapshot.job.startedAt).toBe(m1.snapshot.job.startedAt);

        // Same filename reprinted immediately (elapsed resets to 2s) rotates startedAt.
        yield* TestClock.adjust(Duration.seconds(5));
        elapsedSec = 2;
        const m3 = yield* moonrakerAdapter
          .poll(MOONRAKER_CONFIG, "moonraker-secret", m2.snapshot, m2.cache)
          .pipe(Effect.provide(moonClient));
        expect(m3.snapshot.job.startedAt).not.toBeNull();
        expect(m3.snapshot.job.startedAt).not.toBe(m1.snapshot.job.startedAt);

        // OctoPrint behaves identically using progress.printTime.
        let octoPrintTime = 300;
        const octoClient = Layer.succeed(
          HttpClient.HttpClient,
          HttpClient.make((request) => {
            const url = new URL(request.url);
            if (url.pathname === "/api/printer") {
              return Effect.succeed(
                HttpClientResponse.fromWeb(
                  request,
                  new Response(
                    JSON.stringify({
                      state: { text: "Printing", flags: { operational: true, printing: true } },
                    }),
                    { status: 200, headers: { "content-type": "application/json" } },
                  ),
                ),
              );
            }
            return Effect.succeed(
              HttpClientResponse.fromWeb(
                request,
                new Response(
                  JSON.stringify({
                    job: { file: { name: "part.gcode" } },
                    progress: { printTime: octoPrintTime },
                  }),
                  { status: 200, headers: { "content-type": "application/json" } },
                ),
              ),
            );
          }),
        );
        const o1 = yield* octoPrintAdapter
          .poll(OCTOPRINT_CONFIG, "octo-secret", undefined, {})
          .pipe(Effect.provide(octoClient));
        expect(o1.snapshot.job.startedAt).not.toBeNull();

        yield* TestClock.adjust(Duration.seconds(5));
        octoPrintTime = 304;
        const o2 = yield* octoPrintAdapter
          .poll(OCTOPRINT_CONFIG, "octo-secret", o1.snapshot, o1.cache)
          .pipe(Effect.provide(octoClient));
        expect(o2.snapshot.job.startedAt).toBe(o1.snapshot.job.startedAt);

        yield* TestClock.adjust(Duration.seconds(5));
        octoPrintTime = 3;
        const o3 = yield* octoPrintAdapter
          .poll(OCTOPRINT_CONFIG, "octo-secret", o2.snapshot, o2.cache)
          .pipe(Effect.provide(octoClient));
        expect(o3.snapshot.job.startedAt).not.toBeNull();
        expect(o3.snapshot.job.startedAt).not.toBe(o1.snapshot.job.startedAt);
      }),
  );
});
