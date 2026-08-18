import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ElectronApp from "../electron/ElectronApp.ts";
import * as DesktopWindow from "../window/DesktopWindow.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";
import * as DesktopDeepLinkRouter from "./DesktopDeepLinkRouter.ts";
import * as DesktopPreReadyPlatform from "./DesktopPreReadyPlatform.ts";

function makeRouterLayer(input: {
  readonly listeners: Map<string, (...args: Array<unknown>) => void>;
  readonly openedThreads: Array<{ readonly environmentId: string; readonly threadId: string }>;
  readonly earlyOpenUrls?: DesktopPreReadyPlatform.EarlyOpenUrlBuffer;
}) {
  const electronApp = {
    on: (eventName: string, listener: (...args: Array<unknown>) => void) =>
      Effect.sync(() => {
        input.listeners.set(eventName, listener);
      }),
  } as unknown as ElectronApp.ElectronApp["Service"];
  const desktopWindow = {
    openThread: (thread: { readonly environmentId: string; readonly threadId: string }) =>
      Effect.sync(() => {
        input.openedThreads.push(thread);
      }),
  } as unknown as DesktopWindow.DesktopWindow["Service"];
  const environment = {
    isDevelopment: false,
  } as DesktopEnvironment.DesktopEnvironment["Service"];

  return DesktopDeepLinkRouter.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(ElectronApp.ElectronApp, electronApp),
        Layer.succeed(DesktopEnvironment.DesktopEnvironment, environment),
        Layer.succeed(DesktopWindow.DesktopWindow, desktopWindow),
        Layer.succeed(
          DesktopPreReadyPlatform.DesktopPreReadyOpenUrls,
          input.earlyOpenUrls ?? {
            setHandler: () => {},
          },
        ),
      ),
    ),
  );
}

describe("DesktopDeepLinkRouter", () => {
  it.effect("opens a thread link passed when the desktop app starts", () =>
    Effect.gen(function* () {
      const listeners = new Map<string, (...args: Array<unknown>) => void>();
      const openedThreads: Array<{ readonly environmentId: string; readonly threadId: string }> =
        [];
      const layer = makeRouterLayer({ listeners, openedThreads });
      const originalArgv = process.argv;
      process.argv = ["T3 Code", "t3code://app/#/environment-123/thread-456"];

      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          process.argv = originalArgv;
        }),
      );

      yield* Effect.scoped(
        Effect.gen(function* () {
          const router = yield* DesktopDeepLinkRouter.DesktopDeepLinkRouter;
          yield* router.configure;
          yield* Effect.promise(() => Promise.resolve());
          assert.deepEqual(openedThreads, [
            { environmentId: "environment-123", threadId: "thread-456" },
          ]);
        }),
      ).pipe(Effect.provide(layer));
    }),
  );

  it.effect("forwards a second-instance thread link to the desktop window", () =>
    Effect.gen(function* () {
      const listeners = new Map<string, (...args: Array<unknown>) => void>();
      const openedThreads: Array<{ readonly environmentId: string; readonly threadId: string }> =
        [];
      const layer = makeRouterLayer({ listeners, openedThreads });

      yield* Effect.scoped(
        Effect.gen(function* () {
          const router = yield* DesktopDeepLinkRouter.DesktopDeepLinkRouter;
          yield* router.configure;
          const secondInstance = listeners.get("second-instance");
          if (!secondInstance) {
            return yield* Effect.die("second-instance listener was not registered");
          }

          secondInstance({}, ["T3 Code", "t3code://app/#/environment-123/thread-456"]);
          yield* Effect.promise(() => Promise.resolve());
          assert.deepEqual(openedThreads, [
            { environmentId: "environment-123", threadId: "thread-456" },
          ]);
        }),
      ).pipe(Effect.provide(layer));
    }),
  );

  it.effect("forwards a macOS URL activation to the desktop window", () =>
    Effect.gen(function* () {
      let openUrlListener: ((event: unknown, url: string) => void) | undefined;
      const earlyOpenUrls = DesktopPreReadyPlatform.makeEarlyOpenUrlBuffer({
        platform: "darwin",
        electronApp: {
          on: (_eventName, listener) => {
            openUrlListener = listener;
          },
        },
      });
      const listeners = new Map<string, (...args: Array<unknown>) => void>();
      const openedThreads: Array<{ readonly environmentId: string; readonly threadId: string }> =
        [];
      const layer = makeRouterLayer({ listeners, openedThreads, earlyOpenUrls });

      yield* Effect.scoped(
        Effect.gen(function* () {
          const router = yield* DesktopDeepLinkRouter.DesktopDeepLinkRouter;
          yield* router.configure;
          if (!openUrlListener) {
            return yield* Effect.die("open-url listener was not registered");
          }

          openUrlListener({}, "t3code://app/#/environment-123/thread-456");
          yield* Effect.promise(() => Promise.resolve());
          assert.deepEqual(openedThreads, [
            { environmentId: "environment-123", threadId: "thread-456" },
          ]);
        }),
      ).pipe(Effect.provide(layer));
    }),
  );

  it.effect("routes a macOS URL captured before lifecycle registration", () =>
    Effect.gen(function* () {
      let openUrlListener: ((event: unknown, url: string) => void) | undefined;
      const earlyOpenUrls = DesktopPreReadyPlatform.makeEarlyOpenUrlBuffer({
        platform: "darwin",
        electronApp: {
          on: (_eventName, listener) => {
            openUrlListener = listener;
          },
        },
      });
      const listeners = new Map<string, (...args: Array<unknown>) => void>();
      const openedThreads: Array<{ readonly environmentId: string; readonly threadId: string }> =
        [];
      const layer = makeRouterLayer({ listeners, openedThreads, earlyOpenUrls });

      if (!openUrlListener) {
        return yield* Effect.die("open-url listener was not registered");
      }
      openUrlListener({}, "t3code://app/#/environment-123/thread-456");

      yield* Effect.scoped(
        Effect.gen(function* () {
          const router = yield* DesktopDeepLinkRouter.DesktopDeepLinkRouter;
          yield* router.configure;
          yield* Effect.promise(() => Promise.resolve());
          assert.deepEqual(openedThreads, [
            { environmentId: "environment-123", threadId: "thread-456" },
          ]);
        }),
      ).pipe(Effect.provide(layer));
    }),
  );
});
