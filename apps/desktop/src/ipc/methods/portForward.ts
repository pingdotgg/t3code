import {
  DesktopPortForwardAuthorizationResolution,
  DesktopPortForwardCreateInput,
  DesktopPortForwardSnapshot,
  DesktopPortForwardStopEnvironmentInput,
  DesktopPortForwardStopInput,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as ElectronWindow from "../../electron/ElectronWindow.ts";
import * as DesktopPortForwardManager from "../../portForward/DesktopPortForwardManager.ts";
import * as IpcChannels from "../channels.ts";
import * as DesktopIpc from "../DesktopIpc.ts";

export const installPortForwardEventForwarding = Effect.fn(
  "desktop.ipc.portForward.installEventForwarding",
)(function* () {
  const electronWindow = yield* ElectronWindow.ElectronWindow;
  const manager = yield* DesktopPortForwardManager.DesktopPortForwardManager;
  yield* manager.subscribeStateChanges((snapshots) =>
    electronWindow.sendAll(IpcChannels.PORT_FORWARD_STATE_CHANNEL, snapshots),
  );
  yield* manager.subscribeAuthorizationRequests((request) =>
    electronWindow.sendAll(IpcChannels.PORT_FORWARD_AUTHORIZATION_REQUEST_CHANNEL, request),
  );
});

export const createPortForward = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.PORT_FORWARD_CREATE_CHANNEL,
  payload: DesktopPortForwardCreateInput,
  result: DesktopPortForwardSnapshot,
  handler: Effect.fn("desktop.ipc.portForward.create")(function* (input) {
    const manager = yield* DesktopPortForwardManager.DesktopPortForwardManager;
    return yield* manager.create(input);
  }),
});

export const listPortForwards = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.PORT_FORWARD_LIST_CHANNEL,
  payload: Schema.Void,
  result: Schema.Array(DesktopPortForwardSnapshot),
  handler: Effect.fn("desktop.ipc.portForward.list")(function* () {
    const manager = yield* DesktopPortForwardManager.DesktopPortForwardManager;
    return yield* manager.list;
  }),
});

export const stopPortForward = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.PORT_FORWARD_STOP_CHANNEL,
  payload: DesktopPortForwardStopInput,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.portForward.stop")(function* ({ id }) {
    const manager = yield* DesktopPortForwardManager.DesktopPortForwardManager;
    yield* manager.stop(id);
  }),
});

export const stopEnvironmentPortForwards = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.PORT_FORWARD_STOP_ENVIRONMENT_CHANNEL,
  payload: DesktopPortForwardStopEnvironmentInput,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.portForward.stopEnvironment")(function* ({ environmentId }) {
    const manager = yield* DesktopPortForwardManager.DesktopPortForwardManager;
    yield* manager.stopEnvironment(environmentId);
  }),
});

export const resolvePortForwardAuthorization = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.PORT_FORWARD_RESOLVE_AUTHORIZATION_CHANNEL,
  payload: DesktopPortForwardAuthorizationResolution,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.portForward.resolveAuthorization")(function* ({
    requestId,
    socketUrl,
    error,
  }) {
    const manager = yield* DesktopPortForwardManager.DesktopPortForwardManager;
    yield* manager.resolveAuthorization(requestId, socketUrl, error);
  }),
});
