import { pipe } from "effect/Function";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import type * as Semaphore from "effect/Semaphore";

import * as Electron from "electron";

import {
  DEFAULT_CLIENT_SETTINGS,
  isModifierPairShortcut,
  snapShotShortcutModifierPair,
  type ClientSettings,
  type DesktopSnapShotEvent,
  type DesktopSnapShotShortcutAvailability,
  type DesktopSnapShotState,
  type SnapShotModifier,
  type SnapShotShortcut,
} from "@t3tools/contracts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as MacPermissions from "../permissions/MacPermissions.ts";
import { startGlobalShiftShortcutProcess } from "./GlobalShiftShortcutProcess.ts";
import { startMacModifierPairShortcutProcess } from "./MacModifierPairShortcutProcess.ts";
import { niriSocketPath } from "./NiriSnapShot.ts";
import type { PortalCaptureShortcut } from "./PortalCaptureShortcut.ts";
import { CaptureShortcutConfig, niriCaptureConfigPath } from "./CaptureShortcutConfig.ts";
import { HYPRLAND_CAPTURE_EXECUTABLE, isHyprlandCaptureSession } from "./HyprlandSnapShot.ts";
import { niriCaptureBinding, portalShortcutTrigger } from "./linuxCaptureSession.ts";
import {
  captureMode,
  currentMacSnapShotPermissionMessage,
  observedPairMessage,
  probeGlobalShortcut,
  SnapShotFlash,
} from "./DesktopSnapShotSupport.ts";
import {
  MAC_PERMISSION_MESSAGES,
  SHORTCUT_COOLDOWN_NS,
  WAYLAND_MODIFIER_PAIR_UNAVAILABLE_MESSAGE,
} from "./DesktopSnapShotContracts.ts";
import type { AccessibilityProcessPool } from "./SnapShotAccessibilityProcess.ts";
import type { RegionSnapShotPool } from "./RegionSnapShot.ts";
import { SnapShotTransition } from "./SnapShotTransition.ts";
import {
  sameSnapShotShortcut,
  snapShotShortcutRegistrationFailureMessage,
  snapShotShortcutSystemConflict,
  toElectronAccelerator,
} from "./snapShot.ts";

type ServiceShape<S> = S extends { readonly Service: infer Shape } ? Shape : never;

export interface SnapShotShortcutDeps {
  readonly environment: ServiceShape<typeof DesktopEnvironment.DesktopEnvironment>;
  readonly permissions: ServiceShape<typeof MacPermissions.MacPermissions>;
  readonly stateRef: Ref.Ref<DesktopSnapShotState>;
  readonly settingsRef: Ref.Ref<ClientSettings>;
  readonly configurationMutex: Semaphore.Semaphore;
  readonly shiftShortcutWorkerPath: string;
  readonly linuxAppId: string;
  readonly flash: SnapShotFlash;
  readonly transition: SnapShotTransition;
  readonly accessibilityProcessPool: AccessibilityProcessPool;
  readonly regionSnapShotPool: RegionSnapShotPool;
  readonly runPromise: (effect: Effect.Effect<unknown>) => Promise<unknown>;
  readonly emit: (event: DesktopSnapShotEvent) => Effect.Effect<unknown>;
  readonly setShortcutFailure: (message: string) => Effect.Effect<unknown>;
  readonly closeLinuxFeedback: (id?: string) => void;
  readonly home: string;
  /** Called when the registered shortcut fires; late-bound so it can close over the capture effect. */
  readonly onShortcut: () => void;
}

export interface SnapShotShortcuts {
  readonly applySettings: (
    settings: ClientSettings,
    requestedPermissionMessage: string | null,
    forceShortcut?: boolean,
  ) => Effect.Effect<void>;
  readonly checkShortcut: (
    shortcut: SnapShotShortcut,
  ) => Effect.Effect<DesktopSnapShotShortcutAvailability>;
  readonly setShortcutSuppressed: (suppressed: boolean) => Effect.Effect<void>;
  readonly configure: (settings: ClientSettings) => Effect.Effect<void>;
  readonly releaseShortcut: () => void;
  /** Marks the shortcut verified and applies the repeat cooldown; false means skip this press. */
  readonly claimTrigger: (now: bigint, animating: boolean) => boolean;
  verified: boolean;
  portal: PortalCaptureShortcut | undefined;
}

export function makeSnapShotShortcuts(deps: SnapShotShortcutDeps): SnapShotShortcuts {
  let verified = false;
  let registeredAccelerator: string | undefined;
  let initialized = false;
  let portal: PortalCaptureShortcut | undefined;
  let shortcutGeneration = 0;
  let shortcutSuppressed = false;
  let lastAt: bigint | undefined;
  let stopShift: (() => void) | undefined;

const startPairShortcutProcess = (
  modifier: SnapShotModifier,
  onTrigger: () => void,
  onFailure: (error: Error) => void,
) =>
  deps.environment.platform === "darwin"
    ? startMacModifierPairShortcutProcess(modifier, onTrigger, onFailure)
    : startGlobalShiftShortcutProcess(deps.shiftShortcutWorkerPath, modifier, onTrigger, onFailure);

const releaseShortcut = () => {
  shortcutGeneration++;
  portal?.close();
  portal = undefined;
  if (registeredAccelerator) {
    Electron.globalShortcut.unregister(registeredAccelerator);
    registeredAccelerator = undefined;
  }
  stopShift?.();
  stopShift = undefined;
};

const checkShortcut = Effect.fn("desktop.snapShot.checkShortcut")(function* (
  shortcut: SnapShotShortcut,
) {
  const mode = captureMode(deps.environment.platform);
  if (mode === "unavailable") {
    return { available: false, message: "SnapShots are not supported on this platform." };
  }
  if (mode === "portal" && niriSocketPath()) {
    return {
      available: false,
      message: "Configure the capture shortcut in your Niri config, not in T3 Code.",
    };
  }
  if (mode === "portal" && isHyprlandCaptureSession()) {
    return {
      available: false,
      message: "Change the capture binding in your Hyprland config, then save it.",
    };
  }
  if (isModifierPairShortcut(shortcut)) {
    if (mode === "portal") {
      return { available: false, message: WAYLAND_MODIFIER_PAIR_UNAVAILABLE_MESSAGE };
    }
    const available = yield* Effect.tryPromise(() =>
      startPairShortcutProcess(
        snapShotShortcutModifierPair(shortcut),
        () => undefined,
        () => undefined,
      ),
    ).pipe(
      Effect.tap((stop) => Effect.sync(stop)),
      Effect.as(true),
      Effect.orElseSucceed(() => false),
    );
    return {
      available,
      message: available
        ? observedPairMessage(shortcut, deps.environment.platform)
        : snapShotShortcutRegistrationFailureMessage(shortcut, deps.environment.platform),
    };
  }
  const systemConflict = snapShotShortcutSystemConflict(shortcut);
  if (systemConflict) return { available: false, message: systemConflict };
  if (mode === "portal") {
    return yield* Effect.try(() => portalShortcutTrigger(shortcut)).pipe(
      Effect.match({
        onSuccess: () => ({
          available: true,
          message: "Your desktop will confirm this shortcut when you save it.",
        }),
        onFailure: (error) => ({
          available: false,
          message: error.cause instanceof Error ? error.cause.message : "Unsupported shortcut.",
        }),
      }),
    );
  }
  const accelerator = toElectronAccelerator(shortcut);
  const available =
    registeredAccelerator === accelerator
      ? { available: true, message: null }
      : probeGlobalShortcut(accelerator);
  return available;
});

const applySettings = Effect.fn("desktop.snapShot.applySettings")(function* (
  settings: ClientSettings,
  requestedPermissionMessage: string | null,
  forceShortcut = false,
) {
  const previousSettings = yield* Ref.get(deps.settingsRef);
  yield* Ref.set(deps.settingsRef, settings);

  const mode = captureMode(deps.environment.platform);
  const shortcut = settings.snapShotShortcut;
  if (
    settings.snapShotEnabled &&
    settings.snapShotIncludeAccessibility &&
    mode !== "unavailable"
  ) {
    deps.accessibilityProcessPool.warm();
  } else {
    deps.accessibilityProcessPool.cool();
  }
  if (settings.snapShotEnabled && deps.environment.platform === "win32") {
    deps.regionSnapShotPool.warm();
  } else {
    deps.regionSnapShotPool.cool();
  }
  if (!settings.snapShotEnabled || !settings.snapShotFlash || mode === "unavailable") {
    deps.flash.dispose();
  }
  if (!settings.snapShotEnabled || !settings.snapShotAnimations || mode === "unavailable") {
    deps.transition.dispose();
    deps.closeLinuxFeedback();
  }
  // Unrelated settings saves must not uninstall the keyboard hook or drop an approved portal session.
  const shortcutInputsChanged =
    settings.snapShotEnabled !== previousSettings.snapShotEnabled ||
    settings.snapShotIncludeAccessibility !== previousSettings.snapShotIncludeAccessibility ||
    !sameSnapShotShortcut(shortcut, previousSettings.snapShotShortcut);
  const portalShortcutUnchanged =
    portal !== undefined &&
    settings.snapShotEnabled &&
    previousSettings.snapShotEnabled &&
    (isHyprlandCaptureSession() ||
      (!isModifierPairShortcut(shortcut) &&
        !isModifierPairShortcut(previousSettings.snapShotShortcut) &&
        toElectronAccelerator(shortcut) ===
          toElectronAccelerator(previousSettings.snapShotShortcut)));
  if (!forceShortcut && (portalShortcutUnchanged || (initialized && !shortcutInputsChanged))) {
    yield* Ref.update(deps.stateRef, (state) => ({ ...state, shortcut }));
    return;
  }
  initialized = true;
  releaseShortcut();
  verified = false;
  const generation = shortcutGeneration;
  const onCurrentShortcut = () => {
    if (generation === shortcutGeneration) return deps.onShortcut();
    return Promise.resolve();
  };
  if (!settings.snapShotEnabled || mode === "unavailable") {
    yield* Ref.set(deps.stateRef, {
      mode,
      shortcut,
      shortcutRegistered: false,
      shortcutMessage: null,
      message:
        mode === "unavailable"
          ? deps.environment.platform === "linux"
            ? "SnapShots require a Wayland session. X11 capture is not supported."
            : "SnapShots are not supported on this platform."
          : null,
    });
    return;
  }

  const permissionMessage =
    requestedPermissionMessage ??
    (deps.environment.platform === "darwin"
      ? currentMacSnapShotPermissionMessage(settings.snapShotIncludeAccessibility)
      : null);
  if (permissionMessage) {
    yield* Ref.set(deps.stateRef, {
      mode,
      shortcut,
      shortcutRegistered: false,
      shortcutMessage: null,
      message: permissionMessage,
    });
    return;
  }
  if (mode === "portal" && niriSocketPath()) {
    const registered = yield* Effect.tryPromise(async () => {
      const { startNiriCaptureShortcut } = await import("./NiriCaptureShortcut.ts");
      return startNiriCaptureShortcut(deps.linuxAppId, onCurrentShortcut, () => {
        void deps.runPromise(
          deps.setShortcutFailure("The Niri capture endpoint disconnected. Restart T3 Code."),
        ).catch(() => undefined);
      });
    }).pipe(
      Effect.tap((stop) =>
        Effect.sync(() => {
          stopShift = stop;
        }),
      ),
      Effect.as(true),
      Effect.orElseSucceed(() => false),
    );
    yield* Ref.set(deps.stateRef, {
      mode,
      linuxBackend: "niri",
      shortcut,
      shortcutRegistered: false,
      shortcutBinding: niriCaptureBinding(deps.linuxAppId),
      shortcutConfigPath: niriCaptureConfigPath(deps.home),
      shortcutActionRegistered: registered,
      shortcutMessage: registered
        ? "Set up the shortcut to add it to your Niri config."
        : "Could not start the Niri capture endpoint. Another T3 Code instance may be using it.",
      message: null,
    });
    return;
  }
  const hyprland = mode === "portal" && isHyprlandCaptureSession();
  if (mode === "portal" && isModifierPairShortcut(shortcut) && !hyprland) {
    yield* Ref.set(deps.stateRef, {
      mode,
      shortcut,
      shortcutRegistered: false,
      shortcutMessage: WAYLAND_MODIFIER_PAIR_UNAVAILABLE_MESSAGE,
      message: null,
    });
    return;
  }
  if (mode === "portal" && (!isModifierPairShortcut(shortcut) || hyprland)) {
    yield* Ref.set(deps.stateRef, {
      mode,
      shortcut,
      shortcutRegistered: false,
      shortcutMessage: null,
      message: null,
    });
    yield* Effect.tryPromise(async () => {
      const { PortalCaptureShortcut } = await import("./PortalCaptureShortcut.ts");
      return new PortalCaptureShortcut(
        deps.linuxAppId,
        isModifierPairShortcut(shortcut)
          ? {
              key: "2",
              ctrlKey: true,
              modKey: false,
              altKey: false,
              shiftKey: true,
              metaKey: false,
            }
          : shortcut,
        onCurrentShortcut,
        () => {
          if (generation !== shortcutGeneration) return;
          verified = false;
          void deps.runPromise(deps.emit({ type: "shortcut-changed" })).catch(() => undefined);
        },
        undefined,
        hyprland,
      );
    }).pipe(
      Effect.tap((registration) =>
        Effect.sync(() => {
          portal = registration;
        }),
      ),
      Effect.catch((error) =>
        Ref.update(deps.stateRef, (state) => ({
          ...state,
          shortcutMessage:
            error.cause instanceof Error
              ? error.cause.message
              : "Could not connect to your desktop's shortcut service.",
        })),
      ),
    );
    return;
  }

  let registered = false;
  if (isModifierPairShortcut(shortcut)) {
    registered = yield* Effect.tryPromise(() =>
      startPairShortcutProcess(snapShotShortcutModifierPair(shortcut), onCurrentShortcut, () => {
        void pipe(
          snapShotShortcutRegistrationFailureMessage(shortcut, deps.environment.platform),
          deps.setShortcutFailure,
          deps.runPromise,
        ).catch(() => undefined);
      }),
    ).pipe(
      Effect.tap((stop) =>
        Effect.sync(() => {
          stopShift = stop;
        }),
      ),
      Effect.as(true),
      Effect.orElseSucceed(() => false),
    );
  } else {
    const accelerator = toElectronAccelerator(shortcut);
    registered = Electron.globalShortcut.register(accelerator, onCurrentShortcut);
    if (registered) registeredAccelerator = accelerator;
  }

  yield* Ref.set(deps.stateRef, {
    mode,
    shortcut,
    shortcutRegistered: registered,
    message: null,
    shortcutMessage: registered
      ? isModifierPairShortcut(shortcut)
        ? observedPairMessage(shortcut, deps.environment.platform)
        : null
      : snapShotShortcutRegistrationFailureMessage(shortcut, deps.environment.platform),
  });
});

const setShortcutSuppressed = (value: boolean) =>
  Effect.sync(() => {
    shortcutSuppressed = value;
  });

const configure = Effect.fn("desktop.snapShot.configure")(function* (settings: ClientSettings) {
  yield* deps.configurationMutex.withPermits(1)(applySettings(settings, null));
});

  const claimTrigger = (now: bigint, animating: boolean) => {
    // Repeated shortcuts must not replace a capture during its flight.
    if (shortcutSuppressed || animating) return false;
    verified = true;
    if (lastAt !== undefined && now - lastAt < SHORTCUT_COOLDOWN_NS) return false;
    lastAt = now;
    return true;
  };

  return {
    applySettings,
    checkShortcut,
    setShortcutSuppressed,
    configure,
    releaseShortcut,
    claimTrigger,
    get verified() {
      return verified;
    },
    set verified(value: boolean) {
      verified = value;
    },
    get portal() {
      return portal;
    },
    set portal(value: PortalCaptureShortcut | undefined) {
      portal = value;
    },
  };
}
