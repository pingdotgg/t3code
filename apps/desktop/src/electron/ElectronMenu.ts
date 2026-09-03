import type { ContextMenuEditFlags, ContextMenuItem } from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as Electron from "electron";

const GITHUB_MARK_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAABgAAAAYCAYAAADgdz34AAAAAXNSR0IArs4c6QAAADhlWElmTU0AKgAAAAgAAYdpAAQAAAABAAAAGgAAAAAAAqACAAQAAAABAAAAGKADAAQAAAABAAAAGAAAAADB/VeXAAACD0lEQVRIDZWVP2tUQRRHX1TEgDbBFTSS1ToI6gewEGsVISqInQRsghLE2m9gZSN2/vsAKhhBthCxNgg2FqYIERWJlibqOTGz3FzX3TcXznv3ztz7m9mZebNjzXDr0n0RTsI0dED7DO/gJTyGj1BlU2Q/gnX4PQJzzLWmlZ0m6weMEs791lg71Obo/QW5uG1srRoD7QytRXwN/ye0FTa35Kvxzy/p0hiX5TbxLnCD34MDfYJFeAvLYNsHuAzjcAvKhNSagr65SaXT92y/p2l24u8PcXH34Shc7AJO1FBzww7xzKdl/m9X1fMK2XEANbvbeLgMvqNVn2uKl6IAftFuFgjiyK9SYk34NGk9dxS/0GjPYlDpO0C0aQfYG1vwv6S4JvyakjsO4JmPNhGDSj/XrjlAnvHxStGYfiwGRTtvjB9JJyW2CfeQ5C0bD8wTf0EPou0muAvbY+MIf4z+O5D3s2fdJJR75DX+EjiLN3AKnMT/TOET0IM4c301D8CGPeBpo8vlLF5sxrZ9gxuQ7SoNnposXOL7scBf8X0z+R5v98CLzWQ/+aOQ7TANRSy/1erPvhSex/GqVfAIuAfxb5Jwi7k85mZxNWa2ZIbgGr4JK3ATvNcvgWKDLA9g7fVBibHN0VchzmxHTAi+giXPZfHKbmWun5vkSVDA/4RB5gDmPAT3sdosOjek6ix9B4f0N38AdIrKZCnytp4AAAAASUVORK5CYII=";

export interface ElectronMenuPosition {
  readonly x: number;
  readonly y: number;
}

export interface ElectronMenuContextInput {
  readonly window: Electron.BrowserWindow;
  readonly items: readonly ContextMenuItem[];
  readonly position: Option.Option<ElectronMenuPosition>;
  readonly editFlags?: ContextMenuEditFlags;
}

export interface ElectronMenuTemplateInput {
  readonly window: Electron.BrowserWindow;
  readonly template: readonly Electron.MenuItemConstructorOptions[];
}

const ElectronMenuOperation = Schema.Literals([
  "set-application-menu",
  "popup-template",
  "show-context-menu",
]);

export class ElectronMenuOperationError extends Schema.TaggedErrorClass<ElectronMenuOperationError>()(
  "ElectronMenuOperationError",
  {
    operation: ElectronMenuOperation,
    platform: Schema.String,
    windowId: Schema.NullOr(Schema.Number),
    itemCount: Schema.Number,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    const window = this.windowId === null ? "" : ` for window ${this.windowId}`;
    return `Electron menu operation ${JSON.stringify(this.operation)} failed${window} with ${this.itemCount} items on ${this.platform}.`;
  }
}

export class ElectronMenu extends Context.Service<
  ElectronMenu,
  {
    readonly setApplicationMenu: (
      template: readonly Electron.MenuItemConstructorOptions[],
    ) => Effect.Effect<void>;
    readonly showContextMenu: (
      input: ElectronMenuContextInput,
    ) => Effect.Effect<Option.Option<string>>;
    readonly popupTemplate: (input: ElectronMenuTemplateInput) => Effect.Effect<void>;
  }
>()("@t3tools/desktop/electron/ElectronMenu") {}

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
      ...(sourceItem.separatorBefore === true ? { separatorBefore: true } : {}),
      ...(sourceItem.icon === undefined ? {} : { icon: sourceItem.icon }),
      ...(sourceItem.accelerator === undefined ? {} : { accelerator: sourceItem.accelerator }),
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

export function buildEditContextMenuTemplate(
  flags: ContextMenuEditFlags,
): Electron.MenuItemConstructorOptions[] {
  return [
    { role: "cut", enabled: flags.canCut },
    { role: "copy", enabled: flags.canCopy },
    { role: "paste", enabled: flags.canPaste },
    { role: "selectAll", enabled: flags.canSelectAll },
  ];
}

// Renderer positions arrive in CSS pixels; popup() expects window points, so
// page zoom must be factored in or menus drift proportionally to their
// distance from the window origin.
const normalizePosition = (
  position: Option.Option<ElectronMenuPosition>,
  zoomFactor: number,
): Option.Option<ElectronMenuPosition> =>
  Option.filter(
    position,
    ({ x, y }) =>
      Number.isFinite(x) && Number.isFinite(y) && x >= 0 && y >= 0 && Number.isFinite(zoomFactor),
  ).pipe(
    Option.map(({ x, y }) => ({ x: Math.floor(x * zoomFactor), y: Math.floor(y * zoomFactor) })),
  );

export const make = Effect.gen(function* () {
  const platform = yield* HostProcessPlatform;
  let destructiveMenuIconCache: Option.Option<Electron.NativeImage> | undefined;
  let gitHubMenuIconCache: Option.Option<Electron.NativeImage> | undefined;

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

  const getGitHubMenuIcon = (): Option.Option<Electron.NativeImage> => {
    if (platform !== "darwin") return Option.none();
    if (gitHubMenuIconCache !== undefined) return gitHubMenuIconCache;

    try {
      const icon = Electron.nativeImage.createFromBuffer(
        Buffer.from(GITHUB_MARK_PNG_BASE64, "base64"),
        { scaleFactor: 2 },
      );
      icon.setTemplateImage(true);
      gitHubMenuIconCache = icon.isEmpty() ? Option.none() : Option.some(icon);
    } catch {
      gitHubMenuIconCache = Option.none();
    }

    return gitHubMenuIconCache;
  };

  const buildTemplate = (
    entries: readonly ContextMenuItem[],
    complete: (selectedItemId: Option.Option<string>) => void,
  ): Electron.MenuItemConstructorOptions[] => {
    const template: Electron.MenuItemConstructorOptions[] = [];
    let hasInsertedDestructiveSeparator = false;
    let sectionStartedByExplicitSeparator = false;
    const appendSeparator = () => {
      if (template.length === 0 || template.at(-1)?.type === "separator") return;
      template.push({ type: "separator" });
    };

    for (const item of entries) {
      if (item.separatorBefore) {
        appendSeparator();
        sectionStartedByExplicitSeparator = true;
      }
      if (
        item.destructive &&
        !hasInsertedDestructiveSeparator &&
        !sectionStartedByExplicitSeparator &&
        template.length > 0
      ) {
        appendSeparator();
        hasInsertedDestructiveSeparator = true;
      }

      const itemOption: Electron.MenuItemConstructorOptions = {
        label: item.label,
        enabled: !item.disabled,
        ...(item.accelerator === undefined ? {} : { accelerator: item.accelerator }),
      };
      if (item.children && item.children.length > 0) {
        itemOption.submenu = buildTemplate(item.children, complete);
      } else {
        itemOption.click = () => complete(Option.some(item.id));
      }
      if (item.icon === "github") {
        const gitHubIcon = getGitHubMenuIcon();
        if (Option.isSome(gitHubIcon)) itemOption.icon = gitHubIcon.value;
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
      Effect.try({
        try: () => {
          Electron.Menu.setApplicationMenu(Electron.Menu.buildFromTemplate([...template]));
        },
        catch: (cause) =>
          new ElectronMenuOperationError({
            operation: "set-application-menu",
            platform,
            windowId: null,
            itemCount: template.length,
            cause,
          }),
      }).pipe(Effect.orDie),
    popupTemplate: (input) =>
      input.template.length === 0
        ? Effect.void
        : Effect.try({
            try: () =>
              Electron.Menu.buildFromTemplate([...input.template]).popup({
                window: input.window,
              }),
            catch: (cause) =>
              new ElectronMenuOperationError({
                operation: "popup-template",
                platform,
                windowId: input.window.id,
                itemCount: input.template.length,
                cause,
              }),
          }).pipe(Effect.orDie),
    showContextMenu: (input) =>
      Effect.callback<Option.Option<string>>((resume) => {
        const normalizedItems = normalizeContextMenuItems(input.items);
        if (normalizedItems.length === 0 && input.editFlags === undefined) {
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

        try {
          const template =
            input.editFlags === undefined ? [] : buildEditContextMenuTemplate(input.editFlags);
          template.push(...buildTemplate(normalizedItems, complete));
          const menu = Electron.Menu.buildFromTemplate(template);
          const popupPosition = normalizePosition(
            input.position,
            input.window.webContents.getZoomFactor(),
          );
          const popupOptions = Option.match(popupPosition, {
            onNone: (): Electron.PopupOptions => ({
              window: input.window,
              callback: () => complete(Option.none()),
            }),
            onSome: (position): Electron.PopupOptions => ({
              window: input.window,
              x: position.x,
              y: position.y,
              callback: () => complete(Option.none()),
            }),
          });
          menu.popup(popupOptions);
        } catch (cause) {
          if (completed) {
            return;
          }
          completed = true;
          resume(
            Effect.die(
              new ElectronMenuOperationError({
                operation: "show-context-menu",
                platform,
                windowId: input.window.id,
                itemCount: normalizedItems.length,
                cause,
              }),
            ),
          );
        }
      }),
  });
});

export const layer = Layer.effect(ElectronMenu, make);
