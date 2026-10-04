import { DesktopDictationInput, DesktopDictationResult } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as DesktopDictation from "../../voice/DesktopDictation.ts";
import * as DesktopIpc from "../DesktopIpc.ts";
import * as IpcChannels from "../channels.ts";

export const dictation = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.DICTATION_CHANNEL,
  payload: DesktopDictationInput,
  result: DesktopDictationResult,
  handler: Effect.fn("desktop.ipc.dictation")(function* (input, event) {
    const service = yield* DesktopDictation.DesktopDictation;
    return yield* service.execute(input, event?.sender.id ?? -1);
  }),
});
