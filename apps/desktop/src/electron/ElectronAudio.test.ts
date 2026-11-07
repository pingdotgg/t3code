import * as Effect from "effect/Effect";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { app } from "electron";
import { expect, vi } from "vite-plus/test";
import { it } from "@effect/vitest";
import * as Fiber from "effect/Fiber";

const { getAppMetrics, kill } = vi.hoisted(() => ({ getAppMetrics: vi.fn(), kill: vi.fn() }));
vi.mock("node:process", () => ({ kill }));
vi.mock("electron", async () => {
  const { EventEmitter } = await import("node:events");
  return { app: Object.assign(new EventEmitter(), { getAppMetrics }) };
});

import { restart } from "./ElectronAudio.ts";

const audio = { pid: 42, type: "Utility", serviceName: "audio.mojom.AudioService" };

it.effect("coalesces recovery and waits for its own audio utility to exit", () =>
  Effect.gen(function* () {
    getAppMetrics.mockReturnValue([
      { pid: 1, type: "Utility", serviceName: "network.mojom.NetworkService" },
      { pid: 2, type: "Browser", serviceName: audio.serviceName },
      audio,
    ]);
    const started = Promise.withResolvers<void>();
    kill.mockReset().mockImplementation(() => {
      started.resolve();
    });
    const pending = yield* Effect.forkChild(
      Effect.all([restart(), restart()], { concurrency: "unbounded" }),
    );
    yield* Effect.promise(() => started.promise);
    app.emit(
      "child-process-gone",
      {},
      { type: "Utility", serviceName: "network.mojom.NetworkService" },
    );
    expect(app.listenerCount("child-process-gone")).toBe(1);
    app.emit("child-process-gone", {}, audio);
    expect(yield* Fiber.join(pending)).toEqual([true, true]);
    expect(kill.mock.calls).toEqual([[42, "SIGTERM"]]);
    expect(app.listenerCount("child-process-gone")).toBe(0);
  }).pipe(Effect.provideService(HostProcess.Platform, "linux")),
);

it.effect.each(["linux", "darwin", "win32"] as const)(
  "leaves other processes alone on %s",
  (platform) =>
    Effect.gen(function* () {
      getAppMetrics.mockReturnValue([
        { pid: 1, type: "Utility", serviceName: "network.mojom.NetworkService" },
      ]);
      kill.mockReset();
      expect(yield* restart().pipe(Effect.provideService(HostProcess.Platform, platform))).toBe(
        false,
      );
      expect(kill).not.toHaveBeenCalled();
    }),
);
