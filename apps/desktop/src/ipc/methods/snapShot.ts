import {
  DesktopPendingSnapShot,
  DesktopSnapShot as DesktopSnapShotSchema,
  DesktopSnapShotAnimationDestination,
  DesktopSnapShotId,
  DesktopSnapShotShortcutAvailability,
  DesktopSnapShotState,
  DesktopSnapShotSetupAction,
  SnapShotShortcut,
  DesktopCaptureConfigRequest,
  DesktopCaptureConfigPreview,
  DesktopCaptureConfigApplied,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as Electron from "electron";

import * as ElectronWindow from "../../electron/ElectronWindow.ts";
import * as ElectronDialog from "../../electron/ElectronDialog.ts";
import * as DesktopSnapShot from "../../snapShot/DesktopSnapShot.ts";
import * as IpcChannels from "../channels.ts";
import * as DesktopIpc from "../DesktopIpc.ts";

class SnapShotIpcUnauthorizedSenderError extends Schema.TaggedError<SnapShotIpcUnauthorizedSenderError>()(
  "SnapShotIpcUnauthorizedSenderError",
  {},
) {
  override get message(): string {
    return "Snapshot request was rejected.";
  }
}

const ensureTrustedSnapShotSender = Effect.fn("desktop.ipc.snapShot.ensureTrustedSender")(
  function* (event: DesktopIpc.DesktopIpcInvokeEvent | undefined) {
    const main = yield* (yield* ElectronWindow.ElectronWindow).main;
    if (
      event === undefined ||
      Option.isNone(main) ||
      main.value.webContents.id !== event.sender.id
    ) {
      return yield* new SnapShotIpcUnauthorizedSenderError();
    }
    return main.value;
  },
);

export function snapShotScreenFrame(
  viewportFrame: DesktopSnapShotAnimationDestination["viewportFrame"],
  contentBounds: Electron.Rectangle,
  zoomFactor: number,
): Electron.Rectangle {
  return {
    x: contentBounds.x + viewportFrame.x * zoomFactor,
    y: contentBounds.y + viewportFrame.y * zoomFactor,
    width: viewportFrame.width * zoomFactor,
    height: viewportFrame.height * zoomFactor,
  };
}

export function snapShotRelativeFrame(
  frame: DesktopSnapShotAnimationDestination["viewportFrame"],
  bounds: Electron.Rectangle,
  zoom: number,
): Electron.Rectangle | undefined {
  if (bounds.width <= 0 || bounds.height <= 0) return undefined;
  return {
    x: (frame.x * zoom) / bounds.width,
    y: (frame.y * zoom) / bounds.height,
    width: (frame.width * zoom) / bounds.width,
    height: (frame.height * zoom) / bounds.height,
  };
}

export const getSnapShotState = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.GET_SNAP_SHOT_STATE_CHANNEL,
  payload: Schema.Void,
  result: DesktopSnapShotState,
  handler: Effect.fn("desktop.ipc.snapShot.getState")(function* () {
    return yield* (yield* DesktopSnapShot.DesktopSnapShot).state;
  }),
});

export const requestSnapShotPermissions = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.REQUEST_SNAP_SHOT_PERMISSIONS_CHANNEL,
  payload: Schema.Boolean,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.snapShot.requestPermissions")(
    function* (includeAccessibility, event) {
      yield* ensureTrustedSnapShotSender(event);
      yield* (yield* DesktopSnapShot.DesktopSnapShot).requestPermissions(includeAccessibility);
    },
  ),
});

export const setupSnapShot = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.SETUP_SNAP_SHOT_CHANNEL,
  payload: DesktopSnapShotSetupAction,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.snapShot.setup")(function* (action, event) {
    yield* ensureTrustedSnapShotSender(event);
    yield* (yield* DesktopSnapShot.DesktopSnapShot).setup(action);
  }),
});

export const previewSnapShotConfig = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.PREVIEW_SNAP_SHOT_CONFIG_CHANNEL,
  payload: DesktopCaptureConfigRequest,
  result: Schema.NullOr(DesktopCaptureConfigPreview),
  handler: Effect.fn("desktop.ipc.snapShot.previewConfig")(function* (request, event) {
    const window = yield* ensureTrustedSnapShotSender(event);
    const capture = yield* DesktopSnapShot.DesktopSnapShot;
    let selectedPath: string | undefined;
    if (request.chooseFile) {
      const state = yield* capture.state;
      const paths = yield* (yield* ElectronDialog.ElectronDialog).pickFiles({
        owner: Option.some(window),
        defaultPath: Option.fromUndefinedOr(state.shortcutConfigPath),
        filters: [
          {
            name: "Desktop config",
            extensions: state.linuxBackend === "niri" ? ["kdl"] : ["conf", "lua"],
          },
        ],
        multiple: false,
      });
      selectedPath = paths[0];
      if (!selectedPath) return null;
    }
    return yield* capture.previewConfig(request, selectedPath);
  }),
});

export const applySnapShotConfig = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.APPLY_SNAP_SHOT_CONFIG_CHANNEL,
  payload: DesktopSnapShotId,
  result: DesktopCaptureConfigApplied,
  handler: Effect.fn("desktop.ipc.snapShot.applyConfig")(function* (id, event) {
    yield* ensureTrustedSnapShotSender(event);
    return yield* (yield* DesktopSnapShot.DesktopSnapShot).applyConfig(id);
  }),
});

export const checkSnapShotShortcut = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.CHECK_SNAP_SHOT_SHORTCUT_CHANNEL,
  payload: SnapShotShortcut,
  result: DesktopSnapShotShortcutAvailability,
  handler: Effect.fn("desktop.ipc.snapShot.checkShortcut")(function* (shortcut, event) {
    yield* ensureTrustedSnapShotSender(event);
    return yield* (yield* DesktopSnapShot.DesktopSnapShot).checkShortcut(shortcut);
  }),
});

export const setSnapShotShortcutSuppressed = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.SET_SNAP_SHOT_SHORTCUT_SUPPRESSED_CHANNEL,
  payload: Schema.Boolean,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.snapShot.setShortcutSuppressed")(function* (suppressed, event) {
    yield* ensureTrustedSnapShotSender(event);
    yield* (yield* DesktopSnapShot.DesktopSnapShot).setShortcutSuppressed(suppressed);
  }),
});

export const listPendingSnapShots = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.LIST_PENDING_SNAP_SHOTS_CHANNEL,
  payload: Schema.Void,
  result: Schema.Array(DesktopPendingSnapShot),
  handler: Effect.fn("desktop.ipc.snapShot.listPending")(function* (_, event) {
    yield* ensureTrustedSnapShotSender(event);
    return yield* (yield* DesktopSnapShot.DesktopSnapShot).listPending;
  }),
});

export const readSnapShot = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.READ_SNAP_SHOT_CHANNEL,
  payload: DesktopSnapShotId,
  result: DesktopSnapShotSchema,
  handler: Effect.fn("desktop.ipc.snapShot.read")(function* (id, event) {
    yield* ensureTrustedSnapShotSender(event);
    return yield* (yield* DesktopSnapShot.DesktopSnapShot).read(id);
  }),
});

export const setSnapShotAnimationDestination = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.SET_SNAP_SHOT_ANIMATION_DESTINATION_CHANNEL,
  payload: DesktopSnapShotAnimationDestination,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.snapShot.setAnimationDestination")(
    function* (destination, event) {
      const window = yield* ensureTrustedSnapShotSender(event);
      if (
        destination.viewportFrame.width <= 0 ||
        destination.viewportFrame.height <= 0 ||
        destination.borderWidth < 0 ||
        destination.cornerRadius < 0
      ) {
        return;
      }
      yield* (yield* DesktopSnapShot.DesktopSnapShot).setAnimationDestination(destination.id, {
        relativeFrame: snapShotRelativeFrame(
          destination.viewportFrame,
          window.getContentBounds(),
          window.webContents.getZoomFactor(),
        ),
        frame: snapShotScreenFrame(
          destination.viewportFrame,
          window.getContentBounds(),
          window.webContents.getZoomFactor(),
        ),
        backgroundColor: destination.backgroundColor,
        borderColor: destination.borderColor,
        borderWidth: destination.borderWidth * window.webContents.getZoomFactor(),
        cornerRadius: destination.cornerRadius * window.webContents.getZoomFactor(),
        scaleFactor: window.webContents.getZoomFactor(),
        details: destination.details,
      });
    },
  ),
});

export const dismissSnapShotAnimation = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.DISMISS_SNAP_SHOT_ANIMATION_CHANNEL,
  payload: DesktopSnapShotId,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.snapShot.dismissAnimation")(function* (id, event) {
    yield* ensureTrustedSnapShotSender(event);
    yield* (yield* DesktopSnapShot.DesktopSnapShot).dismissAnimation(id);
  }),
});

export const acknowledgeSnapShot = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.ACKNOWLEDGE_SNAP_SHOT_CHANNEL,
  payload: DesktopSnapShotId,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.snapShot.acknowledge")(function* (id, event) {
    yield* ensureTrustedSnapShotSender(event);
    yield* (yield* DesktopSnapShot.DesktopSnapShot).acknowledge(id);
  }),
});
