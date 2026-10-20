import * as Effect from "effect/Effect";
import { expect, vi } from "vite-plus/test";
import { it } from "@effect/vitest";

const native = vi.hoisted(() => ({
  isDestroyed: () => false,
  webContents: { send: vi.fn() },
}));
vi.mock("electron", () => ({ BrowserWindow: { getAllWindows: () => [native] } }));

import * as ElectronPowerMonitor from "../../electron/ElectronPowerMonitor.ts";
import * as DesktopIpc from "../DesktopIpc.ts";
import { installUserIdle } from "./userIdle.ts";

it.effect("reports the system idle time and treats a locked or sleeping computer as away", () =>
  Effect.gen(function* () {
    const handlers = new Map<string, DesktopIpc.DesktopIpcHandleListener>();
    const powerEvents = new Map<string, () => void>();
    let idleState: ElectronPowerMonitor.ElectronIdleState = "active";
    yield* Effect.scoped(
      Effect.gen(function* () {
        yield* installUserIdle();
        const read = () =>
          Effect.promise(() =>
            Promise.resolve(
              handlers.get("desktop:get-user-idle-ms")!({ sender: { id: 1 } }, undefined),
            ),
          );

        expect(yield* read()).toBe(42_000);
        idleState = "locked";
        powerEvents.get("lock-screen")!();
        expect(yield* read()).toBeNull();
        idleState = "active";
        powerEvents.get("suspend")!();
        expect(yield* read()).toBeNull();
        powerEvents.get("resume")!();
        expect(yield* read()).toBe(42_000);
        expect(native.webContents.send).toHaveBeenCalledTimes(3);
        expect(native.webContents.send).toHaveBeenCalledWith("desktop:user-away-changed");
      }),
    ).pipe(
      Effect.provideService(ElectronPowerMonitor.ElectronPowerMonitor, {
        isOnBatteryPower: Effect.succeed(false),
        getSystemIdleTime: Effect.succeed(42),
        getSystemIdleState: () => Effect.sync(() => idleState),
        getCurrentThermalState: Effect.succeed("nominal" as const),
        onSimpleEvent: (eventName, listener) =>
          Effect.sync(() => void powerEvents.set(eventName, listener)),
        onThermalStateChange: () => Effect.void,
        onSpeedLimitChange: () => Effect.void,
      }),
      Effect.provide(
        DesktopIpc.layer({
          handle: (channel, handler) => {
            handlers.set(channel, handler);
          },
          removeHandler: (channel) => {
            handlers.delete(channel);
          },
          on: vi.fn(),
          removeAllListeners: vi.fn(),
        }),
      ),
    );
  }),
);
