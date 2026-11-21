import * as ChatEvent from "effect/chat/ChatEvent"
import type * as ChatMessage from "effect/chat/ChatMessage"
import type { ChatThread } from "effect/chat/ChatThread"
import * as DateTime from "effect/DateTime"
import * as Predicate from "effect/Predicate"
import type * as Schema from "effect/Schema"
import * as Address from "./address.ts"

/** @internal */
export type JsonObject = { readonly [key: string]: Schema.Json }

/** @internal */
export const isObject = (u: unknown): u is JsonObject => Predicate.isObject(u)

const field = (o: unknown, key: string): unknown => isObject(o) ? o[key] : undefined

/** The object at `key` of `o`, when `o` is an object. @internal */
export const object = (o: unknown, key: string): JsonObject | undefined => {
  const value = field(o, key)
  return isObject(value) ? value : undefined
}

/** @internal */
export const string = (o: unknown, key: string): string | undefined => {
  const value = field(o, key)
  return typeof value === "string" ? value : undefined
}

/** @internal */
export const integer = (o: unknown, key: string): number | undefined => {
  const value = field(o, key)
  return typeof value === "number" && Number.isSafeInteger(value) ? value : undefined
}

/** What normalising needs to know about the bot. @internal */
export interface Context {
  readonly botId: string
  /** The bot's username, without `@`, from `getMe`. */
  readonly botUsername?: string | undefined
  readonly environment?: "production" | "test" | undefined
}

/**
 * Whether a message belongs to a context v1 leaves out: a business
 * connection, a channel's direct messages chat, or guest mode.
 *
 * @internal
 */
export const isExcluded = (message: JsonObject): boolean =>
  "business_connection_id" in message ||
  "guest_query_id" in message ||
  "guest_bot_caller_user" in message ||
  "guest_bot_caller_chat" in message ||
  "direct_messages_topic" in message ||
  object(message, "chat")?.is_direct_messages === true

/** Whether a message is a private answer or input: `message_id` 0 with an `ephemeral_message_id`. @internal */
export const isEphemeral = (message: JsonObject): boolean =>
  integer(message, "message_id") === 0 && integer(message, "ephemeral_message_id") !== undefined

/** The address and kind of the chat a message is in. @internal */
export const threadOf = (
  message: JsonObject
): { readonly thread: ChatThread; readonly kind: ChatEvent.ThreadKind } | undefined => {
  const chat = object(message, "chat")
  const chatId = integer(chat, "id")
  if (chat === undefined || chatId === undefined) return undefined
  const topic = message.is_topic_message === true ? integer(message, "message_thread_id") : undefined
  if (topic !== undefined) return { thread: Address.thread(chatId, topic), kind: "thread" }
  return { thread: Address.thread(chatId), kind: chat.type === "private" ? "direct" : "channel" }
}

/** A message's id as events carry it: the real id, or `e{ephemeral_message_id}.{date}` for a private one. @internal */
export const messageIdOf = (message: JsonObject): string | undefined => {
  const id = integer(message, "message_id")
  if (id === undefined) return undefined
  if (id !== 0) return String(id)
  const ephemeral = integer(message, "ephemeral_message_id")
  return ephemeral === undefined ? undefined : `${Address.ephemeralPrefix}${ephemeral}.${integer(message, "date") ?? 0}`
}

/** A user's or private chat's first and last name, `""` without either. @internal */
export const fullName = (o: unknown): string =>
  [string(o, "first_name"), string(o, "last_name")].filter((part) => part !== undefined).join(" ")

/** A user's full name, else their username. @internal */
export const displayName = (user: JsonObject): string | undefined => fullName(user) || string(user, "username")

const authorOf = (message: JsonObject, context: Context): ChatMessage.Author | undefined => {
  const senderChat = object(message, "sender_chat")
  const senderChatId = integer(senderChat, "id")
  if (senderChat !== undefined && senderChatId !== undefined) {
    const title = string(senderChat, "title")
    return { id: String(senderChatId), ...(title === undefined ? {} : { name: title }), isBot: false, isSelf: false }
  }
  const from = object(message, "from")
  const fromId = integer(from, "id")
  if (from === undefined || fromId === undefined) return undefined
  const name = displayName(from)
  return {
    id: String(fromId),
    ...(name === undefined ? {} : { name }),
    isBot: from.is_bot === true,
    isSelf: String(fromId) === context.botId
  }
}

const mentionsOf = (text: string, entities: ReadonlyArray<Schema.Json>, context: Context) => {
  const mentions: Array<ChatMessage.Mention> = []
  const self = context.botUsername?.toLowerCase()
  for (const entity of entities) {
    if (!isObject(entity)) continue
    const start = integer(entity, "offset")
    const length = integer(entity, "length")
    if (start === undefined || length === undefined || start < 0 || start + length > text.length) continue
    const end = start + length
    if (entity.type === "text_mention") {
      const user = integer(object(entity, "user"), "id")
      if (user !== undefined) {
        mentions.push({ kind: "user", id: String(user), start, end, isSelf: String(user) === context.botId })
      }
    } else if (entity.type === "mention" && self !== undefined && text.slice(start + 1, end).toLowerCase() === self) {
      mentions.push({ kind: "user", id: context.botId, start, end, isSelf: true })
    }
  }
  return mentions
}

const attachmentsOf = (message: JsonObject): Array<ChatMessage.Attachment> => {
  const out: Array<ChatMessage.Attachment> = []
  const add = (file: JsonObject | undefined) => {
    const id = string(file, "file_id")
    if (id === undefined) return
    const name = string(file, "file_name")
    const contentType = string(file, "mime_type")
    const size = integer(file, "file_size")
    out.push({
      id,
      ...(name === undefined ? {} : { name }),
      ...(contentType === undefined ? {} : { contentType }),
      ...(size === undefined ? {} : { size })
    })
  }
  // An animation comes with a copy of itself as `document`, for older clients.
  const animation = object(message, "animation")
  add(animation ?? object(message, "document"))
  for (const key of ["audio", "video", "voice"]) add(object(message, key))
  const photo = message.photo
  if (Array.isArray(photo) && photo.length > 0) {
    let largest: JsonObject | undefined
    for (const size of photo) {
      if (!isObject(size)) continue
      const area = (integer(size, "width") ?? 0) * (integer(size, "height") ?? 0)
      const best = (integer(largest, "width") ?? 0) * (integer(largest, "height") ?? 0)
      if (largest === undefined || area > best) largest = size
    }
    add(largest)
  }
  return out
}

const replyToOf = (message: JsonObject, context: Context): ChatMessage.ReplyTo | undefined => {
  const reply = object(message, "reply_to_message")
  const id = integer(reply, "message_id")
  if (reply === undefined || id === undefined || id === 0) return undefined
  // A message in a topic replies to the topic's creation message, which is not a reply.
  if (
    message.is_topic_message === true &&
    (id === integer(message, "message_thread_id") || "forum_topic_created" in reply)
  ) {
    return undefined
  }
  const author = integer(object(reply, "from"), "id")
  return author === undefined
    ? { messageId: String(id) }
    : { messageId: String(id), authorId: String(author), isSelf: String(author) === context.botId }
}

/** The message of an update that carries one: `message` or `channel_post`. @internal */
export const messageOf = (update: unknown): JsonObject | undefined =>
  object(update, "message") ?? object(update, "channel_post")

/** The text of a message, verbatim, and its entities. @internal */
export const textOf = (
  message: JsonObject
): { readonly text: string; readonly entities: ReadonlyArray<Schema.Json> } => {
  const text = string(message, "text")
  if (text !== undefined) return { text, entities: Array.isArray(message.entities) ? message.entities : [] }
  const caption = string(message, "caption") ?? ""
  return { text: caption, entities: Array.isArray(message.caption_entities) ? message.caption_entities : [] }
}

/**
 * The `MessageCreated` of an update's message, or undefined for one that
 * gives none: an excluded context, a private (ephemeral) message, a message
 * with no id, and a service message, with no text, caption, file or rich
 * content. `invalid` is a message that should give one and can't be read.
 *
 * @internal
 */
export const messageCreated = (
  update: JsonObject,
  context: Context
): ChatEvent.MessageCreated | "none" | "invalid" => {
  const message = messageOf(update)
  if (message === undefined || isExcluded(message) || integer(message, "message_id") === 0) return "none"
  const { entities, text } = textOf(message)
  const attachments = attachmentsOf(message)
  if (text === "" && attachments.length === 0 && !("rich_message" in message)) return "none"
  const at = threadOf(message)
  const id = messageIdOf(message)
  const author = authorOf(message, context)
  const date = integer(message, "date")
  if (at === undefined || id === undefined || author === undefined || date === undefined) return "invalid"
  const replyTo = replyToOf(message, context)
  return ChatEvent.MessageCreated.make({
    thread: at.thread,
    kind: at.kind,
    message: {
      id,
      thread: at.thread,
      author,
      text,
      mentions: mentionsOf(text, entities, context),
      ...(replyTo === undefined ? {} : { replyTo }),
      attachments,
      timestamp: DateTime.makeUnsafe(date * 1000),
      raw: message
    },
    raw: update
  })
}

/** A command typed as a message: its lowercased name and what follows it. @internal */
export interface Command {
  readonly id: string
  readonly text: string
}

/**
 * The command a message holds: its first entity is a `bot_command` at
 * offset 0, naming this bot or no bot. `undefined` when a command names a
 * bot and the bot's username is not known.
 *
 * @internal
 */
export const commandOf = (message: JsonObject, context: Context): Command | undefined => {
  const { entities, text } = textOf(message)
  const first = entities[0]
  if (!isObject(first) || first.type !== "bot_command" || integer(first, "offset") !== 0) return undefined
  const length = integer(first, "length")
  if (length === undefined || length < 2 || length > text.length) return undefined
  // The entity's length is Telegram's: it never covers a `-`, which `commandRequests` refuses.
  const match = /^\/([A-Za-z0-9_-]{1,32})(?:@([A-Za-z0-9_]+))?$/.exec(text.slice(0, length))
  if (match === null) return undefined
  if (match[2] !== undefined && match[2].toLowerCase() !== context.botUsername?.toLowerCase()) return undefined
  let rest = text.slice(length)
  if (rest.startsWith(" ") || rest.startsWith("\n")) rest = rest.slice(1)
  return { id: match[1].toLowerCase(), text: rest }
}

/** The date of an update's message or callback message, 0 when there is none. */
const dateOf = (update: unknown): number =>
  integer(messageOf(update), "date") ?? integer(object(object(update, "callback_query"), "message"), "date") ?? 0

/**
 * The delivery id of an update: `{botId}.{update_id}.{date}`, with `test.`
 * in front in the test environment.
 *
 * @internal
 */
export const deliveryId = (update: unknown, context: Pick<Context, "botId" | "environment">): string | undefined => {
  const id = integer(update, "update_id")
  if (id === undefined) return undefined
  return `${context.environment === "test" ? "test." : ""}${context.botId}.${id}.${dateOf(update)}`
}

/** The events of an update, as `TelegramChat.normalize` gives them. @internal */
export const normalize = (update: unknown, context: Context): ReadonlyArray<ChatEvent.ChatEvent> => {
  if (!isObject(update)) return []
  const event = messageCreated(update, context)
  return typeof event === "string" ? [] : [event]
}
