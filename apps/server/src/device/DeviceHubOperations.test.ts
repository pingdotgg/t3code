import { expect, it } from "@effect/vitest";
import { LOCAL_DEVICE_HOST_ID } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { HttpClient, HttpClientResponse } from "effect/http";

import { makeDeviceHubOperations } from "./DeviceHubOperations.ts";

it.effect.each([LOCAL_DEVICE_HOST_ID, "ssh-fixture"])(
  "discovers and boots never-used iOS simulators on %s through the hub",
  (hostId) =>
    Effect.gen(function* () {
      const used = {
        id: "used",
        name: "Used iPhone",
        version: "iOS 27.0",
        platform: "ios",
        booted: true,
        physical: false,
      };
      const bootBodies: unknown[] = [];
      const attached: unknown[] = [];
      const http = HttpClient.make((request) =>
        Effect.sync(() => {
          const path = new URL(request.url).pathname;
          let body: unknown;
          if (path === "/api/devices") {
            // The hub's recent-device inventory omits simulators without usage timestamps.
            body = { simulators: [used], emulators: [] };
          } else if (path === "/vendor/serve-sim/grid/api") {
            body = {
              devices: [
                { device: "used", name: "Grid name", runtime: "iOS-27-0", state: "Booted" },
                { device: "fresh", name: "Fresh iPhone", runtime: "iOS-27-0", state: "Shutdown" },
                { device: "watch", name: "Watch", runtime: "watchOS-27-0", state: "Shutdown" },
              ],
            };
          } else {
            if (request.body._tag !== "Uint8Array") throw new Error("Missing action body");
            const payload: unknown = JSON.parse(new TextDecoder().decode(request.body.body));
            if (path === "/api/devices/boot") bootBodies.push(payload);
            else if (path === "/vendor/serve-sim/grid/api/start") attached.push(payload);
            else throw new Error(`Unexpected hub path: ${path}`);
            body = { ok: true };
          }
          return HttpClientResponse.fromWeb(request, Response.json(body));
        }),
      );
      const operations = makeDeviceHubOperations({
        hostId,
        origin: "http://device.test",
        http,
        run: () => Effect.die("iOS discovery uses the hub"),
        iosAvailable: Effect.succeed(true),
        androidAvailable: Effect.succeed(false),
      });
      const listed = yield* operations.list;
      expect(listed.devices).toEqual([
        used,
        {
          id: "fresh",
          name: "Fresh iPhone",
          version: "iOS 27.0",
          platform: "ios",
          booted: false,
          physical: false,
        },
      ]);
      const fresh = listed.devices.find((device) => device.id === "fresh")!;
      expect(yield* operations.boot(fresh)).toBe("fresh");
      expect(bootBodies).toEqual([{ platform: "ios", id: "fresh", name: "Fresh iPhone" }]);
      expect(attached).toEqual([{ udid: "fresh" }]);
    }),
);

it.effect.each(["unavailable", "http-error", "invalid-json"])(
  "keeps hub inventory and diagnostics when iOS grid discovery is %s",
  (scenario) =>
    Effect.gen(function* () {
      const used = {
        id: "used",
        name: "Used iPhone",
        version: "iOS 27.0",
        platform: "ios",
        booted: true,
        physical: false,
      };
      let recovered = false;
      const operations = makeDeviceHubOperations({
        hostId: LOCAL_DEVICE_HOST_ID,
        origin: "http://device.test",
        http: HttpClient.make((request) =>
          Effect.sync(() => {
            if (request.url.endsWith("/api/devices")) {
              return HttpClientResponse.fromWeb(
                request,
                Response.json({
                  simulators: [used],
                  emulators: [],
                  errors: [{ message: "Existing discovery warning" }],
                }),
              );
            }
            if (scenario === "unavailable") throw new Error("iOS must not be probed here");
            return HttpClientResponse.fromWeb(
              request,
              recovered
                ? Response.json({ devices: [] })
                : scenario === "http-error"
                  ? new Response("private diagnostics", { status: 500 })
                  : Response.json({ unexpected: "private diagnostics" }),
            );
          }),
        ),
        run: () => Effect.die("Discovery must not run a command"),
        iosAvailable: Effect.succeed(scenario !== "unavailable"),
        androidAvailable: Effect.succeed(false),
      });
      const listed = yield* operations.list;
      expect(listed.devices).toEqual([used]);
      expect(listed.detail).toBe(
        scenario === "unavailable"
          ? "Existing discovery warning"
          : "Existing discovery warning\nCould not list all iOS simulators. Recently used simulators remain available.",
      );
      recovered = true;
      expect((yield* operations.list).detail).toBe("Existing discovery warning");
    }),
);
