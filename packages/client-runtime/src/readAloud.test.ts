import { expect, it, vi } from "vite-plus/test";
import { DEFAULT_READ_ALOUD_SETTINGS } from "@t3tools/contracts";
import { createReadAloudController, type SpeechPlayback } from "./readAloud.ts";

function deferred<A>() {
  let resolve: (value: A) => void = () => {};
  const promise = new Promise<A>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

it("stops obsolete requests before they can play and owns only the newest message", async () => {
  const old = deferred<SpeechPlayback>();
  const started = deferred<void>();
  const finished = deferred<void>();
  const stop = vi.fn();
  const obsoletePlay = vi.fn(async () => {});
  const prepare = vi.fn(async (text: string) =>
    text === "first"
      ? old.promise
      : {
          play: async () => {
            started.resolve();
          },
          pause: () => {},
          stop,
          finished: finished.promise,
        },
  );
  const controller = createReadAloudController(prepare);
  const settings = { ...DEFAULT_READ_ALOUD_SETTINGS, provider: "system" as const };
  const first = controller.start("1", "first", settings);
  const second = controller.start("2", "second", settings);
  await started.promise;
  old.resolve({ play: obsoletePlay, pause: () => {}, stop, finished: Promise.resolve() });
  await first;
  expect(obsoletePlay).not.toHaveBeenCalled();
  expect(controller.getSnapshot().id).toBe("2");
  finished.resolve();
  await second;
  expect(controller.getSnapshot().status).toBe("idle");
  expect(stop).toHaveBeenCalledTimes(2);
});

it("pauses without recursive audio-focus callbacks and ignores failures after cancellation", async () => {
  const started = deferred<void>();
  const finished = deferred<void>();
  let controller: ReturnType<typeof createReadAloudController>;
  const pause = vi.fn(() => controller.pause());
  controller = createReadAloudController(async () => ({
    play: async () => {
      started.resolve();
    },
    pause,
    stop: () => finished.resolve(),
    finished: finished.promise,
  }));
  const run = controller.start("1", "reply", {
    ...DEFAULT_READ_ALOUD_SETTINGS,
    provider: "system",
  });
  await started.promise;
  await controller.resume();
  controller.pause();
  expect(pause).toHaveBeenCalledTimes(1);
  expect(controller.getSnapshot().status).toBe("paused");
  controller.stop();
  await run;
  expect(controller.getSnapshot().status).toBe("idle");
});
