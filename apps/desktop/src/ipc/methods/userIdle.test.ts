import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";
import { expect, vi } from "vite-plus/test";
import { it } from "@effect/vitest";

const native = vi.hoisted(() => ({
  isDestroyed: () => false,
  webContents: { send: vi.fn() },
}));
vi.mock("electron", () => ({ BrowserWindow: { getAllWindows: () => [native] } }));

import * as ElectronPowerMonitor from "../../electron/ElectronPowerMonitor.ts";
import * as DesktopIpc from "../DesktopIpc.ts";
import { installUserPresence } from "./userIdle.ts";

function withUserPresence<A>(
  body: (machine: {
    readonly readIdleMs: () => Effect.Effect<unknown>;
    readonly setIdleSeconds: (seconds: number) => void;
    readonly setIdleState: (state: ElectronPowerMonitor.ElectronIdleState) => void;
    readonly firePowerEvent: (eventName: string) => void;
  }) => Effect.Effect<A>,
) {
  native.webContents.send.mockClear();
  const handlers = new Map<string, DesktopIpc.DesktopIpcHandleListener>();
  const powerEvents = new Map<string, () => void>();
  let idleSeconds = 42;
  let idleState: ElectronPowerMonitor.ElectronIdleState = "active";
  return Effect.scoped(
    Effect.gen(function* () {
      yield* installUserPresence();
      return yield* body({
        readIdleMs: () =>
          Effect.promise(() =>
            Promise.resolve(
              handlers.get("desktop:get-user-idle-ms")!({ sender: { id: 1 } }, undefined),
            ),
          ),
        setIdleSeconds: (seconds) => {
          idleSeconds = seconds;
        },
        setIdleState: (state) => {
          idleState = state;
        },
        firePowerEvent: (eventName) => powerEvents.get(eventName)!(),
      });
    }),
  ).pipe(
    Effect.provideService(ElectronPowerMonitor.ElectronPowerMonitor, {
      isOnBatteryPower: Effect.succeed(false),
      getSystemIdleTime: Effect.sync(() => idleSeconds),
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
}

it.effect("reports the system idle time and treats a locked or sleeping computer as away", () =>
  withUserPresence(({ readIdleMs, setIdleState, firePowerEvent }) =>
    Effect.gen(function* () {
      expect(yield* readIdleMs()).toBe(42_000);
      setIdleState("locked");
      firePowerEvent("lock-screen");
      expect(yield* readIdleMs()).toBeNull();
      setIdleState("active");
      firePowerEvent("suspend");
      expect(yield* readIdleMs()).toBeNull();
      firePowerEvent("resume");
      expect(yield* readIdleMs()).toBe(42_000);
      expect(native.webContents.send).toHaveBeenCalledTimes(3);
      expect(native.webContents.send).toHaveBeenCalledWith("desktop:user-away-changed");
    }),
  ),
);

it.effect("tells windows as soon as someone comes back after a minute away", () =>
  withUserPresence(({ setIdleSeconds }) =>
    Effect.gen(function* () {
      setIdleSeconds(30);
      yield* TestClock.adjust("5 seconds");
      setIdleSeconds(0);
      yield* TestClock.adjust("5 seconds");
      expect(native.webContents.send).not.toHaveBeenCalled();

      setIdleSeconds(90);
      yield* TestClock.adjust("5 seconds");
      setIdleSeconds(1);
      yield* TestClock.adjust("5 seconds");
      expect(native.webContents.send).toHaveBeenCalledTimes(1);
    }),
  ),
);
