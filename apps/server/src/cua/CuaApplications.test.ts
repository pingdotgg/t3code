import { it } from "@effect/vitest";
import { expect } from "vite-plus/test";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as CuaApplications from "./CuaApplications.ts";
import * as CuaDriver from "./CuaDriver.ts";

it.effect(
  "lists and deduplicates native identities across platforms, then releases its client",
  () =>
    Effect.gen(function* () {
      let released = 0;
      const windows = {
        name: "Calculator",
        bundleId: "Microsoft.WindowsCalculator_8wekyb3d8bbwe!App",
        pid: 42,
        running: true,
      };
      const sdk = {
        CuaDriver: {
          connect: () => ({
            listApps: async () => ({
              apps: [
                windows,
                windows,
                {
                  name: "Helium",
                  bundleId: "C:\\Apps\\helium.exe",
                  launchPath: "C:\\Apps\\helium.exe",
                  pid: 1,
                  running: true,
                },
                {
                  name: "Terminal",
                  launchPath: "/usr/share/applications/terminal.desktop",
                  pid: 0,
                  running: false,
                },
                { name: "", pid: 0, running: false },
              ],
            }),
            shutdown: async () => {},
            uniffiDestroy: () => {
              released++;
            },
          }),
        },
        ListAppsInput: { new: () => ({}) },
      } as unknown as CuaApplications.Sdk;
      const service = yield* CuaApplications.make({ loadSdk: Effect.succeed(sdk) });
      expect(yield* service.list).toEqual([
        { name: "Calculator", bundleId: windows.bundleId, pid: 42 },
        { name: "Helium", launchPath: "C:\\Apps\\helium.exe", pid: 1 },
        { name: "Terminal", launchPath: "/usr/share/applications/terminal.desktop" },
      ]);
      expect(released).toBe(1);
    }).pipe(
      Effect.provideService(
        CuaDriver.CuaDriver,
        CuaDriver.CuaDriver.of({
          enabled: Effect.succeed(true),
          acquire: Effect.succeedSome({
            command: "driver",
            args: [],
            environment: [],
            socketPath: "test",
          }),
          lastFailure: Effect.succeedNone,
          status: Effect.succeed({ platform: "win32", running: true }),
        }),
      ),
      Effect.provide(NodeServices.layer),
    ),
);

it.effect("does not start the driver when Computer Use is disabled", () =>
  Effect.gen(function* () {
    const service = yield* CuaApplications.make({ loadSdk: Effect.die("must not load") });
    expect(yield* service.list).toEqual([]);
  }).pipe(
    Effect.provideService(
      CuaDriver.CuaDriver,
      CuaDriver.CuaDriver.of({
        enabled: Effect.succeed(false),
        acquire: Effect.die("must not start"),
        lastFailure: Effect.succeedNone,
        status: Effect.succeed({ platform: "win32", running: false }),
      }),
    ),
    Effect.provide(NodeServices.layer),
  ),
);
