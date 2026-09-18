import { requestTerminalPermission as requestPermission } from "../../terminal/terminalPermissions.ts";
import { ExternalTerminalId, OpenExternalTerminalInput } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { DesktopEnvironment } from "../../app/DesktopEnvironment.ts";
import { launchExternalTerminal } from "../../terminal/externalTerminal.ts";
import * as DesktopIpc from "../DesktopIpc.ts";
import * as IpcChannels from "../channels.ts";

export const openTerminal = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.OPEN_TERMINAL_CHANNEL,
  payload: OpenExternalTerminalInput,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.openTerminal")(function* (input) {
    const { platform } = yield* DesktopEnvironment;
    yield* launchExternalTerminal(input, platform);
  }),
});

export const requestTerminalPermission = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.REQUEST_TERMINAL_PERMISSION_CHANNEL,
  payload: ExternalTerminalId,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.requestTerminalPermission")(function* (terminal) {
    const { platform } = yield* DesktopEnvironment;
    yield* requestPermission(terminal, platform);
  }),
});
