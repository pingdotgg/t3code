import * as Context from "effect/Context"
import type { DiscordPostOptions } from "../DiscordChat.ts"

/** @internal */
export const CurrentPostOptions = Context.Reference<DiscordPostOptions>("@effect/chat-discord/CurrentPostOptions", {
  defaultValue: () => ({})
})

/** Discord's `SUPPRESS_EMBEDS` message flag. */
const SUPPRESS_EMBEDS = 1 << 2

/**
 * The `allowed_mentions` for a write: nobody, unless `notify` says otherwise.
 *
 * @internal
 */
export const allowedMentions = (notify: DiscordPostOptions["notify"]) => ({
  parse: notify?.everyone === true ? ["everyone" as const] : [],
  users: notify?.users ?? [],
  roles: notify?.roles ?? [],
  replied_user: notify?.repliedUser === true
})

/**
 * The flags for a write.
 *
 * @internal
 */
export const flags = (options: DiscordPostOptions): number => options.suppressEmbeds === false ? 0 : SUPPRESS_EMBEDS
