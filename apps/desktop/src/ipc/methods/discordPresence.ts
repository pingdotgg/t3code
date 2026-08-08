import { DesktopDiscordPresenceInputSchema } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as DesktopDiscordPresence from "../../discord/DesktopDiscordPresence.ts";
import * as IpcChannels from "../channels.ts";
import * as DesktopIpc from "../DesktopIpc.ts";

export const getDiscordRichPresenceAvailable = DesktopIpc.makeSyncIpcMethod({
  channel: IpcChannels.GET_DISCORD_RICH_PRESENCE_AVAILABLE_CHANNEL,
  result: Schema.Boolean,
  handler: Effect.fn("desktop.ipc.discordPresence.available")(function* () {
    const presence = yield* DesktopDiscordPresence.DesktopDiscordPresence;
    return presence.available;
  }),
});

export const setDiscordRichPresence = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.SET_DISCORD_RICH_PRESENCE_CHANNEL,
  payload: DesktopDiscordPresenceInputSchema,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.discordPresence.set")(function* ({ activeProjectCount }) {
    const presence = yield* DesktopDiscordPresence.DesktopDiscordPresence;
    yield* presence.setActiveProjectCount(activeProjectCount);
  }),
});
