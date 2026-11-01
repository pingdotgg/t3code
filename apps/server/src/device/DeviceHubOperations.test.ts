import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import { makeDeviceHubOperations } from "./DeviceHubOperations.ts";

const simulator = (id: string, name: string) => ({
  id,
  name,
  version: "iOS 27.0",
  platform: "ios",
  booted: true,
  physical: false,
});

const operations = (simctl: { stdout: string; code: number }) =>
  makeDeviceHubOperations({
    hostId: "local",
    origin: "http://hub",
    http: HttpClient.make((request) =>
      Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          Response.json({
            simulators: [simulator("A", "iPhone (clean)"), simulator("B", "Unknown type")],
            emulators: [],
          }),
        ),
      ),
    ),
    run: (command, args) =>
      Effect.succeed(
        command === "xcrun" && args.join(" ") === "simctl list -j"
          ? { ...simctl, stderr: "" }
          : { stdout: "", stderr: "", code: 1 },
      ),
    androidAvailable: Effect.succeed(false),
  });

it.effect("names a renamed simulator's hardware from its device type", () =>
  Effect.gen(function* () {
    const { devices } = yield* operations({
      code: 0,
      stdout: JSON.stringify({
        devicetypes: [
          {
            identifier: "com.apple.CoreSimulator.SimDeviceType.iPhone-18-Pro",
            name: "iPhone 18 Pro",
          },
        ],
        devices: {
          "com.apple.CoreSimulator.SimRuntime.iOS-27-0": [
            {
              udid: "A",
              deviceTypeIdentifier: "com.apple.CoreSimulator.SimDeviceType.iPhone-18-Pro",
            },
            { udid: "B", deviceTypeIdentifier: "com.apple.CoreSimulator.SimDeviceType.Gone" },
          ],
        },
      }),
    }).list;
    expect(devices.map((device) => [device.name, device.model])).toEqual([
      ["iPhone (clean)", "iPhone 18 Pro"],
      ["Unknown type", undefined],
    ]);
  }),
);

it.effect("still lists simulators when simctl cannot describe them", () =>
  Effect.gen(function* () {
    const { devices } = yield* operations({ code: 1, stdout: "" }).list;
    expect(devices.map((device) => device.model)).toEqual([undefined, undefined]);
  }),
);
