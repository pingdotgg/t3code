import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as DesktopAssets from "./DesktopAssets.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";
import * as DesktopState from "./DesktopState.ts";
import * as DesktopWindow from "../window/DesktopWindow.ts";
import * as ElectronApp from "../electron/ElectronApp.ts";
import * as ElectronTray from "../electron/ElectronTray.ts";
import { makeComponentLogger } from "./DesktopObservability.ts";

export class DesktopTray extends Context.Service<
  DesktopTray,
  {
    readonly configure: Effect.Effect<void, never, Scope.Scope>;
    readonly keepsHostAlive: Effect.Effect<boolean>;
  }
>()("@t3tools/desktop/app/DesktopTray") {}

const { logWarning } = makeComponentLogger("desktop-tray");

export const layer = Layer.effect(
  DesktopTray,
  Effect.gen(function* () {
    const environment = yield* DesktopEnvironment.DesktopEnvironment;
    const assets = yield* DesktopAssets.DesktopAssets;
    const window = yield* DesktopWindow.DesktopWindow;
    const app = yield* ElectronApp.ElectronApp;
    const state = yield* DesktopState.DesktopState;
    const native = yield* ElectronTray.ElectronTray;
    const enabled = yield* Ref.make(false);
    const runFork = Effect.runForkWith(yield* Effect.context<never>());
    const open = Effect.gen(function* () {
      if (!(yield* Ref.get(state.quitting))) yield* window.activate;
    }).pipe(Effect.catchCause((cause) => logWarning("failed to open window", { cause })));

    return DesktopTray.of({
      keepsHostAlive: Ref.get(enabled),
      configure: Effect.gen(function* () {
        if (environment.platform !== "win32" || (yield* Ref.get(enabled))) return;
        const icon = (yield* assets.iconPaths).ico;
        if (Option.isNone(icon)) {
          yield* logWarning("tray icon unavailable; closing the last window will quit");
          return;
        }
        const created = yield* native.create({
          icon: icon.value,
          name: environment.displayName,
          open: () => {
            runFork(open);
          },
          quit: () => {
            runFork(app.quit);
          },
        });
        yield* Ref.set(enabled, created);
        if (!created) yield* logWarning("tray creation failed; closing the last window will quit");
      }),
    });
  }),
);
