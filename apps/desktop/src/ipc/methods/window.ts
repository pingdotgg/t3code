import {
  ContextMenuItemSchema,
  DesktopAppBrandingSchema,
  DesktopEnvironmentBootstrapSchema,
  DesktopThemeSchema,
  PickedThemeFileSchema,
  PickFolderOptionsSchema,
  PRIMARY_LOCAL_ENVIRONMENT_ID,
  type DesktopEnvironmentBootstrap,
  type PickedThemeFile,
} from "@t3tools/contracts";
import * as NodeOS from "node:os";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
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
  isSameWslDistro,
  isValidDistroName,
  parseWslUncPath,
  resolveWslPickFolderDefaultPath,
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

// Pull an explicit distro selection out of a backend instance id like
// "wsl:ubuntu". Returns null for "wsl:default": that sentinel must be
// resolved from the concrete running backend before any filesystem operation.
function extractWslDistroFromEnvironmentId(envId: string): string | null {
  if (!envId.startsWith(DesktopWslBackend.WSL_INSTANCE_ID_PREFIX)) {
    return null;
  }
  const suffix = envId.slice(DesktopWslBackend.WSL_INSTANCE_ID_PREFIX.length);
  if (suffix === "default" || suffix.length === 0) {
    return null;
  }
  return isValidDistroName(suffix) ? suffix : null;
}

const runningDistroFromInstance = Effect.fn("desktop.ipc.window.runningDistroFromInstance")(
  function* (instance: DesktopBackendPool.DesktopBackendInstance) {
    const config = yield* instance.currentConfig;
    if (Option.isNone(config)) {
      return null;
    }
    return config.value.runningDistro ?? null;
  },
);

// Resolve a WSL picker target to the concrete distro already backing that
// environment. This is deliberately runtime-first: a stable `wsl:default` id
// must not be re-resolved against the Windows system default after its backend
// has started, otherwise changing the default distro while the app is open can
// make the picker and backend point at different filesystems. In WSL-only mode
// the renderer still uses a synthetic `wsl:*` picker target while the actual
// backend lives in the pool's `primary` instance, so consult that primary too.
export const resolveWslPickerDistro = Effect.fn("desktop.ipc.window.resolveWslPickerDistro")(
  function* (input: {
    readonly targetEnvironmentId: string;
    readonly configuredDistro: string | null;
    readonly wslOnly: boolean;
  }) {
    const pool = yield* DesktopBackendPool.DesktopBackendPool;

    // In WSL-only mode the target id is synthetic and the real backend is the
    // primary instance. Prefer it even if a stale secondary still exists while
    // a relaunch-triggering settings change is winding the old process down.
    if (input.wslOnly) {
      const primary = yield* pool.primary;
      const runningDistro = yield* runningDistroFromInstance(primary);
      if (runningDistro !== null) {
        return runningDistro;
      }
    }

    const targetInstance = yield* pool.get(
      DesktopBackendPool.BackendInstanceId(input.targetEnvironmentId),
    );
    if (Option.isSome(targetInstance)) {
      const runningDistro = yield* runningDistroFromInstance(targetInstance.value);
      if (runningDistro !== null) {
        return runningDistro;
      }
    }

    return extractWslDistroFromEnvironmentId(input.targetEnvironmentId) ?? input.configuredDistro;
  },
);

export type WslPickerSelectionResolution =
  | { readonly _tag: "Success"; readonly linuxPath: string }
  | {
      readonly _tag: "CrossDistro";
      readonly selectedDistro: string;
      readonly targetDistro: string;
    }
  | { readonly _tag: "ConversionFailed"; readonly targetDistro: string };

export const resolveWslPickerSelection = Effect.fn("desktop.ipc.window.resolveWslPickerSelection")(
  function* (input: { readonly selectedPath: string; readonly targetDistro: string }) {
    const parsedUnc = parseWslUncPath(input.selectedPath);
    if (parsedUnc !== null) {
      if (!isSameWslDistro(parsedUnc.distro, input.targetDistro)) {
        return {
          _tag: "CrossDistro",
          selectedDistro: parsedUnc.distro,
          targetDistro: input.targetDistro,
        } as const;
      }
      return { _tag: "Success", linuxPath: parsedUnc.linuxPath } as const;
    }

    const wslEnvironment = yield* DesktopWslEnvironment.DesktopWslEnvironment;
    const converted = yield* wslEnvironment.windowsToWslPath(
      input.targetDistro,
      input.selectedPath,
    );
    if (Option.isNone(converted) || !converted.value.startsWith("/")) {
      return { _tag: "ConversionFailed", targetDistro: input.targetDistro } as const;
    }
    return { _tag: "Success", linuxPath: converted.value } as const;
  },
);

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
    const useWsl =
      targetId !== undefined &&
      targetId !== PRIMARY_LOCAL_ENVIRONMENT_ID &&
      targetId.startsWith(DesktopWslBackend.WSL_INSTANCE_ID_PREFIX);
    const settings = yield* appSettings.get;
    const wslDistro = useWsl
      ? yield* resolveWslPickerDistro({
          targetEnvironmentId: targetId,
          configuredDistro: settings.wslDistro,
          wslOnly: settings.wslOnly,
        })
      : null;

    // An environment-specific WSL picker is only safe when its concrete distro
    // is known. In particular, never silently re-resolve `wsl:default` here: if
    // no running identity exists, there is no trustworthy filesystem target.
    if (useWsl && wslDistro === null) {
      yield* dialog.showErrorBox(
        "WSL folder picker unavailable",
        "T3 Code could not determine which WSL distribution backs this environment. Start or reconnect the WSL backend, then choose the folder again.",
      );
      return null;
    }

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

    // `useWsl` implies wslDistro is concrete because of the guard above.
    const targetDistro = wslDistro!;
    const resolution = yield* resolveWslPickerSelection({
      selectedPath: selectedPath.value,
      targetDistro,
    });
    switch (resolution._tag) {
      case "Success":
        return resolution.linuxPath;
      case "CrossDistro":
        yield* dialog.showErrorBox(
          "Folder belongs to a different WSL distribution",
          `The selected folder belongs to ${resolution.selectedDistro}, but this environment is running in ${resolution.targetDistro}. Choose a folder from ${resolution.targetDistro} instead.`,
        );
        return null;
      case "ConversionFailed":
        yield* dialog.showErrorBox(
          "Could not convert folder path for WSL",
          `T3 Code could not convert the selected Windows path for ${resolution.targetDistro}. Choose a folder inside \\\\wsl.localhost\\${resolution.targetDistro} or verify that the distribution is running.`,
        );
        return null;
    }
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

/** Theme files are a few KB; anything larger returns empty text and lets the
 *  renderer reject it by size without the contents ever crossing the bridge. */
const PICKED_THEME_FILE_MAX_BYTES = 256 * 1024;

export const pickThemeFiles = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.PICK_THEME_FILES_CHANNEL,
  payload: Schema.Undefined,
  result: Schema.NullOr(Schema.Array(PickedThemeFileSchema)),
  handler: Effect.fn("desktop.ipc.window.pickThemeFiles")(function* () {
    const dialog = yield* ElectronDialog.ElectronDialog;
    const electronWindow = yield* ElectronWindow.ElectronWindow;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    // The VS Code extensions directory is the same dotfolder on Windows,
    // macOS, and Linux; when it is missing the picker opens wherever the
    // platform would by default.
    const extensionsDir = path.join(NodeOS.homedir(), ".vscode", "extensions");
    const defaultPath = yield* fileSystem
      .exists(extensionsDir)
      .pipe(Effect.orElseSucceed(() => false));
    const paths = yield* dialog.pickFiles({
      owner: yield* electronWindow.focusedMainOrFirst,
      defaultPath: defaultPath ? Option.some(extensionsDir) : Option.none(),
      filters: [{ name: "JSON", extensions: ["json"] }],
    });
    if (paths.length === 0) {
      return null;
    }
    return yield* Effect.forEach(paths, (filePath) => {
      const name = path.basename(filePath);
      return Effect.gen(function* () {
        const info = yield* fileSystem.stat(filePath);
        const size = Number(info.size);
        if (size > PICKED_THEME_FILE_MAX_BYTES) {
          return { name, size, text: "" } satisfies PickedThemeFile;
        }
        const text = yield* fileSystem.readFileString(filePath);
        return { name, size, text } satisfies PickedThemeFile;
      }).pipe(
        // An unreadable file degrades to an entry the renderer reports.
        Effect.orElseSucceed((): PickedThemeFile => ({ name, size: 0, text: "" })),
      );
    });
  }),
});
