import type * as ChatEvent from "effect/chat/ChatEvent"
import type * as ChatMessage from "effect/chat/ChatMessage"
import type * as ChatThread from "effect/chat/ChatThread"
import * as DateTime from "effect/DateTime"
import type * as Schema from "effect/Schema"
import { isDirectChannel, thread } from "./address.ts"
import * as Emoji from "./emoji.ts"
import { isObject, type JsonObject, object, string } from "./json.ts"
import * as Mentions from "./mentions.ts"
import * as RichText from "./richText.ts"

/**
 * The message subtypes that count as a message, for inbound events and for
 * every read path alike. Anything else is rejected, so a subtype Slack adds
 * later stays out until someone decides about it.
 *
 * @internal
 */
export const messageSubtypes: ReadonlySet<string> = new Set([
  "file_share",
  "thread_broadcast",
  "bot_message",
  "me_message"
])

const tsPattern = /^\d+\.\d+$/

/** When a Slack `ts` was sent. @internal */
export const timestamp = (ts: string): DateTime.Utc => DateTime.makeUnsafe(Math.floor(Number(ts) * 1000))

/** @internal */
export interface MessageContext {
  readonly team: string
  readonly channel: string
  readonly botUserId: string
}

const authorName = (message: JsonObject): string | undefined => {
  const profile = object(message, "user_profile")
  return string(profile, "display_name") ?? string(profile, "real_name") ?? string(profile, "name") ??
    string(object(message, "bot_profile"), "name") ?? string(message, "username")
}

const attachments = (message: JsonObject): Array<ChatMessage.Attachment> => {
  const files = message.files
  if (!Array.isArray(files)) return []
  const out: Array<ChatMessage.Attachment> = []
  for (const file of files) {
    if (!isObject(file)) continue
    const id = string(file, "id")
    if (id === undefined) continue
    const name = string(file, "name")
    const contentType = string(file, "mimetype")
    const size = file.size
    out.push({
      id,
      ...(name === undefined ? {} : { name }),
      ...(contentType === undefined ? {} : { contentType }),
      ...(typeof size === "number" && Number.isSafeInteger(size) && size >= 0 ? { size } : {})
    })
  }
  return out
}

/**
 * A Slack message payload as a `ChatMessage`, from an event or any read
 * path. `undefined` when it is not a message: a subtype off the list, or no
 * author.
 *
 * - The address is the channel when `thread_ts` is missing or equal to
 *   `ts`, and the thread otherwise. It never depends on later replies.
 * - A `bot_message` has `bot_id` and no `user`: `author.id` is the
 *   `bot_id`, with `isBot` true.
 * - `text` is Slack's field as stored, except for a message the bot itself
 *   wrote that has a `rich_text` block. Its `text` is rendered from the
 *   blocks as Markdown, and its mentions are the mention elements outside
 *   code, at the offsets the renderer wrote. The adapter's own `text` is
 *   often cut, and the blocks hold the whole message. Slack's field stays on
 *   `raw`.
 *
 * @internal
 */
export const message = (raw: unknown, context: MessageContext): ChatMessage.ChatMessage | undefined => {
  if (!isObject(raw)) return undefined
  const subtype = string(raw, "subtype")
  if (subtype !== undefined && !messageSubtypes.has(subtype)) return undefined
  const ts = string(raw, "ts")
  if (ts === undefined || !tsPattern.test(ts)) return undefined
  const user = string(raw, "user")
  const botId = string(raw, "bot_id")
  const authorId = user ?? botId
  if (authorId === undefined) return undefined
  const threadTs = string(raw, "thread_ts")
  const isSelf = user !== undefined && user === context.botUserId
  const rendered = isSelf && Array.isArray(raw.blocks) && RichText.hasRichText(raw.blocks)
    ? RichText.render(raw.blocks, context.botUserId)
    : undefined
  const text = rendered?.text ?? (typeof raw.text === "string" ? raw.text : "")
  const name = authorName(raw)
  return {
    id: ts,
    thread: thread({
      team: context.team,
      channel: context.channel,
      threadTs: threadTs === undefined || threadTs === ts ? undefined : threadTs
    }),
    author: {
      id: authorId,
      ...(name === undefined ? {} : { name }),
      isBot: botId !== undefined || subtype === "bot_message" || user === context.botUserId,
      isSelf
    },
    text,
    mentions: rendered === undefined ? Mentions.extract(text, raw.blocks, context.botUserId) : [...rendered.mentions],
    attachments: attachments(raw),
    timestamp: timestamp(ts),
    raw
  }
}

const kindOf = (address: ChatThread.ChatThread, channel: string, channelType: string | undefined) => {
  if (address.id.split("/").length === 3) return "thread" as const
  return channelType === "im" || channelType === "mpim" || isDirectChannel(channel)
    ? "direct" as const
    : "channel" as const
}

const forWorkspace = (envelope: JsonObject, teamId: string): boolean => {
  if (envelope.team_id === teamId) return true
  const authorizations = envelope.authorizations
  return Array.isArray(authorizations) &&
    authorizations.some((authorization) => isObject(authorization) && authorization.team_id === teamId)
}

/** The envelope as `raw`, without the deprecated verification `token`. */
const envelopeRaw = (envelope: JsonObject): Schema.Json => {
  if (!("token" in envelope)) return envelope
  const { token: _, ...rest } = envelope
  return rest
}

/** An emoji name as Slack writes it, as Unicode, or `custom:{name}`. @internal */
export const emoji = (name: string): string => Emoji.fromName(name) ?? `custom:${name}`

/**
 * The events in an `event_callback` envelope.
 *
 * @internal
 */
export const normalize = (
  envelope: unknown,
  context: { readonly teamId: string; readonly botUserId: string }
): ReadonlyArray<ChatEvent.ChatEvent> => {
  if (!isObject(envelope) || envelope.type !== "event_callback") return []
  if (!forWorkspace(envelope, context.teamId)) return []
  const event = envelope.event
  if (!isObject(event)) return []
  const raw = envelopeRaw(envelope)
  const team = context.teamId
  switch (event.type) {
    case "message":
    case "app_mention": {
      if (event.type === "app_mention" && event.edited !== undefined) return []
      const channel = string(event, "channel")
      if (channel === undefined) return []
      const normalized = message(event, { team, channel, botUserId: context.botUserId })
      if (normalized === undefined) return []
      return [{
        _tag: "MessageCreated",
        thread: normalized.thread,
        kind: kindOf(normalized.thread, channel, string(event, "channel_type")),
        message: normalized,
        raw
      }]
    }
    case "reaction_added":
    case "reaction_removed": {
      const item = event.item
      if (!isObject(item) || item.type !== "message") return []
      const channel = string(item, "channel")
      const messageId = string(item, "ts")
      const userId = string(event, "user")
      const name = string(event, "reaction")
      if (channel === undefined || messageId === undefined || userId === undefined || name === undefined) return []
      const messageAuthorId = string(event, "item_user")
      const eventTs = string(event, "event_ts")
      return [{
        _tag: event.type === "reaction_added" ? "ReactionAdded" : "ReactionRemoved",
        thread: thread({ team, channel }),
        messageId,
        ...(messageAuthorId === undefined ? {} : { messageAuthorId }),
        userId,
        emoji: emoji(name),
        ...(eventTs === undefined || !tsPattern.test(eventTs) ? {} : { timestamp: timestamp(eventTs) }),
        raw
      }]
    }
    case "agent_session_stopped": {
      const channel = string(event, "channel")
      const threadTs = string(event, "thread_ts")
      const userId = string(event, "user")
      const id = string(event, "event_ts")
      if (channel === undefined || threadTs === undefined || userId === undefined || id === undefined) return []
      const streams = event.streaming_message_ts
      return [{
        _tag: "StopRequested",
        thread: thread({ team, channel, threadTs }),
        id,
        userId,
        messageIds: Array.isArray(streams)
          ? streams.filter((ts): ts is string => typeof ts === "string" && ts.length > 0)
          : typeof streams === "string" && streams.length > 0
          ? [streams]
          : [],
        raw
      }]
    }
    default:
      return []
  }
}
