import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as DesktopEnvironment from "../../main/DesktopEnvironment.ts";
import * as DesktopBackendManager from "../../main/DesktopBackendManager.ts";
import * as ElectronDialog from "../../electron/ElectronDialog.ts";
import * as ElectronMenu from "../../electron/ElectronMenu.ts";
import * as ElectronShell from "../../electron/ElectronShell.ts";
import * as ElectronTheme from "../../electron/ElectronTheme.ts";
import * as ElectronWindow from "../../electron/ElectronWindow.ts";
import * as DesktopWindowIpc from "./window.ts";

function toWebSocketBaseUrl(httpBaseUrl: URL): string {
  const url = new URL(httpBaseUrl.href);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.href;
}

export const layer = Layer.effect(
  DesktopWindowIpc.DesktopWindowIpcActions,
  Effect.gen(function* () {
    const environment = yield* DesktopEnvironment.DesktopEnvironment;
    const backendManager = yield* DesktopBackendManager.DesktopBackendManager;
    const electronDialog = yield* ElectronDialog.ElectronDialog;
    const electronMenu = yield* ElectronMenu.ElectronMenu;
    const electronShell = yield* ElectronShell.ElectronShell;
    const electronTheme = yield* ElectronTheme.ElectronTheme;
    const electronWindow = yield* ElectronWindow.ElectronWindow;

    return DesktopWindowIpc.DesktopWindowIpcActions.of({
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
  }),
);
