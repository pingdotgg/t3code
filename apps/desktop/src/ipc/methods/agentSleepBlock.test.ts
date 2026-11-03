import * as Effect from "effect/Effect";
import { beforeEach, expect, vi } from "vite-plus/test";
import { it } from "@effect/vitest";

const native = vi.hoisted(() => ({
  start: vi.fn(),
  stop: vi.fn(),
  listeners: new Map<string, (event?: unknown) => void>(),
}));
vi.mock("electron", () => ({
  app: {
    on: (event: string, listener: () => void) => native.listeners.set(event, listener),
    removeListener: (event: string) => native.listeners.delete(event),
  },
  powerSaveBlocker: { start: native.start, stop: native.stop },
}));

import * as ElectronApp from "../../electron/ElectronApp.ts";
import * as DesktopIpc from "../DesktopIpc.ts";
import { applyAgentSleepBlock, installAgentSleepBlock } from "./agentSleepBlock.ts";

beforeEach(() => {
  vi.clearAllMocks();
  native.start.mockReturnValue(7);
  // Reset the module-level blocker id between tests.
  applyAgentSleepBlock(false);
  native.stop.mockClear();
  native.listeners.clear();
});

it("starts the blocker once and stops it on the same id", () => {
  applyAgentSleepBlock(true);
  applyAgentSleepBlock(true);
  expect(native.start).toHaveBeenCalledTimes(1);
  expect(native.stop).not.toHaveBeenCalled();
  applyAgentSleepBlock(false);
  expect(native.stop).toHaveBeenLastCalledWith(7);
  applyAgentSleepBlock(false);
  expect(native.stop).toHaveBeenCalledTimes(1);
});

it("re-arms after a cycle", () => {
  applyAgentSleepBlock(true);
  applyAgentSleepBlock(false);
  native.start.mockReturnValue(9);
  applyAgentSleepBlock(true);
  expect(native.start).toHaveBeenCalledTimes(2);
  applyAgentSleepBlock(false);
  expect(native.stop).toHaveBeenLastCalledWith(9);
});

it("keeps agent work running when the native blocker API fails", () => {
  native.start.mockImplementation(() => {
    throw new Error("Unavailable");
  });
  expect(() => applyAgentSleepBlock(true)).not.toThrow();
  applyAgentSleepBlock(false);
  expect(native.stop).not.toHaveBeenCalled();
});

it.effect("validates IPC and releases the blocker on quit and disposal", () =>
  Effect.gen(function* () {
    const handlers = new Map<string, DesktopIpc.DesktopIpcHandleListener>();
    yield* Effect.scoped(
      Effect.gen(function* () {
        yield* installAgentSleepBlock();
        const handler = handlers.get("desktop:set-agent-sleep-block")!;
        const event = { sender: { id: 1 } };
        for (const invalid of [{ active: "true" }, {}, { active: 1 }] as const) {
          yield* Effect.promise(() => expect(handler(event, invalid)).rejects.toBeDefined());
        }
        expect(native.start).not.toHaveBeenCalled();
        yield* Effect.promise(() => Promise.resolve(handler(event, { active: true })));
        expect(native.start).toHaveBeenLastCalledWith("prevent-app-suspension");
        // The renderer's repeat reports for an unchanged state stay idempotent.
        yield* Effect.promise(() => Promise.resolve(handler(event, { active: true })));
        expect(native.start).toHaveBeenCalledTimes(1);
        yield* Effect.promise(() => Promise.resolve(handler(event, { active: false })));
        expect(native.stop).toHaveBeenLastCalledWith(7);

        // A renderer crash leaves nothing behind when the app goes down.
        native.start.mockReturnValue(7);
        yield* Effect.promise(() => Promise.resolve(handler(event, { active: true })));
        native.listeners.get("before-quit")!();
        expect(native.stop).toHaveBeenLastCalledWith(7);
      }),
    ).pipe(
      Effect.provide([
        ElectronApp.layer,
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
      ]),
    );
    expect(native.stop).toHaveBeenLastCalledWith(7);
    expect(native.listeners.size).toBe(0);
    expect(handlers.size).toBe(0);
  }),
);
