import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";

import * as Electron from "electron";

import * as DesktopAssets from "../app/DesktopAssets.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import { makeComponentLogger } from "../app/DesktopObservability.ts";
import * as DesktopState from "../app/DesktopState.ts";
import * as ElectronApp from "../electron/ElectronApp.ts";
import * as DesktopWindow from "./DesktopWindow.ts";

export class DesktopTrayActionError extends Schema.TaggedErrorClass<DesktopTrayActionError>()(
  "DesktopTrayActionError",
  {
    action: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Windows tray action "${this.action}" failed.`;
  }
}

export class DesktopTrayConfigurationError extends Schema.TaggedErrorClass<DesktopTrayConfigurationError>()(
  "DesktopTrayConfigurationError",
  {
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return "Windows tray setup failed; close-to-background disabled.";
  }
}

export class DesktopTray extends Context.Service<
  DesktopTray,
  {
    readonly configure: Effect.Effect<void, never, Scope.Scope>;
  }
>()("@t3tools/desktop/window/DesktopTray") {}

const { logInfo: logTrayInfo, logWarning: logTrayWarning } = makeComponentLogger("desktop-tray");

export const make = Effect.gen(function* () {
  const assets = yield* DesktopAssets.DesktopAssets;
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const state = yield* DesktopState.DesktopState;
  const electronApp = yield* ElectronApp.ElectronApp;
  const desktopWindow = yield* DesktopWindow.DesktopWindow;
  const context = yield* Effect.context<ElectronApp.ElectronApp | DesktopWindow.DesktopWindow>();
  const runPromise = Effect.runPromiseWith(context);
  const runTrayEffect = <E>(
    action: string,
    effect: Effect.Effect<void, E, ElectronApp.ElectronApp | DesktopWindow.DesktopWindow>,
  ) => {
    return runPromise(
      effect.pipe(
        Effect.annotateLogs({ action }),
        Effect.withSpan("desktop.tray.action"),
        Effect.catchCause((cause) => {
          const error = new DesktopTrayActionError({ action, cause });
          return logTrayWarning(error.message, {
            errorTag: error._tag,
            action: error.action,
          });
        }),
      ),
    );
  };

  const configure = Effect.gen(function* () {
    if (environment.platform !== "win32") return;

    const iconPaths = yield* assets.iconPaths;
    if (Option.isNone(iconPaths.ico)) {
      yield* logTrayWarning("Windows tray icon is unavailable; close-to-background disabled");
      return;
    }
    const iconPath = iconPaths.ico.value;

    yield* Effect.acquireRelease(
      Effect.sync(() => {
        const open = () => {
          return runTrayEffect(
            "open",
            Effect.gen(function* () {
              if (yield* Ref.get(state.quitting)) return;
              yield* desktopWindow.activate;
            }),
          );
        };
        const quit = () => {
          return runTrayEffect("quit", electronApp.quit);
        };
        const tray = new Electron.Tray(iconPath);
        try {
          tray.setToolTip(environment.displayName);
          tray.setContextMenu(
            Electron.Menu.buildFromTemplate([
              { label: `Open ${environment.displayName}`, click: open },
              { type: "separator" },
              { label: `Quit ${environment.displayName}`, click: quit },
            ]),
          );
          tray.on("click", open);
          desktopWindow.setBackgroundModeEnabled(true);
          return tray;
        } catch (cause) {
          tray.destroy();
          throw cause;
        }
      }),
      (tray) =>
        Effect.sync(() => {
          desktopWindow.setBackgroundModeEnabled(false);
          tray.destroy();
        }),
    );
    yield* logTrayInfo("Windows tray configured");
  }).pipe(
    Effect.catchCause((cause) => {
      const error = new DesktopTrayConfigurationError({ cause });
      return logTrayWarning(error.message, { errorTag: error._tag });
    }),
    Effect.withSpan("desktop.tray.configure"),
  );

  return DesktopTray.of({ configure });
});

export const layer = Layer.effect(DesktopTray, make);
