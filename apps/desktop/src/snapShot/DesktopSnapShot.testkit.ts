// @effect-diagnostics nodeBuiltinImport:off - the test kit mirrors Node built-ins for the snap shot tests.
import {
  activeWindowMock,
  animationSettingsMock,
  accessibilityProcessReadMock,
  accessibilityByPidMock,
  accessibilityListMock,
  accessibilityForegroundMock,
  accessibilityTrustedMock,
  allWindowsMock,
  flashWindows,
  focusedWindowMock,
  getSourcesMock,
  macCaptureMock,
  linuxCaptureMock,
  linuxBackendMock,
  niriShortcutMock,
  niriShortcutStopMock,
  mediaAccessStatusMock,
  registerShortcutMock,
  unregisterShortcutMock,
  portalShortcutInstances,
  prepareCaptureRevealMock,
  nextPortalState,
  regionCaptureMock,
  screenToDipRectMock,
  transitionCapturePageMock,
  transitionScriptState,
  transitionSnapshotMock,
} from "./DesktopSnapShot.mocks.ts";


import * as MacPermissions from "../permissions/MacPermissions.ts";
import { assert, it } from "@effect/vitest";
import {
  DEFAULT_CLIENT_SETTINGS,
  DesktopPendingSnapShot,
  type ClientSettings,
  type DesktopSnapShotEvent,
} from "@t3tools/contracts";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import type * as Electron from "electron";
import type { PortalShortcutState } from "./PortalCaptureShortcut.ts";
import { beforeEach, vi } from "vite-plus/test";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopClientSettings from "../settings/DesktopClientSettings.ts";
import * as DesktopWindow from "../window/DesktopWindow.ts";
import * as DesktopSnapShot from "./DesktopSnapShot.ts";
import * as SnapShotAccessibility from "./SnapShotAccessibility.ts";
import { CaptureSetupRequiredError } from "./linuxCaptureSession.ts";


export const accessibilityApp = {
  byPid: accessibilityByPidMock,
  list: accessibilityListMock,
  foreground: accessibilityForegroundMock,
} as unknown as Parameters<typeof SnapShotAccessibility.readAccessibleWindowContextWithApp>[0];
export const readAccessibleWindowContext = (
  active: SnapShotAccessibility.AccessibleWindowIdentity,
  platform: NodeJS.Platform,
  sourceTitle: string,
  imageSize: Electron.Size = {
    width: Math.max(1, Math.round(active.bounds.width)),
    height: Math.max(1, Math.round(active.bounds.height)),
  },
) =>
  SnapShotAccessibility.readAccessibleWindowContextWithApp(accessibilityApp, {
    active,
    platform,
    sourceTitle,
    imageSize,
  });
export const readAccessibleWindowText = async (
  active: SnapShotAccessibility.AccessibleWindowIdentity,
  platform: NodeJS.Platform,
  sourceTitle: string,
) => (await readAccessibleWindowContext(active, platform, sourceTitle))?.accessibleText;
accessibilityProcessReadMock.mockImplementation((request) => ({
  started: Promise.resolve(),
  result: readAccessibleWindowContext(
    request.active,
    request.platform,
    request.sourceTitle,
    request.imageSize,
  ),
}));
vi.mock("./GnomeCaptureSetup.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./GnomeCaptureSetup.ts")>()),
  GnomeCaptureSetup: class {
    state = async () => ({ status: "enabled" as const, message: "Extension running" });
    perform = async () => undefined;
    close = () => undefined;
  },
}));

export const decodePendingMetadata = Schema.decodeUnknownEffect(
  Schema.fromJsonString(DesktopPendingSnapShot),
);

import { SnapShotTransition, snapShotAnimationDisplayBounds } from "./SnapShotTransition.ts";
export const layerTest = (
  platform: NodeJS.Platform,
  fileSystemOverrides: Parameters<typeof FileSystem.layerNoop>[0] = {},
  initialSettings: Option.Option<ClientSettings> = Option.none(),
  settingsGet: Effect.Effect<
    Option.Option<ClientSettings>,
    DesktopClientSettings.DesktopClientSettingsReadError
  > = Effect.succeed(initialSettings),
) =>
  MacPermissions.layer.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        Layer.succeed(
          DesktopEnvironment.DesktopEnvironment,
          DesktopEnvironment.DesktopEnvironment.of({
            platform,
            displayName: "T3 Code (Dev)",
            stateDir: "/state",
            linuxDesktopEntryName: "com.t3tools.T3Code.desktop",
            appRoot: "/repo",
            linuxApplicationsDir: "/test-data/applications",
          } as DesktopEnvironment.DesktopEnvironment["Service"]),
        ),
        Layer.succeed(
          DesktopClientSettings.DesktopClientSettings,
          DesktopClientSettings.DesktopClientSettings.of({
            get: settingsGet,
            set: () => Effect.void,
          }),
        ),
        Layer.succeed(
          DesktopWindow.DesktopWindow,
          DesktopWindow.DesktopWindow.of({
            activate: Effect.void,
            prepareCaptureReveal: Effect.sync(prepareCaptureRevealMock),
            dispatchMenuAction: () => Effect.void,
            dispatchSnapShotEvent: () => Effect.void,
          } as unknown as DesktopWindow.DesktopWindow["Service"]),
        ),
        FileSystem.layerNoop(fileSystemOverrides),
        Path.layer,
        Layer.succeed(
          SecureRandom.SecureRandom,
          SecureRandom.make((size) => new Uint8Array(size)),
        ),
      ),
    ),
  );

export const enabledSettings = (overrides: Partial<ClientSettings> = {}): ClientSettings => ({
  ...DEFAULT_CLIENT_SETTINGS,
  snapShotEnabled: true,
  ...overrides,
});


