import { DesktopRendererStateKeySchema, DesktopRendererStateWriteSchema } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as DesktopRendererState from "../../settings/DesktopRendererState.ts";
import * as IpcChannels from "../channels.ts";
import * as DesktopIpc from "../DesktopIpc.ts";

export const getRendererState = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.GET_RENDERER_STATE_CHANNEL,
  payload: DesktopRendererStateKeySchema,
  result: Schema.NullOr(Schema.String),
  handler: Effect.fn("desktop.ipc.rendererState.get")(function* (key) {
    const rendererState = yield* DesktopRendererState.DesktopRendererState;
    return Option.getOrNull(yield* rendererState.get(key));
  }),
});

export const setRendererState = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.SET_RENDERER_STATE_CHANNEL,
  payload: DesktopRendererStateWriteSchema,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.rendererState.set")(function* ({ key, value }) {
    const rendererState = yield* DesktopRendererState.DesktopRendererState;
    yield* rendererState.set(key, value);
  }),
});
