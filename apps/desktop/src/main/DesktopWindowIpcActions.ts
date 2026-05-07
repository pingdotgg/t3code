import type {
  ContextMenuItem,
  DesktopAppBranding,
  DesktopEnvironmentBootstrap,
  DesktopTheme,
  PickFolderOptions,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ElectronDialog from "../electron/ElectronDialog.ts";
import * as ElectronMenu from "../electron/ElectronMenu.ts";
import * as ElectronShell from "../electron/ElectronShell.ts";
import * as ElectronTheme from "../electron/ElectronTheme.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import * as DesktopBackendManager from "./DesktopBackendManager.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";

export interface DesktopWindowIpcContextMenuInput {
  readonly items: readonly ContextMenuItem[];
  readonly position?: {
    readonly x: number;
    readonly y: number;
  };
}

export interface DesktopWindowIpcActionsShape {
  readonly getAppBranding: Effect.Effect<DesktopAppBranding | null>;
  readonly getLocalEnvironmentBootstrap: Effect.Effect<DesktopEnvironmentBootstrap | null>;
  readonly pickFolder: (options: PickFolderOptions | undefined) => Effect.Effect<string | null>;
  readonly confirm: (message: string) => Effect.Effect<boolean>;
  readonly setTheme: (theme: DesktopTheme) => Effect.Effect<void>;
  readonly showContextMenu: (
    input: DesktopWindowIpcContextMenuInput,
  ) => Effect.Effect<string | null>;
  readonly openExternal: (url: string) => Effect.Effect<boolean>;
}

export class DesktopWindowIpcActions extends Context.Service<
  DesktopWindowIpcActions,
  DesktopWindowIpcActionsShape
>()("t3/desktop/WindowIpcActions") {}

function toWebSocketBaseUrl(httpBaseUrl: URL): string {
  const url = new URL(httpBaseUrl.href);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.href;
}

const make = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const backendManager = yield* DesktopBackendManager.DesktopBackendManager;
  const electronDialog = yield* ElectronDialog.ElectronDialog;
  const electronMenu = yield* ElectronMenu.ElectronMenu;
  const electronShell = yield* ElectronShell.ElectronShell;
  const electronTheme = yield* ElectronTheme.ElectronTheme;
  const electronWindow = yield* ElectronWindow.ElectronWindow;

  return DesktopWindowIpcActions.of({
    getAppBranding: Effect.succeed(environment.branding),
    getLocalEnvironmentBootstrap: backendManager.currentConfig.pipe(
      Effect.map(
        Option.map((config) => {
          const bootstrap = config.bootstrap;
          return {
            label: "Local environment",
            httpBaseUrl: config.httpBaseUrl.href,
            wsBaseUrl: toWebSocketBaseUrl(config.httpBaseUrl),
            ...(bootstrap.desktopBootstrapToken
              ? { bootstrapToken: bootstrap.desktopBootstrapToken }
              : {}),
          };
        }),
      ),
      Effect.map(Option.getOrNull),
    ),
    pickFolder: (options) =>
      Effect.gen(function* () {
        const selectedPath = yield* electronDialog.pickFolder({
          owner: yield* electronWindow.focusedMainOrFirst,
          defaultPath: environment.resolvePickFolderDefaultPath(options),
        });
        return Option.getOrNull(selectedPath);
      }),
    confirm: (message) =>
      Effect.gen(function* () {
        return yield* electronDialog.confirm({
          owner: yield* electronWindow.focusedMainOrFirst,
          message,
        });
      }),
    setTheme: (theme) => electronTheme.setSource(theme),
    showContextMenu: ({ items, position }) =>
      Effect.gen(function* () {
        const window = yield* electronWindow.focusedMainOrFirst;
        if (Option.isNone(window)) {
          return null;
        }

        const selectedItemId = yield* electronMenu.showContextMenu({
          window: window.value,
          items,
          position: Option.fromNullishOr(position),
        });
        return Option.getOrNull(selectedItemId);
      }),
    openExternal: (url) => electronShell.openExternal(url),
  });
});

export const layer = Layer.effect(DesktopWindowIpcActions, make);
