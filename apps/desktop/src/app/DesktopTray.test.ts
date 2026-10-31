import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as DesktopAssets from "./DesktopAssets.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";
import * as DesktopState from "./DesktopState.ts";
import * as DesktopTray from "./DesktopTray.ts";
import * as DesktopWindow from "../window/DesktopWindow.ts";
import * as ElectronApp from "../electron/ElectronApp.ts";
import * as ElectronTray from "../electron/ElectronTray.ts";

describe("DesktopTray", () => {
  it.effect.each([
    { platform: "win32", icon: true, native: true, enabled: true, creates: 1 },
    { platform: "win32", icon: false, native: true, enabled: false, creates: 0 },
    { platform: "win32", icon: true, native: false, enabled: false, creates: 2 },
    { platform: "darwin", icon: true, native: true, enabled: false, creates: 0 },
    { platform: "linux", icon: true, native: true, enabled: false, creates: 0 },
  ] as const)("keeps hosting only with a usable Windows tray: $platform/$icon/$native", (input) =>
    Effect.gen(function* () {
      let creates = 0;
      let releases = 0;
      let opens = 0;
      let quits = 0;
      let callbacks: Parameters<ElectronTray.ElectronTray["Service"]["create"]>[0] | undefined;
      const stateLayer = DesktopState.layer;
      const layer = DesktopTray.layer.pipe(
        Layer.provideMerge(
          Layer.mergeAll(
            stateLayer,
            Layer.succeed(DesktopEnvironment.DesktopEnvironment, {
              platform: input.platform,
              displayName: "T3 Code",
            } as DesktopEnvironment.DesktopEnvironment["Service"]),
            Layer.mock(DesktopAssets.DesktopAssets)({
              iconPaths: Effect.succeed({
                ico: input.icon ? Option.some("icon.ico") : Option.none(),
                png: Option.none(),
                icns: Option.none(),
              }),
            }),
            Layer.mock(DesktopWindow.DesktopWindow)({
              activate: Effect.sync(() => {
                opens += 1;
              }),
            }),
            Layer.mock(ElectronApp.ElectronApp)({
              quit: Effect.sync(() => {
                quits += 1;
              }),
            }),
            Layer.succeed(ElectronTray.ElectronTray, {
              create: (value) =>
                Effect.acquireRelease(
                  Effect.sync(() => {
                    creates += 1;
                    callbacks = value;
                    return input.native;
                  }),
                  (created) =>
                    Effect.sync(() => {
                      if (created) releases += 1;
                    }),
                ),
            }),
          ),
        ),
      );
      yield* Effect.scoped(
        Effect.gen(function* () {
          const tray = yield* DesktopTray.DesktopTray;
          yield* tray.configure;
          yield* tray.configure;
          assert.equal(yield* tray.keepsHostAlive, input.enabled);
          assert.equal(creates, input.creates);
          if (input.enabled) {
            callbacks!.open();
            assert.equal(opens, 1);
            yield* Ref.set((yield* DesktopState.DesktopState).quitting, true);
            callbacks!.open();
            assert.equal(opens, 1);
            callbacks!.quit();
            assert.equal(quits, 1);
          }
        }).pipe(Effect.provide(layer)),
      );
      assert.equal(releases, input.enabled ? 1 : 0);
    }),
  );
});
