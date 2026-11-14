import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import type * as Semaphore from "effect/Semaphore";

import * as Electron from "electron";

import type {
  ClientSettings,
  DesktopCaptureConfigApplied,
  DesktopCaptureConfigPreview,
  DesktopCaptureConfigRequest,
  DesktopSnapShotSetupAction,
  DesktopSnapShotState,
} from "@t3tools/contracts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as MacPermissions from "../permissions/MacPermissions.ts";
import { MAC_PERMISSION_SETTINGS_URLS } from "../permissions/MacPermission.ts";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { activeWindow } from "./ActiveWindow.ts";
import { captureMacWindowSnapshot } from "./MacSnapShot.ts";
import { CaptureShortcutConfig, niriCaptureConfigPath } from "./CaptureShortcutConfig.ts";
import { niriSocketPath } from "./NiriSnapShot.ts";
import { isGnomeCaptureSession } from "./linuxCaptureSession.ts";
import { HyprlandCaptureSetup, isHyprlandCaptureSession, hyprlandCaptureShortcut, type HyprlandCapturePaths } from "./HyprlandSnapShot.ts";
import { KdeCaptureSetup, isKdeCaptureSession, type KdeCapturePaths } from "./KdeSnapShot.ts";
import { DesktopSnapShotSetupError } from "./DesktopSnapShotContracts.ts";
import {
  captureMode,
  macCommandFailure,
  requestMacScreenCapturePermission,
  requestMacSnapShotPermissions,
  snapShotThumbnailSize,
} from "./DesktopSnapShotSupport.ts";
import type { SnapShotShortcuts } from "./DesktopSnapShotShortcuts.ts";

type ServiceShape<S> = S extends { readonly Service: infer Shape } ? Shape : never;

export interface SnapShotSetupDeps {
  readonly environment: ServiceShape<typeof DesktopEnvironment.DesktopEnvironment>;
  readonly permissions: ServiceShape<typeof MacPermissions.MacPermissions>;
  readonly fileSystem: ServiceShape<typeof FileSystem.FileSystem>;
  readonly path: ServiceShape<typeof Path.Path>;
  readonly configurationMutex: Semaphore.Semaphore;
  readonly settingsRef: Ref.Ref<ClientSettings>;
  readonly shortcutConfig: CaptureShortcutConfig;
  readonly home: string;
  readonly linuxAppId: string;
  readonly kdeCapturePaths: KdeCapturePaths;
  readonly hyprlandCapturePaths: HyprlandCapturePaths;
  readonly gnomeSetupPaths: { readonly bundle: string; readonly dataHome: string };
  readonly hasGnomeSetup: () => boolean;
  readonly shortcuts: SnapShotShortcuts;
}

export interface SnapShotSetupActions {
  readonly setup: (action: DesktopSnapShotSetupAction) => Effect.Effect<void, DesktopSnapShotSetupError>;
  readonly requestPermissions: (includeAccessibility: boolean) => Effect.Effect<void>;
  readonly previewConfig: (
    request: DesktopCaptureConfigRequest,
    selectedPath?: string,
  ) => Effect.Effect<DesktopCaptureConfigPreview, DesktopSnapShotSetupError>;
  readonly applyConfig: (
    previewId: string,
  ) => Effect.Effect<DesktopCaptureConfigApplied, DesktopSnapShotSetupError>;
}

export function makeSnapShotSetupActions(deps: SnapShotSetupDeps): SnapShotSetupActions {
const requestPermissions = Effect.fn("desktop.snapShot.requestPermissions")(function* (
  includeAccessibility: boolean,
) {
  if (deps.environment.platform !== "darwin") return;
  const owner = Electron.BrowserWindow.getFocusedWindow();
  yield* Effect.promise(() => requestMacSnapShotPermissions(includeAccessibility));
  if (Electron.systemPreferences.getMediaAccessStatus("screen") !== "granted") {
    yield* deps.permissions.showHelper("screen-recording", owner);
  } else if (
    includeAccessibility &&
    !Electron.systemPreferences.isTrustedAccessibilityClient(false)
  ) {
    yield* Effect.promise(() =>
      Electron.shell
        .openExternal(MAC_PERMISSION_SETTINGS_URLS.accessibility)
        .catch(() => undefined),
    );
    yield* deps.permissions.showHelper("accessibility", owner);
  }
}, deps.configurationMutex.withPermits(1));

const setup = Effect.fn("desktop.snapShot.setup")(function* (action: DesktopSnapShotSetupAction) {
  if (action === "test-mac-capture") {
    if (deps.environment.platform !== "darwin")
      return yield* new DesktopSnapShotSetupError({ action, reason: "unsupported-session" });
    yield* Effect.scoped(
      Effect.gen(function* () {
        const directory = yield* deps.fileSystem
          .makeTempDirectoryScoped({ prefix: "t3-snapshot-test-" })
          .pipe(
            Effect.mapError(
              (cause) => new DesktopSnapShotSetupError({ action, reason: "setup-failed", cause }),
            ),
          );
        const active = yield* Effect.tryPromise({
          try: () => activeWindow("darwin"),
          catch: (cause) =>
            new DesktopSnapShotSetupError({
              action,
              reason: "setup-failed",
              step: "find-window",
              ...macCommandFailure(cause),
              appName: deps.environment.displayName,
              cause,
            }),
        });
        if (!active)
          return yield* new DesktopSnapShotSetupError({
            action,
            reason: "setup-failed",
            step: "find-window",
            status: "missing",
          });
        yield* Effect.tryPromise({
          try: () =>
            captureMacWindowSnapshot(
              active,
              deps.path.join(directory, "test.png"),
              snapShotThumbnailSize(active),
            ),
          catch: (cause) =>
            new DesktopSnapShotSetupError({
              action,
              reason: "setup-failed",
              step: "capture-window",
              ...macCommandFailure(cause),
              appName: deps.environment.displayName,
              cause,
            }),
        });
      }),
    );
    return;
  } else if (action === "install-kde-helper" || action === "remove-kde-helper") {
    if (captureMode(deps.environment.platform) !== "portal" || !isKdeCaptureSession())
      return yield* new DesktopSnapShotSetupError({
        action,
        reason: "unsupported-session",
      });
    yield* Effect.tryPromise({
      try: () => new KdeCaptureSetup(deps.kdeCapturePaths).perform(action),
      catch: (error) =>
        new DesktopSnapShotSetupError({
          action,
          reason: "setup-failed",
          cause: error,
        }),
    });
  } else if (action === "install-hyprland-helper" || action === "remove-hyprland-helper") {
    if (captureMode(deps.environment.platform) !== "portal" || !isHyprlandCaptureSession())
      return yield* new DesktopSnapShotSetupError({
        action,
        reason: "unsupported-session",
      });
    yield* Effect.tryPromise({
      try: () => new HyprlandCaptureSetup(deps.hyprlandCapturePaths).perform(action),
      catch: (error) =>
        new DesktopSnapShotSetupError({
          action,
          reason: "setup-failed",
          cause: error,
        }),
    });
  } else if (action === "allow-screen-recording" || action === "allow-accessibility") {
    if (deps.environment.platform !== "darwin")
      return yield* new DesktopSnapShotSetupError({
        action,
        reason: "unsupported-session",
      });
    const owner = Electron.BrowserWindow.getFocusedWindow();
    if (action === "allow-accessibility") {
      const granted = Electron.systemPreferences.isTrustedAccessibilityClient(true);
      if (!granted && deps.environment.isPackaged) {
        yield* Effect.promise(() =>
          Electron.shell
            .openExternal(MAC_PERMISSION_SETTINGS_URLS.accessibility)
            .catch(() => undefined),
        );
      }
    } else yield* Effect.promise(requestMacScreenCapturePermission);
    yield* deps.permissions.showHelper(
      action === "allow-accessibility" ? "accessibility" : "screen-recording",
      owner,
    );
  } else if (action !== "retry-shortcut") {
    if (!deps.hasGnomeSetup())
      return yield* new DesktopSnapShotSetupError({
        action,
        reason: "unsupported-session",
      });
    yield* Effect.tryPromise({
      try: async () => {
        const { GnomeCaptureSetup } = await import("./GnomeCaptureSetup.ts");
        const setup = new GnomeCaptureSetup(deps.gnomeSetupPaths);
        try {
          await setup.perform(action);
        } finally {
          setup.close();
        }
      },
      catch: (error) =>
        new DesktopSnapShotSetupError({
          action,
          reason: "setup-failed",
          cause: error,
        }),
    });
  }
  if (action === "retry-shortcut") {
    const currentPortal = deps.shortcuts.portal;
    if (currentPortal?.hasSession && !currentPortal.state.shortcutPending) {
      yield* Effect.tryPromise(() => currentPortal.configure()).pipe(
        Effect.mapError(
          (error) =>
            new DesktopSnapShotSetupError({
              action,
              reason: "shortcut-permissions",
              cause: error.cause,
            }),
        ),
      );
    } else yield* deps.shortcuts.applySettings(yield* Ref.get(deps.settingsRef), null, true);
  }
}, deps.configurationMutex.withPermits(1));

const configDesktop = Effect.fn("desktop.snapShot.configDesktop")(function* (
  action: "preview-config" | "apply-config",
) {
  if (captureMode(deps.environment.platform) === "portal") {
    if (niriSocketPath()) return "niri" as const;
    if (isHyprlandCaptureSession()) return "hyprland" as const;
  }
  return yield* new DesktopSnapShotSetupError({
    action,
    reason: "unsupported-session",
  });
});
const previewConfig = Effect.fn("desktop.snapShot.previewConfig")(function* (
  request: DesktopCaptureConfigRequest,
  selectedPath?: string,
) {
  const desktop = yield* configDesktop("preview-config");
  return yield* Effect.tryPromise({
    try: async () => {
      const configPath =
        selectedPath ??
        (desktop === "niri"
          ? niriCaptureConfigPath(deps.home)
          : (await hyprlandCaptureShortcut(deps.linuxAppId, deps.home)).shortcutConfigPath);
      return deps.shortcutConfig.preview({ desktop, path: configPath, appId: deps.linuxAppId }, request);
    },
    catch: (cause) =>
      new DesktopSnapShotSetupError({
        action: "preview-config",
        reason: "setup-failed",
        cause,
      }),
  });
});
const applyConfig = Effect.fn("desktop.snapShot.applyConfig")(function* (previewId: string) {
  const desktop = yield* configDesktop("apply-config");
  const result = yield* Effect.tryPromise({
    try: () => deps.shortcutConfig.apply(previewId, desktop),
    catch: (cause) =>
      new DesktopSnapShotSetupError({
        action: "apply-config",
        reason: "setup-failed",
        cause,
      }),
  });
  if (result.backupPath) deps.shortcuts.verified = false;
  return result;
});

  return { setup, requestPermissions, previewConfig, applyConfig };
}
