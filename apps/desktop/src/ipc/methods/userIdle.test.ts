import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
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

function withUserPresence(
  body: (machine: {
    readonly readIdleMs: () => Effect.Effect<unknown>;
    readonly set: (next: {
      idleSeconds?: number;
      idleState?: ElectronPowerMonitor.ElectronIdleState;
    }) => void;
    readonly fire: (eventName: string) => void;
  }) => Effect.Effect<void>,
) {
  native.webContents.send.mockClear();
  const handlers = new Map<string, DesktopIpc.DesktopIpcHandleListener>();
  const powerEvents = new Map<string, () => void>();
  const machine = {
    idleSeconds: 42,
    idleState: "active" as ElectronPowerMonitor.ElectronIdleState,
  };
  return Effect.scoped(
    Effect.gen(function* () {
      yield* installUserPresence();
      yield* body({
        readIdleMs: () =>
          Effect.promise(async () =>
            handlers.get("desktop:get-user-idle-ms")!({ sender: { id: 1 } }, undefined),
          ),
        set: (next) => void Object.assign(machine, next),
        fire: (eventName) => powerEvents.get(eventName)!(),
      });
    }),
  ).pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.mock(ElectronPowerMonitor.ElectronPowerMonitor, {
          getSystemIdleTime: Effect.sync(() => machine.idleSeconds),
          getSystemIdleState: () => Effect.sync(() => machine.idleState),
          onSimpleEvent: (eventName, listener) =>
            Effect.sync(() => void powerEvents.set(eventName, listener)),
        }),
        DesktopIpc.layer({
          handle: (channel, handler) => void handlers.set(channel, handler),
          removeHandler: (channel) => void handlers.delete(channel),
          on: vi.fn(),
          removeAllListeners: vi.fn(),
        }),
      ),
    ),
  );
}

it.effect("reports the system idle time and treats a locked or sleeping computer as away", () =>
  withUserPresence(({ readIdleMs, set, fire }) =>
    Effect.gen(function* () {
      expect(yield* readIdleMs()).toBe(42_000);
      set({ idleState: "locked" });
      fire("lock-screen");
      expect(yield* readIdleMs()).toBeNull();
      set({ idleState: "active" });
      fire("suspend");
      expect(yield* readIdleMs()).toBeNull();
      fire("resume");
      expect(yield* readIdleMs()).toBe(42_000);
      expect(native.webContents.send).toHaveBeenCalledTimes(3);
      expect(native.webContents.send).toHaveBeenCalledWith("desktop:user-away-changed");
    }),
  ),
);

it.effect("tells windows as soon as someone comes back after a minute away", () =>
  withUserPresence(({ set }) =>
    Effect.gen(function* () {
      for (const [idleSeconds, sends] of [
        [30, 0],
        [0, 0],
        [90, 0],
        [1, 1],
      ] as const) {
        set({ idleSeconds });
        yield* TestClock.adjust("5 seconds");
        expect(native.webContents.send).toHaveBeenCalledTimes(sends);
      }
    }),
  ),
);
