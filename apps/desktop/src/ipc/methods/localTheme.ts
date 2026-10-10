import { DesktopLocalThemeStateSchema } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as DesktopLocalTheme from "../../theme/DesktopLocalTheme.ts";
import * as IpcChannels from "../channels.ts";
import { makeIpcMethod } from "../DesktopIpc.ts";

export const getLocalTheme = makeIpcMethod({
  channel: IpcChannels.GET_LOCAL_THEME_CHANNEL,
  payload: Schema.Void,
  result: DesktopLocalThemeStateSchema,
  handler: Effect.fn("desktop.ipc.localTheme.get")(function* () {
    return yield* (yield* DesktopLocalTheme.DesktopLocalTheme).current;
  }),
});
