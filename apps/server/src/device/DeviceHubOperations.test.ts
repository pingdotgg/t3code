import { expect, it } from "@effect/vitest";
import { LOCAL_DEVICE_HOST_ID } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { HttpClient, HttpClientResponse } from "effect/http";

import { makeDeviceHubOperations } from "./DeviceHubOperations.ts";

const used = {
  id: "used",
  name: "Used iPhone",
  version: "iOS 27.0",
  platform: "ios",
  booted: true,
  physical: false,
} as const;

it.effect("adds never-used iOS simulators from the hub's grid", () =>
  Effect.gen(function* () {
    const operations = makeDeviceHubOperations({
      hostId: LOCAL_DEVICE_HOST_ID,
      origin: "http://device.test",
      http: HttpClient.make((request) =>
        Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            Response.json(
              request.url.endsWith("/api/devices")
                ? // The hub's recent-device inventory omits simulators without usage timestamps.
                  { simulators: [used], emulators: [] }
                : {
                    devices: [
                      { device: "USED", name: "Grid name", runtime: "iOS-27-0", state: "Booted" },
                      {
                        device: "fresh",
                        name: "Fresh iPhone",
                        runtime: "iOS-27-0",
                        state: "Shutdown",
                      },
                      {
                        device: "watch",
                        name: "Watch",
                        runtime: "watchOS-27-0",
                        state: "Shutdown",
                      },
                    ],
                  },
            ),
          ),
        ),
      ),
      run: () => Effect.die("iOS discovery uses the hub"),
      availablePlatforms: Effect.succeed({ ios: true, android: false }),
    });
    expect((yield* operations.list).devices).toEqual([
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
  }),
);

it.effect.each(["unavailable", "http-error", "invalid-json"])(
  "keeps hub inventory and diagnostics when iOS grid discovery is %s",
  (scenario) =>
    Effect.gen(function* () {
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
              scenario === "http-error"
                ? new Response("private diagnostics", { status: 500 })
                : Response.json({ unexpected: "private diagnostics" }),
            );
          }),
        ),
        run: () => Effect.die("Discovery must not run a command"),
        availablePlatforms: Effect.succeed({ ios: scenario !== "unavailable", android: false }),
      });
      const listed = yield* operations.list;
      expect(listed.devices).toEqual([used]);
      expect(listed.detail).toBe(
        scenario === "unavailable"
          ? "Existing discovery warning"
          : "Existing discovery warning\nCould not list all iOS simulators. Recently used simulators remain available.",
      );
    }),
);
