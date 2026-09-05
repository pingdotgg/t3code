import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";

import * as Electron from "electron";

export class ElectronTrayCreateError extends Schema.TaggedErrorClass<ElectronTrayCreateError>()(
  "ElectronTrayCreateError",
  {
    iconPath: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to create Electron Tray with icon "${this.iconPath}".`;
  }
}

export class ElectronTrayOperationError extends Schema.TaggedErrorClass<ElectronTrayOperationError>()(
  "ElectronTrayOperationError",
  {
    operation: Schema.String,
    platform: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Electron tray operation "${this.operation}" failed on ${this.platform}.`;
  }
}

export interface ElectronTrayMenuItem {
  readonly label?: string;
  readonly type?: "normal" | "separator" | "submenu" | "checkbox" | "radio";
  readonly click?: () => void;
  readonly enabled?: boolean;
}

export interface ElectronTrayCreateOptions {
  readonly iconPath: string;
  readonly tooltip?: string;
  readonly menuItems?: readonly ElectronTrayMenuItem[];
  readonly onClick?: () => void;
  readonly onDoubleClick?: () => void;
}

export class ElectronTray extends Context.Service<
  ElectronTray,
  {
    readonly create: (
      options: ElectronTrayCreateOptions,
    ) => Effect.Effect<Electron.Tray, ElectronTrayCreateError>;
    readonly destroy: Effect.Effect<void>;
  }
>()("@t3tools/desktop/electron/ElectronTray") {}

export const make = Effect.gen(function* () {
  const platform = yield* HostProcessPlatform;
  const currentTrayRef = yield* Ref.make<Option.Option<Electron.Tray>>(Option.none());

  const destroy = Effect.gen(function* () {
    const currentTray = yield* Ref.getAndSet(currentTrayRef, Option.none());
    if (Option.isSome(currentTray)) {
      yield* Effect.try({
        try: () => {
          if (!currentTray.value.isDestroyed()) {
            currentTray.value.destroy();
          }
        },
        catch: (cause) =>
          new ElectronTrayOperationError({
            operation: "destroy-tray",
            platform,
            cause,
          }),
      }).pipe(Effect.orDie);
    }
  });

  const create = (options: ElectronTrayCreateOptions) =>
    Effect.gen(function* () {
      yield* destroy;

      const tray = yield* Effect.try({
        try: () => {
          const icon = Electron.nativeImage.createFromPath(options.iconPath);
          const newTray = new Electron.Tray(icon.isEmpty() ? options.iconPath : icon);
          if (options.tooltip) {
            newTray.setToolTip(options.tooltip);
          }
          if (options.menuItems && options.menuItems.length > 0) {
            const template: Electron.MenuItemConstructorOptions[] = options.menuItems.map(
              (item) => {
                const menuItem: Electron.MenuItemConstructorOptions = {};
                if (item.label !== undefined) menuItem.label = item.label;
                if (item.type !== undefined) menuItem.type = item.type;
                if (item.click !== undefined) menuItem.click = item.click;
                if (item.enabled !== undefined) menuItem.enabled = item.enabled;
                return menuItem;
              },
            );
            const contextMenu = Electron.Menu.buildFromTemplate(template);
            newTray.setContextMenu(contextMenu);
          }
          if (options.onClick) {
            newTray.on("click", options.onClick);
          }
          if (options.onDoubleClick) {
            newTray.on("double-click", options.onDoubleClick);
          }
          return newTray;
        },
        catch: (cause) =>
          new ElectronTrayCreateError({
            iconPath: options.iconPath,
            cause,
          }),
      });

      yield* Ref.set(currentTrayRef, Option.some(tray));
      return tray;
    });

  return ElectronTray.of({
    create,
    destroy,
  });
});

export const layer = Layer.effect(ElectronTray, make);
