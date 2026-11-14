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

export const MAX_CAPTURE_WIDTH = 2_560;
export const MAX_CAPTURE_HEIGHT = 1_600;
export const SHORTCUT_COOLDOWN_NS = 200_000_000n;
export const WAYLAND_MODIFIER_PAIR_UNAVAILABLE_MESSAGE =
  "Modifier-pair shortcuts aren't available in this Wayland session. Choose another shortcut or use Take snapshot from the command palette.";
export const FLASH_ANIMATION_DURATION_MS = 180;
export const FLASH_STATIC_DURATION_MS = 60;
export const FLASH_FRAME_INTERVAL_MS = 16;
export const FLASH_PEAK_OPACITY = 0.08;
export const MAC_SCREEN_CAPTURE_SETTINGS_URL = MAC_PERMISSION_SETTINGS_URLS["screen-recording"];
export const MAC_SCREEN_CAPTURE_PERMISSION_MESSAGE =
  "Allow Screen Recording in System Settings, then restart T3 Code.";
export const MAC_ACCESSIBILITY_PERMISSION_MESSAGE =
  "Allow Accessibility in System Settings, then restart T3 Code.";
export const MAC_BOTH_PERMISSIONS_MESSAGE =
  "Allow Accessibility and Screen Recording in System Settings, then restart T3 Code.";
export const MAC_PERMISSION_MESSAGES = new Set([
  MAC_SCREEN_CAPTURE_PERMISSION_MESSAGE,
  MAC_ACCESSIBILITY_PERMISSION_MESSAGE,
  MAC_BOTH_PERMISSIONS_MESSAGE,
]);

export const decodePendingCapture = Schema.decodeUnknownEffect(DesktopPendingSnapShot);

export const PendingCaptureJson = Schema.fromJsonString(DesktopPendingSnapShot);
export const decodePendingCaptureJson = Schema.decodeEffect(PendingCaptureJson);
export const encodePendingCaptureJson = Schema.encodeEffect(PendingCaptureJson);
export const DesktopSnapShotOperation = Schema.Literals([
  "list-pending",
  "read",
  "acknowledge",
  "unsupported",
  "disabled",
  "no-window-selected",
  "window-unavailable",
  "setup-required",
  "capture",
]);

export class DesktopSnapShotError extends Schema.TaggedError<DesktopSnapShotError>()(
  "DesktopSnapShotError",
  {
    operation: DesktopSnapShotOperation,
    captureId: Schema.optional(Schema.String),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    switch (this.operation) {
      case "list-pending":
        return "Could not list pending snapshots.";
      case "read":
        return "Could not read the snapshot.";
      case "acknowledge":
        return "Could not remove the snapshot.";
      case "unsupported":
        return "SnapShots are not supported here.";
      case "disabled":
        return "Enable SnapShots in Settings first.";
      case "no-window-selected":
        return "No window was selected.";
      case "window-unavailable":
        return "The active window is not available for capture.";
      case "setup-required":
        return "Finish SnapShot setup in Settings → SnapShots.";
      case "capture":
        return "Could not capture the active window.";
    }
  }
}

export const isDesktopSnapShotError = Schema.is(DesktopSnapShotError);

export function captureFailure(cause: unknown, captureId?: string): DesktopSnapShotError {
  if (isDesktopSnapShotError(cause)) return cause;
  const operation = cause instanceof CaptureSetupRequiredError ? "setup-required" : "capture";
  return new DesktopSnapShotError({ operation, captureId, cause });
}

export class DesktopSnapShot extends Context.Service<
  DesktopSnapShot,
  {
    readonly initialize: Effect.Effect<void>;
    readonly configure: (settings: ClientSettings) => Effect.Effect<void>;
    readonly requestPermissions: (includeAccessibility: boolean) => Effect.Effect<void>;
    readonly state: Effect.Effect<DesktopSnapShotState>;
    readonly setup: (
      action: DesktopSnapShotSetupAction,
    ) => Effect.Effect<void, DesktopSnapShotSetupError>;
    readonly previewConfig: (
      request: DesktopCaptureConfigRequest,
      selectedPath?: string,
    ) => Effect.Effect<DesktopCaptureConfigPreview, DesktopSnapShotSetupError>;
    readonly applyConfig: (
      previewId: string,
    ) => Effect.Effect<DesktopCaptureConfigApplied, DesktopSnapShotSetupError>;
    readonly checkShortcut: (
      shortcut: SnapShotShortcut,
    ) => Effect.Effect<DesktopSnapShotShortcutAvailability>;
    readonly setShortcutSuppressed: (suppressed: boolean) => Effect.Effect<void>;
    readonly capture: Effect.Effect<void, DesktopSnapShotError>;
    readonly listPending: Effect.Effect<
      ReadonlyArray<DesktopPendingSnapShot>,
      DesktopSnapShotError
    >;
    readonly read: (id: string) => Effect.Effect<DesktopSnapShotValue, DesktopSnapShotError>;
    readonly setAnimationDestination: (
      id: string,
      destination: SnapShotAnimationDestination,
    ) => Effect.Effect<void>;
    readonly dismissAnimation: (id: string) => Effect.Effect<void>;
    readonly acknowledge: (id: string) => Effect.Effect<void, DesktopSnapShotError>;
  }
>()("@t3tools/desktop/snapShot/DesktopSnapShotContracts/DesktopSnapShot") {}

export class DesktopSnapShotSetupError extends Schema.TaggedError<DesktopSnapShotSetupError>()(
  "DesktopSnapShotSetupError",
  {
    action: Schema.Union([
      DesktopSnapShotSetupAction,
      Schema.Literals(["preview-config", "apply-config"]),
    ]),
    reason: Schema.Literals(["unsupported-session", "setup-failed", "shortcut-permissions"]),
    step: Schema.optional(Schema.Literals(["find-window", "capture-window"])),
    status: Schema.optional(Schema.Literals(["missing", "timed-out", "exited", "failed"])),
    exitCode: Schema.optional(Schema.Number),
    /** The running app, as macOS lists it under Privacy & Security. */
    appName: Schema.optional(Schema.String),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    if (this.action === "test-mac-capture") {
      if (this.reason === "unsupported-session") return "Test capture requires macOS.";
      const summary = "Could not capture a test snapshot.";
      if (this.step === undefined) return summary;
      if (this.status === "missing") return `${summary} No window is available to capture.`;
      const [task, command] =
        this.step === "find-window"
          ? ["Finding the front window", "osascript"]
          : ["Capturing the window", "screencapture"];
      const failure =
        this.status === "timed-out"
          ? `${task} timed out.`
          : this.status === "exited" && this.exitCode !== undefined
            ? `${task} failed: ${command} exited with code ${this.exitCode}.`
            : `${task} failed.`;
      // macOS can report both permissions as allowed while they belong to another install.
      return this.appName === undefined
        ? `${summary} ${failure}`
        : `${summary} ${failure} macOS grants Screen Recording and Accessibility to each app separately. In System Settings, open Privacy & Security and check that "${this.appName}" is allowed for both.`;
    }
    if (this.action === "preview-config" || this.action === "apply-config") {
      if (this.reason === "unsupported-session")
        return "Config setup requires a Niri or Hyprland session.";
      return this.action === "preview-config"
        ? "Couldn't prepare your capture shortcut changes."
        : "Couldn't save your capture shortcut.";
    }
    const kde = this.action === "install-kde-helper" || this.action === "remove-kde-helper";
    const hyprland =
      this.action === "install-hyprland-helper" || this.action === "remove-hyprland-helper";
    if (this.reason === "unsupported-session")
      return hyprland
        ? "Helper setup requires a Hyprland Wayland session outside a sandbox."
        : kde
          ? "Helper setup requires a KDE Plasma Wayland session outside a sandbox."
          : "Extension setup requires a GNOME Wayland session outside a sandbox.";
    if (this.reason === "shortcut-permissions") return "Could not open shortcut permissions.";
    return hyprland
      ? "Could not set up Hyprland capture."
      : kde
        ? "Could not set up KDE capture."
        : "Could not set up the GNOME extension.";
  }
}
