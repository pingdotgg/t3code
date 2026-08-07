import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import type { EmbeddedDriverConnection, EmbeddedDriverExit } from "@trycua/cua-driver/embedded";

import * as DesktopConfig from "../app/DesktopConfig.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import {
  CuaDriverNotConfiguredError,
  CuaDriverPermissionError,
  make,
  resolveEmbeddedDriverPath,
} from "./DesktopCuaDriver.ts";

const connection: EmbeddedDriverConnection = {
  socketPath: "/tmp/t3-cua.sock",
  pid: 4242,
  generation: "generation-1",
  driverVersion: "0.12.2",
  contractVersion: "1",
  mcpProtocolVersion: "2025-06-18",
  mcp: {
    command: "/Applications/T3 Code.app/Contents/Resources/cua-driver",
    args: ["mcp", "--embedded", "--socket", "/tmp/t3-cua.sock"],
    environment: [{ name: "CUA_DRIVER_EMBEDDED", value: "1" }],
  },
};

const environmentLayer = (isPackaged: boolean) =>
  DesktopEnvironment.layer({
    dirname: "/repo/apps/desktop/src",
    homeDirectory: "/Users/test",
    platform: "darwin",
    processArch: "arm64",
    appVersion: "1.2.3",
    appPath: "/Applications/T3 Code.app",
    isPackaged,
    resourcesPath: "/Applications/T3 Code.app/Contents/Resources",
    runningUnderArm64Translation: false,
  }).pipe(
    Layer.provide(
      Layer.mergeAll(
        NodeServices.layer,
        DesktopConfig.layerTest({
          T3CODE_HOME: "/Users/test/.t3",
          T3CODE_PORT: "3773",
          T3CODE_MODE: "desktop",
        }),
      ),
    ),
  );

describe("DesktopCuaDriver", () => {
  it.effect("starts the daemon from the desktop host and exposes its exact MCP descriptor", () => {
    const events: Array<string> = [];
    let constructorPath: string | undefined;

    class FakeEmbeddedCuaDriverHost {
      constructor(binaryPath: string, hostBundleId: string) {
        constructorPath = binaryPath;
        events.push(`construct:${hostBundleId}`);
      }
      start = () => {
        events.push("start");
        return Promise.resolve(connection);
      };
      stop = () => {
        events.push("stop");
        return Promise.resolve();
      };
      waitForExit = () => new Promise<EmbeddedDriverExit>(() => {});
      uniffiDestroy = () => events.push("destroy");
    }

    return Effect.scoped(
      Effect.gen(function* () {
        const service = yield* make({
          loadElectron: () =>
            Promise.resolve({
              requestMacOSPermissions: () => {
                events.push("permissions");
                return { accessibility: true, screenRecording: true };
              },
              hasRequiredMacOSPermissions: () => true,
            } as unknown as typeof import("@trycua/cua-driver/electron")),
          loadEmbedded: () =>
            Promise.resolve({
              EmbeddedCuaDriverHost: FakeEmbeddedCuaDriverHost,
            } as unknown as typeof import("@trycua/cua-driver/embedded")),
        });

        const mcp = yield* service.start;
        expect(mcp).toEqual(connection.mcp);
        expect(Option.getOrUndefined(yield* service.mcpConfiguration)).toEqual(connection.mcp);
        expect(constructorPath).toBe("/Applications/T3 Code.app/Contents/Resources/cua-driver");
        expect(events).toEqual(["permissions", "construct:com.t3tools.t3code", "start"]);

        yield* service.stop;
        expect(Option.isNone(yield* service.mcpConfiguration)).toBe(true);
        expect(events).toEqual([
          "permissions",
          "construct:com.t3tools.t3code",
          "start",
          "stop",
          "destroy",
        ]);
      }),
    ).pipe(Effect.provide(environmentLayer(true)));
  });

  it.effect("does not start a daemon until both macOS grants are active", () => {
    let loadedEmbedded = false;
    return Effect.scoped(
      Effect.gen(function* () {
        const service = yield* make({
          loadElectron: () =>
            Promise.resolve({
              requestMacOSPermissions: () => ({
                accessibility: true,
                screenRecording: false,
              }),
              hasRequiredMacOSPermissions: () => false,
            } as unknown as typeof import("@trycua/cua-driver/electron")),
          loadEmbedded: () => {
            loadedEmbedded = true;
            return Promise.reject(new Error("must not load"));
          },
        });

        const error = yield* service.start.pipe(Effect.flip);
        expect(error).toBeInstanceOf(CuaDriverPermissionError);
        expect(loadedEmbedded).toBe(false);
      }),
    ).pipe(Effect.provide(environmentLayer(true)));
  });

  it.effect("reports an unexpected daemon exit after clearing its MCP descriptor", () => {
    return Effect.scoped(
      Effect.gen(function* () {
        let resolveExit: (exit: EmbeddedDriverExit) => void = () => {};
        const exit = new Promise<EmbeddedDriverExit>((resolve) => {
          resolveExit = resolve;
        });

        class ExitingEmbeddedCuaDriverHost {
          start = () => Promise.resolve(connection);
          stop = () => Promise.resolve();
          waitForExit = () => exit;
          uniffiDestroy = () => {};
        }

        const service = yield* make({
          loadElectron: () =>
            Promise.resolve({
              requestMacOSPermissions: () => ({
                accessibility: true,
                screenRecording: true,
              }),
              hasRequiredMacOSPermissions: () => true,
            } as unknown as typeof import("@trycua/cua-driver/electron")),
          loadEmbedded: () =>
            Promise.resolve({
              EmbeddedCuaDriverHost: ExitingEmbeddedCuaDriverHost,
            } as unknown as typeof import("@trycua/cua-driver/embedded")),
        });

        yield* service.start;
        const unavailable = yield* service.awaitUnavailable.pipe(Effect.forkScoped);
        resolveExit({ generation: connection.generation, code: 9, success: false });
        yield* Fiber.await(unavailable);

        expect(Option.isNone(yield* service.mcpConfiguration)).toBe(true);
      }),
    ).pipe(Effect.provide(environmentLayer(true)));
  });

  it.effect("requires an explicit driver path in development", () => {
    const previous = process.env.T3CODE_CUA_DRIVER_PATH;
    delete process.env.T3CODE_CUA_DRIVER_PATH;
    return Effect.scoped(
      Effect.gen(function* () {
        const service = yield* make();
        const error = yield* service.start.pipe(Effect.flip);
        expect(error).toBeInstanceOf(CuaDriverNotConfiguredError);
      }),
    ).pipe(
      Effect.provide(environmentLayer(false)),
      Effect.ensuring(
        Effect.sync(() => {
          if (previous === undefined) delete process.env.T3CODE_CUA_DRIVER_PATH;
          else process.env.T3CODE_CUA_DRIVER_PATH = previous;
        }),
      ),
    );
  });

  it.effect(
    "uses an arbitrary absolute development path but never overrides packaged resources",
    () =>
      Effect.gen(function* () {
        const desktop = yield* DesktopEnvironment.DesktopEnvironment;
        expect(
          Option.getOrUndefined(
            resolveEmbeddedDriverPath(
              { T3CODE_CUA_DRIVER_PATH: "/opt/custom/bin/cua-driver" },
              { ...desktop, isPackaged: false },
            ),
          ),
        ).toBe("/opt/custom/bin/cua-driver");
        expect(
          Option.getOrUndefined(
            resolveEmbeddedDriverPath(
              { T3CODE_CUA_DRIVER_PATH: "/tmp/untrusted" },
              { ...desktop, isPackaged: true },
            ),
          ),
        ).toBe("/Applications/T3 Code.app/Contents/Resources/cua-driver");
      }).pipe(Effect.provide(environmentLayer(true))),
  );
});
