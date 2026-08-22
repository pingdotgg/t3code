import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";

import * as Electron from "electron";

export interface ElectronTrayCreateInput {
  readonly iconPath: string;
  readonly tooltip: string;
  /**
   * Fired on both left and right click. The tray deliberately has no
   * persistent context menu: with one set, macOS opens it on mousedown and
   * never emits `click`, which would prevent building the menu from fresh
   * data at open time. Callers respond by popping a menu via `popUpMenu`.
   */
  readonly onClick: () => void;
}

const ElectronTrayOperation = Schema.Literals(["create", "pop-up-menu"]);

export class ElectronTrayOperationError extends Schema.TaggedErrorClass<ElectronTrayOperationError>()(
  "ElectronTrayOperationError",
  {
    operation: ElectronTrayOperation,
    platform: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Electron tray operation ${JSON.stringify(this.operation)} failed on ${this.platform}.`;
  }
}

export class ElectronTray extends Context.Service<
  ElectronTray,
  {
    readonly create: (
      input: ElectronTrayCreateInput,
    ) => Effect.Effect<void, ElectronTrayOperationError, Scope.Scope>;
    readonly popUpMenu: (
      template: readonly Electron.MenuItemConstructorOptions[],
    ) => Effect.Effect<void>;
  }
>()("@t3tools/desktop/electron/ElectronTray") {}

export const make = Effect.gen(function* () {
  const platform = yield* HostProcessPlatform;
  // The single live tray instance; Electron's Tray must be kept referenced
  // or GC destroys the menu bar item silently.
  let currentTray: Electron.Tray | null = null;

  return ElectronTray.of({
    create: (input) =>
      Effect.acquireRelease(
        Effect.try({
          try: () => {
            const icon = Electron.nativeImage.createFromPath(input.iconPath);
            // The `Template` filename suffix already marks the image, but the
            // explicit call keeps the behavior when the asset gets renamed.
            icon.setTemplateImage(true);
            const tray = new Electron.Tray(icon);
            tray.setToolTip(input.tooltip);
            tray.on("click", input.onClick);
            tray.on("right-click", input.onClick);
            return tray;
          },
          catch: (cause) =>
            new ElectronTrayOperationError({ operation: "create", platform, cause }),
        }).pipe(Effect.tap((tray) => Effect.sync(() => (currentTray = tray)))),
        (tray) =>
          Effect.sync(() => {
            if (currentTray === tray) {
              currentTray = null;
            }
            tray.destroy();
          }),
      ).pipe(Effect.asVoid),
    popUpMenu: (template) =>
      Effect.try({
        try: () => {
          if (currentTray === null || currentTray.isDestroyed()) {
            return;
          }
          currentTray.popUpContextMenu(Electron.Menu.buildFromTemplate([...template]));
        },
        catch: (cause) =>
          new ElectronTrayOperationError({ operation: "pop-up-menu", platform, cause }),
      }).pipe(Effect.orDie),
  });
});

export const layer = Layer.effect(ElectronTray, make);
