import type { ContextMenuItem } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as Electron from "electron";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";

export interface ElectronMenuPosition {
  readonly x: number;
  readonly y: number;
}

export interface ElectronMenuContextInput {
  readonly window: Electron.BrowserWindow;
  readonly items: readonly ContextMenuItem[];
  readonly position: Option.Option<ElectronMenuPosition>;
}

export interface ElectronMenuTemplateInput {
  readonly window: Electron.BrowserWindow;
  readonly template: readonly Electron.MenuItemConstructorOptions[];
}

export interface ElectronMenuShape {
  readonly setApplicationMenu: (
    template: readonly Electron.MenuItemConstructorOptions[],
  ) => Effect.Effect<void>;
  readonly showContextMenu: (
    input: ElectronMenuContextInput,
  ) => Effect.Effect<Option.Option<string>>;
  readonly popupTemplate: (input: ElectronMenuTemplateInput) => Effect.Effect<void>;
}

export class ElectronMenu extends Context.Service<ElectronMenu, ElectronMenuShape>()(
  "@t3tools/desktop/electron/ElectronMenu",
) {}

function normalizeContextMenuItems(source: readonly ContextMenuItem[]): ContextMenuItem[] {
  const normalizedItems: ContextMenuItem[] = [];

  for (const sourceItem of source) {
    if (typeof sourceItem.id !== "string" || typeof sourceItem.label !== "string") {
      continue;
    }

    // Header items are decorative section labels for the web fallback only —
    // Electron's native menu has no equivalent affordance, so we skip them.
    if (sourceItem.header === true) {
      continue;
    }

    const normalizedItem: ContextMenuItem = {
      id: sourceItem.id,
      label: sourceItem.label,
      destructive: sourceItem.destructive === true,
      disabled: sourceItem.disabled === true,
    };

    if (sourceItem.children) {
      const normalizedChildren = normalizeContextMenuItems(sourceItem.children);
      if (normalizedChildren.length === 0) {
        continue;
      }
      normalizedItem.children = normalizedChildren;
    }

    normalizedItems.push(normalizedItem);
  }

  return normalizedItems;
}

const normalizePosition = (
  position: Option.Option<ElectronMenuPosition>,
): Option.Option<ElectronMenuPosition> =>
  Option.filter(
    position,
    ({ x, y }) => Number.isFinite(x) && Number.isFinite(y) && x >= 0 && y >= 0,
  ).pipe(Option.map(({ x, y }) => ({ x: Math.floor(x), y: Math.floor(y) })));

// The renderer reports the click in CSS pixels (clientX/clientY). Electron's
// `menu.popup` wants window-relative DIP, and under webFrame page zoom a CSS point
// (x, y) maps to DIP (x * zoom, y * zoom). So scale by the live zoom factor;
// at 100% zoom (Ctrl+0) the factor is 1 and the position is unchanged.
const readWindowZoomFactor = (window: Electron.BrowserWindow): number => {
  try {
    const zoomFactor = window.webContents.getZoomFactor();
    return Number.isFinite(zoomFactor) && zoomFactor > 0 ? zoomFactor : 1;
  } catch {
    return 1;
  }
};

const scaleByZoom = (value: number, zoomFactor: number): number => Math.round(value * zoomFactor);

export const layer = Layer.effect(
  ElectronMenu,
  Effect.gen(function* () {
    const platform = yield* HostProcessPlatform;
    let destructiveMenuIconCache: Option.Option<Electron.NativeImage> | undefined;

    const getDestructiveMenuIcon = (): Option.Option<Electron.NativeImage> => {
      if (platform !== "darwin") {
        return Option.none();
      }
      if (destructiveMenuIconCache !== undefined) {
        return destructiveMenuIconCache;
      }

      try {
        const icon = Electron.nativeImage.createFromNamedImage("trash").resize({
          width: 12,
          height: 12,
        });
        icon.setTemplateImage(true);
        destructiveMenuIconCache = icon.isEmpty() ? Option.none() : Option.some(icon);
      } catch {
        destructiveMenuIconCache = Option.none();
      }

      return destructiveMenuIconCache;
    };

    const buildTemplate = (
      entries: readonly ContextMenuItem[],
      complete: (selectedItemId: Option.Option<string>) => void,
    ): Electron.MenuItemConstructorOptions[] => {
      const template: Electron.MenuItemConstructorOptions[] = [];
      let hasInsertedDestructiveSeparator = false;

      for (const item of entries) {
        if (item.destructive && !hasInsertedDestructiveSeparator && template.length > 0) {
          template.push({ type: "separator" });
          hasInsertedDestructiveSeparator = true;
        }

        const itemOption: Electron.MenuItemConstructorOptions = {
          label: item.label,
          enabled: !item.disabled,
        };
        if (item.children && item.children.length > 0) {
          itemOption.submenu = buildTemplate(item.children, complete);
        } else {
          itemOption.click = () => complete(Option.some(item.id));
        }
        if (item.destructive && (!item.children || item.children.length === 0)) {
          const destructiveIcon = getDestructiveMenuIcon();
          if (Option.isSome(destructiveIcon)) {
            itemOption.icon = destructiveIcon.value;
          }
        }

        template.push(itemOption);
      }

      return template;
    };

    return ElectronMenu.of({
      setApplicationMenu: (template) =>
        Effect.sync(() => {
          Electron.Menu.setApplicationMenu(Electron.Menu.buildFromTemplate([...template]));
        }),
      popupTemplate: (input) =>
        Effect.sync(() => {
          if (input.template.length === 0) {
            return;
          }
          Electron.Menu.buildFromTemplate([...input.template]).popup({ window: input.window });
        }),
      showContextMenu: (input) =>
        Effect.callback<Option.Option<string>>((resume) => {
          const normalizedItems = normalizeContextMenuItems(input.items);
          if (normalizedItems.length === 0) {
            resume(Effect.succeed(Option.none()));
            return;
          }

          let completed = false;
          const complete = (selectedItemId: Option.Option<string>) => {
            if (completed) {
              return;
            }
            completed = true;
            resume(Effect.succeed(selectedItemId));
          };

          const menu = Electron.Menu.buildFromTemplate(buildTemplate(normalizedItems, complete));
          const popupPosition = normalizePosition(input.position);
          const zoomFactor = readWindowZoomFactor(input.window);
          const popupOptions = Option.match(popupPosition, {
            onNone: (): Electron.PopupOptions => ({
              window: input.window,
              callback: () => complete(Option.none()),
            }),
            onSome: (position): Electron.PopupOptions => ({
              window: input.window,
              x: scaleByZoom(position.x, zoomFactor),
              y: scaleByZoom(position.y, zoomFactor),
              callback: () => complete(Option.none()),
            }),
          });
          menu.popup(popupOptions);
        }),
    });
  }),
);
