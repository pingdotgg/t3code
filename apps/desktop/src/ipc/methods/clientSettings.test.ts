import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";

import type * as Electron from "electron";

import * as DesktopEnvironment from "../../app/DesktopEnvironment.ts";
import * as ElectronApp from "../../electron/ElectronApp.ts";
import * as ElectronWindow from "../../electron/ElectronWindow.ts";
import * as DesktopClientSettings from "../../settings/DesktopClientSettings.ts";
import { setClientSettings } from "./clientSettings.ts";

describe("setClientSettings", () => {
  it.effect("serializes persistence and spellcheck synchronization", () =>
    Effect.gen(function* () {
      const firstSetStarted = yield* Deferred.make<void>();
      const releaseFirstSet = yield* Deferred.make<void>();
      const setCalls = yield* Ref.make<string[]>([]);
      let invocation = 0;

      const clientSettingsLayer = Layer.succeed(DesktopClientSettings.DesktopClientSettings, {
        get: Effect.succeed(Option.none()),
        set: (settings) =>
          Effect.gen(function* () {
            const index = invocation++;
            yield* Ref.update(setCalls, (calls) => [
              ...calls,
              settings.spellcheckLanguages.join(","),
            ]);
            if (index === 0) {
              yield* Deferred.succeed(firstSetStarted, undefined);
              yield* Deferred.await(releaseFirstSet);
            }
          }),
      });
      const window = {
        isDestroyed: () => false,
        webContents: {
          session: {
            availableSpellCheckerLanguages: ["en-US", "pt-BR"],
            getSpellCheckerLanguages: () => ["en-US"],
            setSpellCheckerEnabled: () => undefined,
            setSpellCheckerLanguages: () => undefined,
          },
        },
      } as unknown as Electron.BrowserWindow;
      const layer = Layer.mergeAll(
        NodeServices.layer,
        clientSettingsLayer,
        Layer.succeed(
          DesktopEnvironment.DesktopEnvironment,
          DesktopEnvironment.DesktopEnvironment.of({
            platform: "darwin",
          } as DesktopEnvironment.DesktopEnvironment["Service"]),
        ),
        Layer.mock(ElectronApp.ElectronApp)({}),
        Layer.mock(ElectronWindow.ElectronWindow)({
          currentMainOrFirst: Effect.succeed(Option.some(window)),
        }),
      );
      const firstSettings = {
        ...DEFAULT_CLIENT_SETTINGS,
        spellcheckLanguages: ["en-US"],
      };
      const secondSettings = {
        ...DEFAULT_CLIENT_SETTINGS,
        spellcheckLanguages: ["pt-BR"],
      };

      yield* Effect.gen(function* () {
        const firstFiber = yield* setClientSettings
          .handler(firstSettings)
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Deferred.await(firstSetStarted);
        const secondFiber = yield* setClientSettings
          .handler(secondSettings)
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Effect.yieldNow;
        assert.deepEqual(yield* Ref.get(setCalls), ["en-US"]);

        yield* Deferred.succeed(releaseFirstSet, undefined);
        yield* Fiber.join(firstFiber);
        yield* Fiber.join(secondFiber);
        assert.deepEqual(yield* Ref.get(setCalls), ["en-US", "pt-BR"]);
      }).pipe(Effect.provide(layer));
    }),
  );
});
