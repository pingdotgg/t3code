// @effect-diagnostics globalTimers:off -- Flash overlay animation and overlay close timers run outside Effect fibers.

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
import {
  MAX_CAPTURE_WIDTH,
  MAX_CAPTURE_HEIGHT,
  FLASH_ANIMATION_DURATION_MS,
  FLASH_STATIC_DURATION_MS,
  FLASH_FRAME_INTERVAL_MS,
  FLASH_PEAK_OPACITY,
  MAC_SCREEN_CAPTURE_SETTINGS_URL,
  MAC_SCREEN_CAPTURE_PERMISSION_MESSAGE,
  MAC_ACCESSIBILITY_PERMISSION_MESSAGE,
  MAC_BOTH_PERMISSIONS_MESSAGE,
  DesktopSnapShotError,
  DesktopSnapShot,
} from "./DesktopSnapShotContracts.ts";

export function macCommandFailure(cause: unknown) {
  const failure = Predicate.isObject(cause) ? cause : {};
  if ("killed" in failure && failure.killed === true) return { status: "timed-out" } as const;
  return "code" in failure && typeof failure.code === "number"
    ? ({ status: "exited", exitCode: failure.code } as const)
    : ({ status: "failed" } as const);
}

export type SnapShotSystemAnimationSettings = Pick<
  ReturnType<typeof Electron.systemPreferences.getAnimationSettings>,
  "prefersReducedMotion" | "shouldRenderRichAnimation"
>;

export function captureMode(platform: NodeJS.Platform): DesktopSnapShotState["mode"] {
  if (platform === "linux")
    return isWaylandSession(platform, process.env) ? "portal" : "unavailable";
  return platform === "darwin" || platform === "win32" ? "direct" : "unavailable";
}

export function shouldAnimateSnapShot(settings: SnapShotSystemAnimationSettings): boolean {
  return settings.shouldRenderRichAnimation && !settings.prefersReducedMotion;
}

export function snapShotThumbnailSize(active: ActiveWindow | undefined): Electron.Size {
  if (!active) return { width: 2_560, height: 1_600 };
  return {
    width: Math.min(Math.max(active.bounds.width, 1), MAX_CAPTURE_WIDTH),
    height: Math.min(Math.max(active.bounds.height, 1), MAX_CAPTURE_HEIGHT),
  };
}

export function snapShotIconDataUrl(
  ...icons: ReadonlyArray<Electron.NativeImage | null | undefined>
): string | undefined {
  const icon = icons.find((candidate): candidate is Electron.NativeImage =>
    Boolean(candidate && !candidate.isEmpty()),
  );
  if (!icon) return undefined;
  return icon.resize({ width: 64, height: 64, quality: "best" }).toDataURL({ scaleFactor: 2 });
}

export async function appFileIcon(
  path: string,
  platform: NodeJS.Platform,
): Promise<Electron.NativeImage | undefined> {
  if (platform === "darwin") {
    const thumbnail = await Electron.nativeImage
      .createThumbnailFromPath(path, { width: 64, height: 64 })
      .catch(() => undefined);
    if (thumbnail && !thumbnail.isEmpty()) return thumbnail;
  }
  return Electron.app.getFileIcon(path, { size: "normal" }).catch(() => undefined);
}

export async function iconDataUrl(
  source: { readonly appIcon?: Electron.NativeImage | null },
  active: ActiveWindow | undefined,
  platform: NodeJS.Platform,
): Promise<string | undefined> {
  try {
    const fileIcon = active?.owner.path
      ? await appFileIcon(active.owner.path, platform)
      : undefined;
    return snapShotIconDataUrl(fileIcon, source.appIcon);
  } catch {
    return undefined;
  }
}

export function snapShotAppName(
  active: ActiveWindow | undefined,
  linuxWindow: LinuxWindowMetadata | undefined,
  sourceName: string,
): string {
  const appName =
    active?.owner.name.trim() || linuxWindow?.appName.trim() || sourceName.trim() || "Window";
  if (active?.platform !== "windows") return appName;
  return appName.replace(/\.exe$/i, "").trim() || appName;
}

export async function requestMacScreenCapturePermission(): Promise<string | null> {
  let status: ReturnType<typeof Electron.systemPreferences.getMediaAccessStatus>;
  try {
    status = Electron.systemPreferences.getMediaAccessStatus("screen");
    if (status === "granted") return null;
    if (status === "not-determined") {
      try {
        await Electron.desktopCapturer.getSources({
          types: ["screen"],
          thumbnailSize: { width: 1, height: 1 },
        });
      } catch {}
      status = Electron.systemPreferences.getMediaAccessStatus("screen");
      if (status === "granted") return null;
    }
  } catch {}
  await Electron.shell.openExternal(MAC_SCREEN_CAPTURE_SETTINGS_URL).catch(() => undefined);
  return MAC_SCREEN_CAPTURE_PERMISSION_MESSAGE;
}

export function currentMacPermissions(): NonNullable<DesktopSnapShotState["macPermissions"]> {
  return {
    screenRecording: Electron.systemPreferences.getMediaAccessStatus("screen") === "granted",
    accessibility: Electron.systemPreferences.isTrustedAccessibilityClient(false),
  };
}

export function macPermissionMessage(
  permissions: NonNullable<DesktopSnapShotState["macPermissions"]>,
  includeAccessibility: boolean,
): string | null {
  const accessibilityGranted = !includeAccessibility || permissions.accessibility;
  if (!accessibilityGranted && !permissions.screenRecording) {
    return MAC_BOTH_PERMISSIONS_MESSAGE;
  }
  if (!accessibilityGranted) {
    return MAC_ACCESSIBILITY_PERMISSION_MESSAGE;
  }
  return permissions.screenRecording ? null : MAC_SCREEN_CAPTURE_PERMISSION_MESSAGE;
}

export function currentMacSnapShotPermissionMessage(includeAccessibility: boolean): string | null {
  return macPermissionMessage(
    {
      screenRecording: Electron.systemPreferences.getMediaAccessStatus("screen") === "granted",
      accessibility:
        !includeAccessibility || Electron.systemPreferences.isTrustedAccessibilityClient(false),
    },
    includeAccessibility,
  );
}

export async function requestMacSnapShotPermissions(
  includeAccessibility: boolean,
): Promise<string | null> {
  const accessibilityGranted =
    !includeAccessibility || Electron.systemPreferences.isTrustedAccessibilityClient(true);
  const screenMessage = await requestMacScreenCapturePermission();
  if (!accessibilityGranted && screenMessage) {
    return MAC_BOTH_PERMISSIONS_MESSAGE;
  }
  if (!accessibilityGranted) {
    return MAC_ACCESSIBILITY_PERMISSION_MESSAGE;
  }
  return screenMessage;
}

export function snapShotImageSize(png: Buffer, fallback: Electron.Rectangle): Electron.Size {
  // Capture backends already validate or encode the PNG. Reading its header
  // avoids decoding every pixel again just to size accessibility coordinates.
  const size = readImageDimensions(png);
  if (size) return size;
  return {
    width: Math.max(1, Math.round(fallback.width)),
    height: Math.max(1, Math.round(fallback.height)),
  };
}

export async function captureSource({
  mode,
  captureId,
  platform,
  settings,
  flash,
  transition,
  imageTempPath,
  linuxAppId,
  kdeCapturePaths,
  hyprlandCapturePaths,
  accessibilityProcessPool,
  regionSnapShotPool,
  prepareReveal,
  onLinuxFeedback,
}: {
  mode: DesktopSnapShotState["mode"];
  captureId: string;
  platform: NodeJS.Platform;
  settings: ClientSettings;
  flash: SnapShotFlash;
  transition: SnapShotTransition;
  imageTempPath: string;
  linuxAppId: string;
  kdeCapturePaths: KdeCapturePaths;
  hyprlandCapturePaths: HyprlandCapturePaths;
  accessibilityProcessPool: AccessibilityProcessPool;
  regionSnapShotPool: RegionSnapShotPool;
  prepareReveal: () => Promise<void>;
  onLinuxFeedback: (feedback: LinuxCaptureFeedback) => void;
}) {
  let active: ActiveWindow | undefined;
  let linuxWindow: LinuxWindowMetadata | undefined;
  let linuxFeedback: LinuxCaptureFeedback | undefined;
  let linuxActivationFailure: { readonly cause: unknown } | undefined;
  const destinationWindow =
    Electron.BrowserWindow.getFocusedWindow() ??
    Electron.BrowserWindow.getAllWindows().find((window) => !window.isDestroyed());
  const destinationWindowBounds = destinationWindow?.getBounds();
  {
    const revealPreparation =
      platform === "win32" ? prepareReveal().catch(() => undefined) : Promise.resolve();
    if (mode === "direct") {
      active = await activeWindow(platform);
    }

    let source: MacSnapShotSource | RegionSnapShotSource | Electron.DesktopCapturerSource;
    let png: Buffer;
    let imageTempReady = false;
    if (platform === "darwin") {
      if (!active) {
        throw new DesktopSnapShotError({ operation: "window-unavailable", captureId });
      }
      ({ source, png } = await captureMacWindowSnapshot(
        active,
        imageTempPath,
        snapShotThumbnailSize(active),
      ));
      imageTempReady = true;
    } else if (mode === "direct") {
      if (!active) {
        throw new DesktopSnapShotError({ operation: "window-unavailable", captureId });
      }
      ({ source, png } = await captureRegionWindowSnapshot(
        regionSnapShotPool,
        active,
        snapShotFlashBounds(active, platform),
        snapShotThumbnailSize(active),
      ));
    } else {
      const { captureLinuxWindow } = await import("./LinuxSnapShot.ts");
      const snapshot = await captureLinuxWindow(
        linuxAppId,
        {
          flash: settings.snapShotFlash,
          animate:
            settings.snapShotAnimations &&
            shouldAnimateSnapShot(Electron.systemPreferences.getAnimationSettings()),
        },
        kdeCapturePaths,
        hyprlandCapturePaths,
      );
      if (snapshot) {
        linuxFeedback = snapshot.feedback;
        if (linuxFeedback) onLinuxFeedback(linuxFeedback);
        linuxWindow = snapshot.window;
        source = { name: linuxWindow?.title || "Active window" };
        png = snapshot.png;
      } else {
        const [selected] = await Electron.desktopCapturer.getSources({
          types: ["window", "screen"],
          thumbnailSize: snapShotThumbnailSize(active),
          fetchWindowIcons: true,
        });
        if (!selected || selected.thumbnail.isEmpty()) {
          throw new DesktopSnapShotError({
            operation: "no-window-selected",
            captureId,
          });
        }
        source = selected;
        png = selected.thumbnail.toPNG();
      }
    }
    const accessibleIdentity = active
      ? { ...active, bounds: snapShotFlashBounds(active, platform) }
      : linuxWindow?.processId
        ? {
            title: linuxWindow.title,
            bounds: linuxWindow.bounds,
            ...(linuxWindow.clientBounds ? { clientBounds: linuxWindow.clientBounds } : {}),
            owner: { processId: linuxWindow.processId },
            ...(linuxWindow.accessibilityBoundsReliable === false
              ? { accessibilityBoundsReliable: false }
              : {}),
          }
        : undefined;
    const accessibilityRead =
      accessibleIdentity && settings.snapShotIncludeAccessibility
        ? accessibilityProcessPool.read({
            active: accessibleIdentity,
            platform,
            sourceTitle: source.name,
            imageSize: snapShotImageSize(png, active?.bounds ?? accessibleIdentity.bounds),
          })
        : undefined;
    if (accessibilityRead) {
      await accessibilityRead.started;
    }
    const contextPromise = accessibilityRead?.result ?? Promise.resolve(undefined);
    await revealPreparation;
    if (linuxFeedback && destinationWindow && !destinationWindow.isDestroyed()) {
      if (destinationWindow.isMinimized()) destinationWindow.restore();
      if (!destinationWindow.isVisible()) destinationWindow.show();
      await linuxFeedback.activate(destinationWindow.getTitle()).catch((cause: unknown) => {
        linuxActivationFailure = { cause };
      });
    }
    const animationStarted =
      linuxFeedback?.animationStarted ??
      (await showCaptureFeedback(
        transition,
        flash,
        captureId,
        `data:image/png;base64,${png.toString("base64")}`,
        settings,
        active,
        platform,
        destinationWindowBounds,
      ));
    return {
      source,
      active,
      linuxWindow,
      linuxActivationFailure,
      contextPromise,
      animationStarted,
      png,
      imageTempReady,
    };
  }
}

export function createSnapShotFlashWindow(bounds: Electron.Rectangle): Electron.BaseWindow {
  const window = new Electron.BaseWindow({
    ...bounds,
    alwaysOnTop: true,
    focusable: false,
    frame: false,
    hasShadow: false,
    resizable: false,
    show: false,
    skipTaskbar: true,
    backgroundColor: "#ffffff",
    opacity: FLASH_PEAK_OPACITY,
    transparent: false,
  });
  window.setIgnoreMouseEvents(true);
  return window;
}

export class SnapShotFlash {
  private flashWindow: Electron.BaseWindow | undefined;
  private animationTimer: ReturnType<typeof setInterval> | undefined;
  private closeTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly showWindow: (window: Electron.BaseWindow) => void;

  constructor(
    showWindow: (window: Electron.BaseWindow) => void = (window) => window.showInactive(),
  ) {
    this.showWindow = showWindow;
  }

  showAnimated(bounds: Electron.Rectangle): Promise<void> {
    return this.show(bounds, true, FLASH_ANIMATION_DURATION_MS);
  }

  showStatic(bounds: Electron.Rectangle): Promise<void> {
    return this.show(bounds, false, FLASH_STATIC_DURATION_MS);
  }

  dispose(): void {
    if (this.animationTimer) clearInterval(this.animationTimer);
    if (this.closeTimer) clearTimeout(this.closeTimer);
    this.animationTimer = undefined;
    this.closeTimer = undefined;
    if (this.flashWindow && !this.flashWindow.isDestroyed()) this.flashWindow.destroy();
    this.flashWindow = undefined;
  }

  private async show(
    bounds: Electron.Rectangle,
    animated: boolean,
    durationMs: number,
  ): Promise<void> {
    this.dispose();
    const window = createSnapShotFlashWindow(bounds);
    this.flashWindow = window;
    if (window.isDestroyed()) return;
    this.showWindow(window);
    if (animated) {
      let opacity = FLASH_PEAK_OPACITY;
      this.animationTimer = setInterval(() => {
        if (window.isDestroyed()) return this.dispose();
        opacity = Math.max(
          0,
          opacity - (FLASH_PEAK_OPACITY * FLASH_FRAME_INTERVAL_MS) / durationMs,
        );
        window.setOpacity(opacity);
      }, FLASH_FRAME_INTERVAL_MS);
    }
    this.closeTimer = setTimeout(() => {
      if (this.flashWindow === window) this.dispose();
    }, durationMs);
  }
}

export function snapShotFlashBounds(
  active: ActiveWindow | undefined,
  platform: NodeJS.Platform,
): Electron.Rectangle {
  if (!active) return Electron.screen.getPrimaryDisplay().bounds;
  return platform === "win32"
    ? Electron.screen.screenToDipRect(null, active.bounds)
    : active.bounds;
}

export async function showCaptureFeedback(
  transition: SnapShotTransition,
  flash: SnapShotFlash,
  captureId: string,
  snapshotDataUrl: string,
  settings: ClientSettings,
  active: ActiveWindow | undefined,
  platform: NodeJS.Platform,
  destinationWindowBounds?: Electron.Rectangle,
): Promise<boolean> {
  // Wayland does not let this client position overlays on another app's window.
  if (platform === "linux") return false;
  const bounds = snapShotFlashBounds(active, platform);
  const animationsEnabled =
    settings.snapShotAnimations &&
    shouldAnimateSnapShot(Electron.systemPreferences.getAnimationSettings());
  if (animationsEnabled) {
    try {
      await transition.begin(
        captureId,
        bounds,
        snapshotDataUrl,
        settings.snapShotFlash,
        destinationWindowBounds,
      );
      return true;
    } catch {
      transition.dispose();
    }
  }
  if (!settings.snapShotFlash) return false;
  const playback = animationsEnabled ? flash.showAnimated(bounds) : flash.showStatic(bounds);
  await playback.catch(() => undefined);
  return false;
}

export function observedPairMessage(
  shortcut: SnapShotModifierPairShortcut,
  platform: NodeJS.Platform,
): string {
  const modifier = snapShotShortcutModifierPair(shortcut);
  const label = snapShotModifierPairLabel(modifier, platform === "darwin");
  const base = `${label} is observed and cannot be reserved exclusively.`;
  if (modifier === "meta" && platform !== "darwin") {
    return `${base} This key can also open the system's own menu.`;
  }
  if (modifier === "alt" && platform === "win32") {
    return `${base} This key can also activate app menu bars.`;
  }
  return base;
}

export function probeGlobalShortcut(accelerator: string): DesktopSnapShotShortcutAvailability {
  try {
    if (!Electron.globalShortcut.register(accelerator, () => undefined)) {
      return {
        available: false,
        message: "This shortcut is already used by the system or another app.",
      };
    }
    Electron.globalShortcut.unregister(accelerator);
    return { available: true, message: null };
  } catch {
    return { available: false, message: "The system could not register this shortcut." };
  }
}
