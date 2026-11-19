import {
  ComputerHostReply,
  DesktopComputerAnswerSchema,
  DesktopComputerFrameInputSchema,
  DesktopComputerOfferSchema,
  DesktopComputerPermissionsSchema,
  EnvironmentId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Electron from "electron";

import * as DesktopEnvironment from "../../app/DesktopEnvironment.ts";
import * as DesktopComputerHost from "../../computer/DesktopComputerHost.ts";
import * as ElectronWindow from "../../electron/ElectronWindow.ts";
import * as IpcChannels from "../channels.ts";
import * as DesktopIpc from "../DesktopIpc.ts";

/**
 * The helper's calls reach the main window's renderer, the only side holding an environment's
 * connection; they carry screen text and typed text, so no other window gets them. With no window
 * to answer, a call fails at once instead of holding the helper until its deadline.
 */
export const installComputerCallForwarding = Effect.fn(
  "desktop.ipc.computer.installCallForwarding",
)(function* () {
  const electronWindow = yield* ElectronWindow.ElectronWindow;
  const host = yield* DesktopComputerHost.DesktopComputerHost;
  yield* Stream.runForEach(
    host.calls,
    // One call per helper step; the host's own spans already cover them.
    Effect.fnUntraced(function* (call) {
      const main = yield* electronWindow.main;
      const contents = Option.isSome(main) ? main.value.webContents : null;
      if (contents === null || contents.isDestroyed()) {
        return yield* host.answer({
          type: "failed",
          callId: call.callId,
          message: "The app window is closed.",
        });
      }
      contents.send(IpcChannels.COMPUTER_HOST_CALL_CHANNEL, call);
    }),
  ).pipe(Effect.forkScoped);
});

// The renderer that offered this computer to each environment. Closing its window withdraws the
// offer, since that renderer held the environment's connection.
const offeredBy = new Map<number, Set<EnvironmentId>>();

const withdrawWhenClosed = (
  senderId: number,
  environmentId: EnvironmentId,
  host: DesktopComputerHost.DesktopComputerHost["Service"],
) => {
  const offered = offeredBy.get(senderId);
  if (offered !== undefined) {
    offered.add(environmentId);
    return;
  }
  const contents = Electron.webContents.fromId(senderId);
  if (contents === undefined || contents.isDestroyed()) return;
  const environments = new Set([environmentId]);
  offeredBy.set(senderId, environments);
  contents.once("destroyed", () => {
    offeredBy.delete(senderId);
    for (const id of environments) Effect.runSync(host.disconnect(id));
  });
};

const prepareComputerHost = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.COMPUTER_HOST_PREPARE_CHANNEL,
  payload: EnvironmentId,
  result: DesktopComputerOfferSchema,
  handler: Effect.fn("desktop.ipc.computer.prepare")(function* (environmentId, event) {
    const host = yield* DesktopComputerHost.DesktopComputerHost;
    if (event !== undefined) withdrawWhenClosed(event.sender.id, environmentId, host);
    return yield* host.prepare(environmentId);
  }),
});

const sendComputerHostFrame = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.COMPUTER_HOST_FRAME_CHANNEL,
  payload: DesktopComputerFrameInputSchema,
  result: Schema.NullOr(ComputerHostReply),
  handler: Effect.fn("desktop.ipc.computer.frame")(function* ({ environmentId, frame }) {
    const host = yield* DesktopComputerHost.DesktopComputerHost;
    return yield* host.frame(environmentId, frame);
  }),
});

const disconnectComputerHost = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.COMPUTER_HOST_DISCONNECT_CHANNEL,
  payload: EnvironmentId,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.computer.disconnect")(function* (environmentId) {
    const host = yield* DesktopComputerHost.DesktopComputerHost;
    yield* host.disconnect(environmentId);
  }),
});

const answerComputerHost = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.COMPUTER_HOST_ANSWER_CHANNEL,
  payload: DesktopComputerAnswerSchema,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.computer.answer")(function* (answer) {
    const host = yield* DesktopComputerHost.DesktopComputerHost;
    yield* host.answer(answer);
  }),
});

/** What the app's own process sees, which is the identity the forked helper runs under. */
const getComputerPermissions = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.COMPUTER_PERMISSIONS_CHANNEL,
  payload: Schema.Void,
  result: Schema.NullOr(DesktopComputerPermissionsSchema),
  handler: Effect.fn("desktop.ipc.computer.permissions")(function* () {
    const environment = yield* DesktopEnvironment.DesktopEnvironment;
    if (environment.platform !== "darwin") return null;
    return {
      accessibility: Electron.systemPreferences.isTrustedAccessibilityClient(false),
      screenRecording: Electron.systemPreferences.getMediaAccessStatus("screen") === "granted",
    };
  }),
});

export const methods = [
  prepareComputerHost,
  sendComputerHostFrame,
  disconnectComputerHost,
  answerComputerHost,
  getComputerPermissions,
] as const;
