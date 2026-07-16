import {
  ContextMenuItemSchema,
  DesktopAppBrandingSchema,
  DesktopEnvironmentBootstrapSchema,
  DesktopThemeSchema,
  PickFolderOptionsSchema,
  PRIMARY_LOCAL_ENVIRONMENT_ID,
  type DesktopEnvironmentBootstrap,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as DesktopBackendPool from "../../backend/DesktopBackendPool.ts";
import * as DesktopLocalEnvironmentAuth from "../../backend/DesktopLocalEnvironmentAuth.ts";
import * as DesktopEnvironment from "../../app/DesktopEnvironment.ts";
import * as DesktopAppSettings from "../../settings/DesktopAppSettings.ts";
import * as DesktopWslBackend from "../../wsl/DesktopWslBackend.ts";
import * as DesktopWslEnvironment from "../../wsl/DesktopWslEnvironment.ts";
import * as ElectronDialog from "../../electron/ElectronDialog.ts";
import * as ElectronMenu from "../../electron/ElectronMenu.ts";
import * as ElectronShell from "../../electron/ElectronShell.ts";
import * as ElectronTheme from "../../electron/ElectronTheme.ts";
import * as ElectronWindow from "../../electron/ElectronWindow.ts";
import * as IpcChannels from "../channels.ts";
import * as DesktopIpc from "../DesktopIpc.ts";
import {
  extractDistroFromUncPath,
  resolveWslPickFolderDefaultPath,
  wslUncPathToLinuxPath,
} from "../../wsl/wslPathParsing.ts";

const ContextMenuPosition = Schema.Struct({
  x: Schema.Number,
  y: Schema.Number,
});

const ContextMenuInput = Schema.Struct({
  items: Schema.Array(ContextMenuItemSchema),
  position: Schema.optionalKey(ContextMenuPosition),
});

function toWebSocketBaseUrl(httpBaseUrl: URL): string {
  const url = new URL(httpBaseUrl.href);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.href;
}

export const getAppBranding = DesktopIpc.makeSyncIpcMethod({
  channel: IpcChannels.GET_APP_BRANDING_CHANNEL,
  result: Schema.NullOr(DesktopAppBrandingSchema),
  handler: Effect.fn("desktop.ipc.window.getAppBranding")(function* () {
    const environment = yield* DesktopEnvironment.DesktopEnvironment;
    return environment.branding;
  }),
});

export const getWindowFullscreenState = DesktopIpc.makeSyncIpcMethod({
  channel: IpcChannels.GET_WINDOW_FULLSCREEN_STATE_CHANNEL,
  result: Schema.Boolean,
  handler: Effect.fn("desktop.ipc.window.getWindowFullscreenState")(function* () {
    const electronWindow = yield* ElectronWindow.ElectronWindow;
    const window = yield* electronWindow.currentMainOrFirst;
    return Option.isSome(window) && window.value.isFullScreen();
  }),
});

export const getLocalEnvironmentBootstraps = DesktopIpc.makeSyncIpcMethod({
  channel: IpcChannels.GET_LOCAL_ENVIRONMENT_BOOTSTRAPS_CHANNEL,
  result: Schema.Array(DesktopEnvironmentBootstrapSchema),
  handler: Effect.fn("desktop.ipc.window.getLocalEnvironmentBootstraps")(function* () {
    const pool = yield* DesktopBackendPool.DesktopBackendPool;
    const instances = yield* pool.list;
    const bootstraps: DesktopEnvironmentBootstrap[] = [];
    for (const instance of instances) {
      const isPrimary = instance.id === PRIMARY_LOCAL_ENVIRONMENT_ID;
      const config = yield* instance.currentConfig;
      const snapshot = yield* instance.snapshot;
      // A secondary backend (e.g. a parallel WSL backend) that hasn't produced
      // a config yet (mid-registration, before its first start cycle) or that
      // is retrying a *transient* preflight failure (WSL VM still booting, a
      // not-yet-built linux server entry) is not listening on a port. We
      // surface it as a *pending* bootstrap (null endpoints, no token) so the
      // renderer can show a "Connecting…" indicator while it retries — null
      // endpoints keep the renderer from dialing the dead port, avoiding the
      // needless /api/auth/bootstrap/bearer error cycles a real endpoint would
      // trigger.
      if (Option.isNone(config) || Option.isSome(config.value.preflightFailure)) {
        // Skip the primary (same-origin, no "connecting" affordance) and skip a
        // secondary whose preflight failed *fatally* (no node, wrong version,
        // missing build tools): it has stopped retrying, so an indefinite
        // "Connecting…" would be misleading — its error is surfaced by the
        // WSL-state UI instead.
        const fatalPreflight =
          Option.isSome(config) &&
          Option.isSome(config.value.preflightFailure) &&
          config.value.preflightFailure.value.fatal;
        const stoppedPreflight =
          Option.isSome(config) &&
          Option.isSome(config.value.preflightFailure) &&
          (!snapshot.desiredRunning || !snapshot.restartScheduled);
        if (isPrimary || fatalPreflight || stoppedPreflight) continue;
        bootstraps.push({
          id: instance.id,
          label: yield* instance.label,
          runningDistro: null,
          httpBaseUrl: null,
          wsBaseUrl: null,
        });
        continue;
      }
      const { bootstrap, httpBaseUrl } = config.value;
      const runningDistro = config.value.runningDistro ?? null;
      bootstraps.push({
        id: instance.id,
        label: runningDistro === null ? yield* instance.label : `WSL (${runningDistro})`,
        runningDistro,
        httpBaseUrl: httpBaseUrl.href,
        wsBaseUrl: toWebSocketBaseUrl(httpBaseUrl),
        ...(bootstrap.desktopBootstrapToken
          ? { bootstrapToken: bootstrap.desktopBootstrapToken }
          : {}),
      });
    }
    return bootstraps;
  }),
});

// Pull the distro selection out of a backend instance id like
// "wsl:ubuntu". Returns null for "wsl:default", which is the sentinel
// for "track the user's WSL default distro" and maps to the
// wslEnv-derived default at picker time.
function extractWslDistroFromEnvironmentId(envId: string): string | null {
  if (!envId.startsWith(DesktopWslBackend.WSL_INSTANCE_ID_PREFIX)) {
    return null;
  }
  const suffix = envId.slice(DesktopWslBackend.WSL_INSTANCE_ID_PREFIX.length);
  return suffix === "default" || suffix.length === 0 ? null : suffix;
}

export const getLocalEnvironmentBearerToken = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.GET_LOCAL_ENVIRONMENT_BEARER_TOKEN_CHANNEL,
  payload: Schema.Void,
  result: Schema.String,
  handler: Effect.fn("desktop.ipc.window.getLocalEnvironmentBearerToken")(function* () {
    const localAuth = yield* DesktopLocalEnvironmentAuth.DesktopLocalEnvironmentAuth;
    return yield* localAuth.getBearerToken;
  }),
});

export const pickFolder = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.PICK_FOLDER_CHANNEL,
  payload: Schema.UndefinedOr(PickFolderOptionsSchema),
  result: Schema.NullOr(Schema.String),
  handler: Effect.fn("desktop.ipc.window.pickFolder")(function* (options) {
    const dialog = yield* ElectronDialog.ElectronDialog;
    const electronWindow = yield* ElectronWindow.ElectronWindow;
    const environment = yield* DesktopEnvironment.DesktopEnvironment;
    const appSettings = yield* DesktopAppSettings.DesktopAppSettings;
    const wslEnvironment = yield* DesktopWslEnvironment.DesktopWslEnvironment;
    // Three picker modes:
    //   - targetEnvironmentId omitted: default to the primary picker. Keeps
    //     the historical behavior unchanged for users who never enabled the
    //     WSL backend, and is what unfamiliar callers should get out of the
    //     box.
    //   - targetEnvironmentId starts with "wsl:": route to the WSL picker
    //     using the distro encoded in the id (or the user's selected
    //     wslDistro when the id is the "wsl:default" sentinel).
    //   - anything else (incl. PRIMARY_LOCAL_ENVIRONMENT_ID): primary picker.
    const targetId = options?.targetEnvironmentId;
    const wslDistroFromTarget =
      targetId !== undefined && targetId.startsWith(DesktopWslBackend.WSL_INSTANCE_ID_PREFIX)
        ? extractWslDistroFromEnvironmentId(targetId)
        : null;
    const useWsl =
      targetId !== undefined &&
      targetId !== PRIMARY_LOCAL_ENVIRONMENT_ID &&
      targetId.startsWith(DesktopWslBackend.WSL_INSTANCE_ID_PREFIX);
    const settings = yield* appSettings.get;
    // Fall back to the persisted wslDistro when the id is the
    // "wsl:default" sentinel; the orchestrator uses the same fallback
    // for the actual backend.
    const wslDistro = useWsl ? (wslDistroFromTarget ?? settings.wslDistro) : null;
    const defaultPath = useWsl
      ? Option.fromNullishOr(
          resolveWslPickFolderDefaultPath(
            options,
            { distro: wslDistro },
            yield* wslEnvironment.listDistros,
            Option.getOrNull(yield* wslEnvironment.getUserHome(wslDistro)),
          ),
        )
      : environment.resolvePickFolderDefaultPath(options);
    const selectedPath = yield* dialog.pickFolder({
      owner: yield* electronWindow.focusedMainOrFirst,
      defaultPath,
    });
    if (Option.isNone(selectedPath)) {
      return null;
    }
    if (!useWsl) {
      return selectedPath.value;
    }

    const linuxUncPath = wslUncPathToLinuxPath(selectedPath.value);
    if (linuxUncPath !== null) {
      return linuxUncPath;
    }

    const converted = yield* wslEnvironment.windowsToWslPath(
      extractDistroFromUncPath(selectedPath.value) ?? wslDistro,
      selectedPath.value,
    );
    return Option.getOrElse(converted, () => selectedPath.value);
  }),
});

export const confirm = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.CONFIRM_CHANNEL,
  payload: Schema.String,
  result: Schema.Boolean,
  handler: Effect.fn("desktop.ipc.window.confirm")(function* (message) {
    const dialog = yield* ElectronDialog.ElectronDialog;
    const electronWindow = yield* ElectronWindow.ElectronWindow;
    return yield* electronWindow.focusedMainOrFirst.pipe(
      Effect.flatMap((owner) => dialog.confirm({ owner, message })),
    );
  }),
});

export const setTheme = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.SET_THEME_CHANNEL,
  payload: DesktopThemeSchema,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.window.setTheme")(function* (theme) {
    const electronTheme = yield* ElectronTheme.ElectronTheme;
    yield* electronTheme.setSource(theme);
  }),
});

export const showContextMenu = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.CONTEXT_MENU_CHANNEL,
  payload: ContextMenuInput,
  result: Schema.NullOr(Schema.String),
  handler: Effect.fn("desktop.ipc.window.showContextMenu")(function* (input) {
    const electronMenu = yield* ElectronMenu.ElectronMenu;
    const electronWindow = yield* ElectronWindow.ElectronWindow;
    const window = yield* electronWindow.focusedMainOrFirst;
    if (Option.isNone(window)) {
      return null;
    }

    const selectedItemId = yield* electronMenu.showContextMenu({
      window: window.value,
      items: input.items,
      position: Option.fromNullishOr(input.position),
    });
    return Option.getOrNull(selectedItemId);
  }),
});

export const openExternal = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.OPEN_EXTERNAL_CHANNEL,
  payload: Schema.String,
  result: Schema.Boolean,
  handler: Effect.fn("desktop.ipc.window.openExternal")(function* (url) {
    const shell = yield* ElectronShell.ElectronShell;
    return yield* shell.openExternal(url);
  }),
});
