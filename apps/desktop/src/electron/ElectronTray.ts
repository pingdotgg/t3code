import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as Electron from "electron";

export class ElectronTray extends Context.Service<
  ElectronTray,
  {
    readonly create: (input: {
      readonly icon: string;
      readonly name: string;
      readonly open: () => void;
      readonly quit: () => void;
    }) => Effect.Effect<boolean, never, Scope.Scope>;
  }
>()("@t3tools/desktop/electron/ElectronTray") {}

export const layer = Layer.succeed(ElectronTray, {
  create: Effect.fn("ElectronTray.create")((input) =>
    Effect.acquireRelease(
      Effect.sync(() => {
        let tray: Electron.Tray | undefined;
        try {
          tray = new Electron.Tray(input.icon);
          tray.setToolTip(`${input.name}: running in the background`);
          tray.setContextMenu(
            Electron.Menu.buildFromTemplate([
              { label: `Open ${input.name}`, click: input.open },
              { type: "separator" },
              { label: `Quit ${input.name}`, click: input.quit },
            ]),
          );
          tray.on("double-click", input.open);
          return tray;
        } catch {
          tray?.destroy();
          return undefined;
        }
      }),
      (tray) => Effect.sync(() => tray?.destroy()),
    ).pipe(Effect.map((tray) => tray !== undefined)),
  ),
});
