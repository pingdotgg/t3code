// @effect-diagnostics globalTimers:off -- Capture timeouts and Electron overlay animation timers run at native callback boundaries outside Effect fibers.

import { pipe } from "effect/Function";
import {
  DEFAULT_CLIENT_SETTINGS,
  DesktopPendingSnapShot,
  isModifierPairShortcut,
  snapShotModifierPairLabel,
  snapShotShortcutModifierPair,
  type DesktopSnapShot as DesktopSnapShotValue,
  type DesktopSnapShotShortcutAvailability,
  type DesktopSnapShotState,
  DesktopSnapShotSetupAction,
  type DesktopCaptureConfigRequest,
  type DesktopCaptureConfigPreview,
  type DesktopCaptureConfigApplied,
  type ClientSettings,
  type SnapShotModifier,
  type SnapShotModifierPairShortcut,
  type SnapShotShortcut,
  type DesktopSnapShotEvent,
  type DesktopSnapShotId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Base64 from "effect/encoding/Base64";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Predicate from "effect/Predicate";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import * as Electron from "electron";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopClientSettings from "../settings/DesktopClientSettings.ts";
import * as DesktopWindow from "../window/DesktopWindow.ts";
import { startGlobalShiftShortcutProcess } from "./GlobalShiftShortcutProcess.ts";
import { startMacModifierPairShortcutProcess } from "./MacModifierPairShortcutProcess.ts";
import { activeWindow, type ActiveWindow } from "./ActiveWindow.ts";
import { captureMacWindowSnapshot, type MacSnapShotSource } from "./MacSnapShot.ts";
import type { LinuxCaptureFeedback, LinuxWindowMetadata } from "./LinuxSnapShot.ts";
import { niriSocketPath } from "./NiriSnapShot.ts";
import { CaptureShortcutConfig, niriCaptureConfigPath } from "./CaptureShortcutConfig.ts";
import type { PortalCaptureShortcut } from "./PortalCaptureShortcut.ts";
import {
  CaptureSetupRequiredError,
  isGnomeCaptureSession,
  niriCaptureBinding,
  portalShortcutTrigger,
} from "./linuxCaptureSession.ts";
import {
  HyprlandCaptureSetup,
  HYPRLAND_CAPTURE_EXECUTABLE,
  isHyprlandCaptureSession,
  hyprlandCaptureShortcut,
  type HyprlandCapturePaths,
} from "./HyprlandSnapShot.ts";
import {
  KdeCaptureSetup,
  KDE_CAPTURE_EXECUTABLE,
  isKdeCaptureSession,
  type KdeCapturePaths,
} from "./KdeSnapShot.ts";
import {
  captureRegionWindowSnapshot,
  makeRegionSnapShotPool,
  type RegionSnapShotPool,
  type RegionSnapShotSource,
} from "./RegionSnapShot.ts";
import { type SnapShotAnimationDestination, SnapShotTransition } from "./SnapShotTransition.ts";
import {
  type AccessibilityProcessPool,
  makeSnapShotAccessibilityProcessPool,
} from "./SnapShotAccessibilityProcess.ts";
import * as MacPermissions from "../permissions/MacPermissions.ts";
import { MAC_PERMISSION_SETTINGS_URLS } from "../permissions/MacPermission.ts";
import { showWindowsCaptureOverlay } from "./WindowsCaptureFeedback.ts";

import {
  boundedSnapShotString,
  isWaylandSession,
  sameSnapShotShortcut,
  toElectronAccelerator,
  snapShotShortcutRegistrationFailureMessage,
  snapShotShortcutSystemConflict,
} from "./snapShot.ts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { readImageDimensions } from "@t3tools/shared/imageDimensions";


import { makeSnapShotShortcuts } from "./DesktopSnapShotShortcuts.ts";
import { makeSnapShotSetupActions } from "./DesktopSnapShotSetup.ts";

export * from "./DesktopSnapShotContracts.ts";
export * from "./DesktopSnapShotSupport.ts";

import {
  SHORTCUT_COOLDOWN_NS,
  WAYLAND_MODIFIER_PAIR_UNAVAILABLE_MESSAGE,
  MAC_PERMISSION_MESSAGES,
  decodePendingCapture,
  decodePendingCaptureJson,
  encodePendingCaptureJson,
  DesktopSnapShotError,
  captureFailure,
  DesktopSnapShot,
  DesktopSnapShotSetupError,
} from "./DesktopSnapShotContracts.ts";
import {
  macCommandFailure,
  captureMode,
  snapShotThumbnailSize,
  iconDataUrl,
  snapShotAppName,
  requestMacScreenCapturePermission,
  currentMacPermissions,
  macPermissionMessage,
  currentMacSnapShotPermissionMessage,
  requestMacSnapShotPermissions,
  captureSource,
  SnapShotFlash,
  observedPairMessage,
  probeGlobalShortcut,
} from "./DesktopSnapShotSupport.ts";

export const make = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const permissions = yield* MacPermissions.MacPermissions;
  const clientSettings = yield* DesktopClientSettings.DesktopClientSettings;
  const desktopWindow = yield* DesktopWindow.DesktopWindow;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const random = yield* SecureRandom.SecureRandom;
  const settingsRef = yield* Ref.make(DEFAULT_CLIENT_SETTINGS);
  const stateRef = yield* Ref.make<DesktopSnapShotState>({
    mode: captureMode(environment.platform),
    shortcut: DEFAULT_CLIENT_SETTINGS.snapShotShortcut,
    shortcutRegistered: false,
    shortcutMessage: null,
    message: null,
  });
  const snapshotMutex = yield* Semaphore.make(1);
  const configurationMutex = yield* Semaphore.make(1);
  const context = yield* Effect.context<
    DesktopEnvironment.DesktopEnvironment | DesktopWindow.DesktopWindow
  >();
  const runPromise = Effect.runPromiseWith(context);
  const captureDirectory = path.join(environment.stateDir, "snap-shots");
  const linuxAppId = environment.linuxDesktopEntryName.replace(/\.desktop$/, "");
  const home = yield* HostProcess.HomeDirectory;
  const gnomeSetupPaths = {
    bundle: environment.isPackaged
      ? path.join(environment.resourcesPath, "gnome-extension")
      : path.join(environment.appRoot, "apps/desktop/gnome-extension"),
    dataHome: path.dirname(environment.linuxApplicationsDir),
  };
  const kdeCapturePaths = {
    bundle: environment.isPackaged
      ? path.join(environment.resourcesPath, "kde-capture", KDE_CAPTURE_EXECUTABLE)
      : path.join(
          environment.appRoot,
          "native/kde-snap-shot/target/release",
          KDE_CAPTURE_EXECUTABLE,
        ),
    dataHome: path.dirname(environment.linuxApplicationsDir),
  };
  const hasGnomeSetup = () =>
    captureMode(environment.platform) === "portal" && isGnomeCaptureSession(process.env);
  const hyprlandCapturePaths = {
    bundle: environment.isPackaged
      ? path.join(environment.resourcesPath, "hyprland-capture", HYPRLAND_CAPTURE_EXECUTABLE)
      : path.join(
          environment.appRoot,
          "native/hyprland-snap-shot/target/release",
          HYPRLAND_CAPTURE_EXECUTABLE,
        ),
    dataHome: path.dirname(environment.linuxApplicationsDir),
  };
  const shiftShortcutWorkerPath = path.join(__dirname, "snapShot", "GlobalShiftShortcutWorker.cjs");
  const shortcutConfig = new CaptureShortcutConfig(home);
  const accessibilityWorkerPath = path.join(
    __dirname,
    "snapShot",
    "SnapShotAccessibilityWorker.cjs",
  );
  const accessibilityProcessPool = makeSnapShotAccessibilityProcessPool(accessibilityWorkerPath);
  const regionSnapShotPool = makeRegionSnapShotPool(
    path.join(__dirname, "snapShot", "RegionSnapShotWorker.cjs"),
  );
  const showCaptureWindow =
    environment.platform === "win32" ? showWindowsCaptureOverlay : undefined;
  const flash = new SnapShotFlash(showCaptureWindow);
  const transition = new SnapShotTransition({
    showWindow: showCaptureWindow,
    waitForCompositorFrame: environment.platform === "win32",
    // Transparent Windows surfaces must not resize while their compositor animation is running.
    boundOverlayToCaptureDisplays: environment.platform !== "linux",
    alwaysOnTopLevel: environment.platform === "linux" ? undefined : "pop-up-menu",
  });
  let linuxFeedback: { id: string; feedback: LinuxCaptureFeedback } | undefined;
  const closeLinuxFeedback = (id?: string) => {
    if (!linuxFeedback || (id !== undefined && linuxFeedback.id !== id)) return;
    linuxFeedback.feedback.close();
    linuxFeedback = undefined;
  };
  const completeLinuxFeedback = async (id: string) => {
    if (linuxFeedback?.id !== id) return;
    const pending = linuxFeedback;
    await pending.feedback.complete().catch(() => undefined);
    if (linuxFeedback === pending) linuxFeedback = undefined;
  };


  const emit = (event: DesktopSnapShotEvent) =>
    desktopWindow.dispatchSnapShotEvent(event).pipe(Effect.ignoreCause);
  const setFailure = (message: string, captureId?: string) =>
    Ref.update(stateRef, (state) => ({ ...state, message })).pipe(
      Effect.andThen(
        emit(
          captureId ? { type: "failed", id: captureId as DesktopSnapShotId } : { type: "failed" },
        ),
      ),
    );
  const setShortcutFailure = (shortcutMessage: string) =>
    Effect.sync(() => {
      shortcuts.verified = false;
    }).pipe(
      Effect.andThen(
        Ref.update(stateRef, (state) => ({
          ...state,
          shortcutRegistered: false,
          shortcutMessage,
        })),
      ),
      Effect.andThen(emit({ type: "failed" })),
    );


  let shortcutTrigger: () => void = () => {};
  const shortcuts = makeSnapShotShortcuts({
    environment,
    permissions,
    stateRef,
    settingsRef,
    configurationMutex,
    shiftShortcutWorkerPath,
    linuxAppId,
    flash,
    transition,
    accessibilityProcessPool,
    regionSnapShotPool,
    runPromise,
    emit,
    setShortcutFailure,
    closeLinuxFeedback,
    home,
    onShortcut: () => shortcutTrigger(),
  });
  const setupActions = makeSnapShotSetupActions({
    environment,
    permissions,
    fileSystem,
    path,
    configurationMutex,
    settingsRef,
    shortcutConfig,
    home,
    linuxAppId,
    kdeCapturePaths,
    hyprlandCapturePaths,
    gnomeSetupPaths,
    hasGnomeSetup,
    shortcuts,
  });

  const discardCapture = Effect.fn("desktop.snapShot.discardCapture")(function* (id: string) {
    closeLinuxFeedback(id);
    transition.dismiss(id);
    yield* Effect.forEach(
      [`${id}.png`, `${id}.tmp.png`, `${id}.json`, `${id}.json.tmp`],
      (name) => fileSystem.remove(path.join(captureDirectory, name), { force: true }),
      { concurrency: "unbounded", discard: true },
    ).pipe(Effect.ignore);
  });

  const prepareCapture = Effect.fn("desktop.snapShot.prepareCapture")(function* (
    settings: ClientSettings,
  ) {
    const id = yield* random.uuidV4().pipe(Effect.mapError((cause) => captureFailure(cause)));
    const mode = captureMode(environment.platform);
    if (mode === "unavailable") {
      return yield* new DesktopSnapShotError({ operation: "unsupported", captureId: id });
    }
    const imageTempPath = path.join(captureDirectory, `${id}.tmp.png`);

    return yield* Effect.gen(function* () {
      // Retire feedback before capture so rapid captures cannot photograph the previous overlay.
      closeLinuxFeedback();
      flash.dispose();
      transition.dispose();
      yield* fileSystem.makeDirectory(captureDirectory, { recursive: true });
      yield* emit({ type: "requested", id: id as DesktopSnapShotId });
      const snapshot = yield* Effect.tryPromise({
        try: () =>
          captureSource({
            mode,
            captureId: id,
            platform: environment.platform,
            settings,
            flash,
            transition,
            imageTempPath,
            linuxAppId,
            kdeCapturePaths,
            hyprlandCapturePaths,
            accessibilityProcessPool,
            regionSnapShotPool,
            prepareReveal: () => runPromise(desktopWindow.prepareCaptureReveal),
            onLinuxFeedback: (feedback) => {
              linuxFeedback = { id, feedback };
            },
          }),
        catch: (cause) => captureFailure(cause, id),
      });
      const capturedAt = yield* DateTime.now.pipe(Effect.map(DateTime.formatIso));
      if (snapshot.linuxActivationFailure) {
        yield* Effect.logWarning(
          "The compositor could not activate T3 Code after the snapshot",
          snapshot.linuxActivationFailure.cause,
        );
      }
      if (snapshot.animationStarted) {
        yield* emit({ type: "started", id: id as DesktopSnapShotId });
      } else {
        yield* desktopWindow.activate.pipe(Effect.ignoreCause);
      }
      return { id, capturedAt, ...snapshot };
    }).pipe(Effect.mapError((cause) => captureFailure(cause, id)));
  });

  const persistCapture = Effect.fn("desktop.snapShot.persistCapture")(function* (
    capture: Effect.Success<ReturnType<typeof prepareCapture>>,
  ) {
    const { id, capturedAt, source, active, linuxWindow, contextPromise, png, imageTempReady } =
      capture;
    const imagePath = path.join(captureDirectory, `${id}.png`);
    const imageTempPath = path.join(captureDirectory, `${id}.tmp.png`);
    const metadataPath = path.join(captureDirectory, `${id}.json`);

    yield* Effect.gen(function* () {
      const accessibilityContext = yield* Effect.promise(() => contextPromise);
      const appIconDataUrl = yield* Effect.promise(() =>
        iconDataUrl(source, active, environment.platform),
      );
      const appIdentifier = boundedSnapShotString(
        active?.platform === "macos" ? active.owner.bundleId : linuxWindow?.appIdentifier,
        255,
      );
      const pending = yield* decodePendingCapture({
        id,
        name: `window-${capturedAt.replaceAll(":", "-")}.png`,
        mimeType: "image/png",
        sizeBytes: png.byteLength,
        source: {
          kind: "snap-shot",
          capturedAt,
          appName:
            boundedSnapShotString(snapShotAppName(active, linuxWindow, source.name), 255) ??
            "Window",
          windowTitle:
            boundedSnapShotString(
              active?.title.trim() || linuxWindow?.title.trim() || source.name,
              1_000,
            ) ?? "",
          ...(accessibilityContext?.accessibleText
            ? { accessibleText: accessibilityContext.accessibleText }
            : {}),
          ...(accessibilityContext?.accessibility
            ? { accessibility: accessibilityContext.accessibility }
            : {}),
          ...(appIdentifier ? { appIdentifier } : {}),
          ...(appIconDataUrl ? { appIconDataUrl } : {}),
        },
      });
      if (!imageTempReady) yield* fileSystem.writeFile(imageTempPath, png);
      yield* fileSystem.rename(imageTempPath, imagePath);
      yield* fileSystem.writeFileString(
        metadataPath + ".tmp",
        yield* encodePendingCaptureJson(pending),
      );
      yield* fileSystem.rename(metadataPath + ".tmp", metadataPath);
    }).pipe(Effect.mapError((cause) => captureFailure(cause, id)));
  });

  const capture = Effect.gen(function* () {
    const settings = yield* Ref.get(settingsRef);
    if (!settings.snapShotEnabled) {
      return yield* new DesktopSnapShotError({ operation: "disabled" });
    }
    const prepared = yield* prepareCapture(settings).pipe(
      Effect.tapError((error) =>
        (error.captureId ? discardCapture(error.captureId) : Effect.void).pipe(
          Effect.andThen(setFailure(error.message, error.captureId)),
        ),
      ),
      snapshotMutex.withPermitsIfAvailable(1),
    );
    if (Option.isNone(prepared)) return;
    const capture = prepared.value;
    yield* persistCapture(capture).pipe(
      Effect.tap(() =>
        Ref.update(stateRef, (state) => ({ ...state, message: null })).pipe(
          Effect.andThen(emit({ type: "ready", id: capture.id as DesktopSnapShotId })),
        ),
      ),
      Effect.tapError((error) =>
        discardCapture(capture.id).pipe(
          Effect.andThen(Ref.update(stateRef, (state) => ({ ...state, message: error.message }))),
          Effect.andThen(emit({ type: "failed", id: capture.id as DesktopSnapShotId })),
        ),
      ),
    );
  }).pipe(Effect.withSpan("desktop.snapShot.capture"));

  const captureFromShortcut = Effect.gen(function* () {
    const now = yield* Clock.currentTimeNanos;
    // Repeated shortcuts must not replace a capture during its flight.
    if (!shortcuts.claimTrigger(now, transition.isAnimating)) return;
    yield* capture;
  }).pipe(Effect.withSpan("desktop.snapShot.shortcutActivated"));
  const onShortcut = () => runPromise(captureFromShortcut).catch(() => undefined);
  shortcutTrigger = onShortcut;







  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      shortcuts.releaseShortcut();
      flash.dispose();
      transition.dispose();
      closeLinuxFeedback();
      accessibilityProcessPool.close();
      regionSnapShotPool.close();
    }),
  );


  return DesktopSnapShot.of({
    initialize: configurationMutex.withPermits(1)(
      clientSettings.get.pipe(
        Effect.flatMap((stored) =>
          shortcuts.applySettings(
            Option.getOrElse(stored, () => DEFAULT_CLIENT_SETTINGS),
            null,
          ),
        ),
        Effect.ignore,
      ),
    ),
    configure: shortcuts.configure,
    requestPermissions: setupActions.requestPermissions,
    setup: setupActions.setup,
    previewConfig: setupActions.previewConfig,
    applyConfig: setupActions.applyConfig,
    state: Ref.get(stateRef).pipe(
      Effect.flatMap((state) =>
        state.mode === "portal"
          ? Effect.tryPromise(async () => {
              const { getLinuxCaptureSupport } = await import("./LinuxSnapShot.ts");
              return getLinuxCaptureSupport(linuxAppId);
            }).pipe(
              Effect.map((support) => ({ ...state, ...support })),
              Effect.catch((error) =>
                Effect.succeed({
                  ...state,
                  message:
                    error.cause instanceof Error
                      ? error.cause.message
                      : "Could not check desktop capture support. Check your desktop session and try again.",
                }),
              ),
            )
          : environment.platform === "darwin"
            ? Effect.gen(function* () {
                const settings = yield* Ref.get(settingsRef);
                const macPermissions = currentMacPermissions();
                const message = settings.snapShotEnabled
                  ? macPermissionMessage(macPermissions, settings.snapShotIncludeAccessibility)
                  : null;
                const recovered =
                  message === null &&
                  state.message !== null &&
                  MAC_PERMISSION_MESSAGES.has(state.message)
                    ? yield* configurationMutex
                        .withPermits(1)(shortcuts.applySettings(settings, null, true))
                        .pipe(Effect.andThen(Ref.get(stateRef)))
                    : state;
                return { ...recovered, macPermissions, ...(message ? { message } : {}) };
              })
            : Effect.succeed(
                environment.platform === "win32" ? { ...state, windows: true } : state,
              ),
      ),
      Effect.flatMap((state) =>
        Effect.gen(function* () {
          const linuxDesktop =
            state.mode === "portal"
              ? process.env.XDG_CURRENT_DESKTOP?.toLowerCase()
                  .split(":")
                  .find(
                    (name) =>
                      name === "gnome" || name === "kde" || name === "niri" || name === "hyprland",
                  )
              : undefined;
          const gnomeExtension = hasGnomeSetup()
            ? yield* Effect.promise(async () => {
                const { GnomeCaptureSetup } = await import("./GnomeCaptureSetup.ts");
                const setup = new GnomeCaptureSetup(gnomeSetupPaths);
                try {
                  return await setup.state();
                } finally {
                  setup.close();
                }
              })
            : undefined;
          const kdeHelper =
            state.linuxBackend === "kde"
              ? yield* Effect.promise(() => new KdeCaptureSetup(kdeCapturePaths).state())
              : undefined;
          const hyprlandHelper =
            state.linuxBackend === "hyprland"
              ? yield* Effect.promise(() => new HyprlandCaptureSetup(hyprlandCapturePaths).state())
              : undefined;
          const hyprlandShortcut =
            state.linuxBackend === "hyprland"
              ? yield* Effect.promise(() => hyprlandCaptureShortcut(linuxAppId, home))
              : undefined;
          return {
            ...state,
            ...shortcuts.portal?.state,
            ...(linuxDesktop ? { linuxDesktop } : {}),
            ...(gnomeExtension ? { gnomeExtension } : {}),
            ...(hyprlandHelper
              ? {
                  hyprlandHelper,
                  linuxFeedbackAvailable:
                    hyprlandHelper.status === "ready" && hyprlandHelper.feedbackAvailable === true,
                }
              : {}),
            ...hyprlandShortcut,
            ...(state.linuxBackend === "niri"
              ? { shortcutConfigPath: niriCaptureConfigPath(home) }
              : {}),
            ...(kdeHelper
              ? {
                  kdeHelper,
                  linuxFeedbackAvailable:
                    kdeHelper.status === "ready" && kdeHelper.feedbackAvailable === true,
                }
              : {}),
            shortcutVerified: shortcuts.verified,
          };
        }),
      ),
    ),
    checkShortcut: shortcuts.checkShortcut,
    setShortcutSuppressed: shortcuts.setShortcutSuppressed,
    capture,
    listPending: fileSystem.readDirectory(captureDirectory).pipe(
      Effect.catchTags({
        PlatformError: (cause) =>
          cause.reason._tag === "NotFound" ? Effect.succeed([]) : Effect.fail(cause),
      }),
      Effect.flatMap((names) =>
        Effect.forEach(
          names.filter((name) => name.endsWith(".json") && !name.endsWith(".json.tmp")),
          (name) =>
            fileSystem.readFileString(path.join(captureDirectory, name)).pipe(
              Effect.flatMap(decodePendingCaptureJson),
              Effect.orElseSucceed(() => undefined),
            ),
          { concurrency: "unbounded" },
        ),
      ),
      Effect.map((captures) =>
        captures
          .filter((capture) => capture !== undefined)
          .sort((left, right) => left.source.capturedAt.localeCompare(right.source.capturedAt)),
      ),
      Effect.mapError((cause) => new DesktopSnapShotError({ operation: "list-pending", cause })),
    ),
    read: Effect.fn("DesktopSnapShot.read")(
      function* (id) {
        const metadata = yield* fileSystem
          .readFileString(path.join(captureDirectory, `${id}.json`))
          .pipe(Effect.flatMap(decodePendingCaptureJson));
        const png = yield* fileSystem.readFile(path.join(captureDirectory, `${id}.png`));
        return {
          ...metadata,
          dataUrl: `data:image/png;base64,${Base64.encode(png)}`,
        };
      },
      (effect, id) =>
        effect.pipe(
          Effect.mapError(
            (cause) => new DesktopSnapShotError({ operation: "read", captureId: id, cause }),
          ),
        ),
    ),
    setAnimationDestination: Effect.fn("DesktopSnapShot.setAnimationDestination")(
      function (id, destination) {
        return Effect.promise(async () => {
          if (linuxFeedback?.id === id && destination.relativeFrame) {
            await linuxFeedback.feedback
              .animateTo(destination.relativeFrame)
              .catch(() => closeLinuxFeedback(id));
            return;
          }
          transition.animateTo(id, destination);
          await transition.waitForLanding(id);
        });
      },
    ),
    dismissAnimation: Effect.fn("DesktopSnapShot.dismissAnimation")(function (id) {
      return Effect.sync(() => {
        closeLinuxFeedback(id);
        transition.dismiss(id);
      });
    }),
    acknowledge: Effect.fn("DesktopSnapShot.acknowledge")(function (id) {
      return Effect.promise(async () => {
        await completeLinuxFeedback(id);
        await transition.complete(id);
      }).pipe(
        Effect.andThen(
          Effect.all(
            [
              fileSystem.remove(path.join(captureDirectory, `${id}.json`), { force: true }),
              fileSystem.remove(path.join(captureDirectory, `${id}.png`), { force: true }),
            ],
            { concurrency: "unbounded", discard: true },
          ),
        ),
        Effect.mapError(
          (cause) => new DesktopSnapShotError({ operation: "acknowledge", captureId: id, cause }),
        ),
      );
    }),
  });
});

export const layer = Layer.effect(DesktopSnapShot, make);


