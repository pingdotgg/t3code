/**
 * Messages read from a chat platform.
 *
 * A `ChatMessage` has the same shape on every read path: inbound events,
 * `Chat.fetchMessage` and `Chat.history`. Its `text` is the platform's own
 * content string, verbatim, and its mentions are data with offsets into that
 * text.
 *
 * @stability unstable
 * @since 4.1.5
 */
import * as Schema from "../Schema.ts"
import { ChatThread } from "./ChatThread.ts"

/**
 * Schema for the author of a message.
 *
 * **Details**
 *
 * `name` is a best-effort display name: whatever the payload carries. There
 * is no lookup, so inbound messages and history can differ. Other bots'
 * messages are delivered with `isBot: true`; `isSelf` marks the bot's own.
 *
 * @stability unstable
 * @category schemas
 * @since 4.1.5
 */
export const Author = Schema.Struct({
  id: Schema.String,
  name: Schema.optionalKey(Schema.String),
  isBot: Schema.Boolean,
  isSelf: Schema.Boolean
}).annotate({ identifier: "ChatMessage.Author" })

/**
 * The author of a message.
 *
 * @stability unstable
 * @category models
 * @since 4.1.5
 */
export type Author = typeof Author.Type

/**
 * Schema for a mention inside a message's text.
 *
 * **Details**
 *
 * `start` and `end` are offsets into `ChatMessage.text`, in UTF-16 code
 * units, so `text.slice(start, end)` is the platform's own token for the
 * mention. `id` is the platform id, or `here`, `channel` or `everyone` for
 * a broadcast.
 *
 * @stability unstable
 * @category schemas
 * @since 4.1.5
 */
export const Mention = Schema.Struct({
  kind: Schema.Literals(["user", "role", "channel", "broadcast"]),
  id: Schema.String,
  start: Schema.Int,
  end: Schema.Int,
  isSelf: Schema.Boolean
}).annotate({ identifier: "ChatMessage.Mention" })

/**
 * A mention inside a message's text.
 *
 * @stability unstable
 * @category models
 * @since 4.1.5
 */
export type Mention = typeof Mention.Type

/**
 * Schema for a file attached to a message.
 *
 * **Gotchas**
 *
 * An attachment never carries a URL. `Chat.download` resolves the id again.
 *
 * @stability unstable
 * @category schemas
 * @since 4.1.5
 */
export const Attachment = Schema.Struct({
  id: Schema.String,
  name: Schema.optionalKey(Schema.String),
  contentType: Schema.optionalKey(Schema.String),
  size: Schema.optionalKey(Schema.Int)
}).annotate({ identifier: "ChatMessage.Attachment" })

/**
 * A file attached to a message.
 *
 * @stability unstable
 * @category models
 * @since 4.1.5
 */
export type Attachment = typeof Attachment.Type

/**
 * Schema for the message a message replies to.
 *
 * **Details**
 *
 * - `authorId` is there when the platform says who wrote the message
 *   replied to. Discord leaves it out once that message is deleted.
 * - `isSelf` says whether that author is the bot. An adapter sets it on
 *   every message it reads that has an `authorId`. A write ignores both.
 *
 * @stability unstable
 * @category schemas
 * @since 4.1.5
 */
export const ReplyTo = Schema.Struct({
  messageId: Schema.String,
  authorId: Schema.optionalKey(Schema.String),
  isSelf: Schema.optionalKey(Schema.Boolean)
}).annotate({ identifier: "ChatMessage.ReplyTo" })

/**
 * The message a message replies to.
 *
 * @stability unstable
 * @category models
 * @since 4.1.5
 */
export type ReplyTo = typeof ReplyTo.Type

/**
 * Schema for a message read from a chat platform.
 *
 * **Details**
 *
 * - `thread` is the address the message was posted to, the same on every read
 *   path. It never changes: a message a thread hangs off stays in the parent,
 *   also once it has replies. `Chat.startThread(message.thread, message.id)`
 *   is the way from such a message to its thread.
 * - `text` is the platform's own content string, verbatim, with mention tokens
 *   and code fences in place. One exception: Slack renders the bot's own
 *   messages with `rich_text` blocks from those blocks as Markdown.
 * - `raw` is the platform's message payload, as a JSON value.
 *
 * **Gotchas**
 *
 * `text` is a different format from outbound Markdown and cannot be posted
 * back as is.
 *
 * @stability unstable
 * @category schemas
 * @since 4.1.5
 */
export const ChatMessage = Schema.Struct({
  id: Schema.String,
  thread: ChatThread,
  author: Author,
  /** The platform's content verbatim, except Slack renders the bot's own rich_text blocks as Markdown. */
  text: Schema.String,
  mentions: Schema.Array(Mention),
  replyTo: Schema.optionalKey(ReplyTo),
  attachments: Schema.Array(Attachment),
  timestamp: Schema.DateTimeUtc,
  raw: Schema.Json
}).annotate({ identifier: "ChatMessage" })

/**
 * A message read from a chat platform.
 *
 * @stability unstable
 * @category models
 * @since 4.1.5
 */
export type ChatMessage = typeof ChatMessage.Type

/**
 * Returns whether the message mentions the bot.
 *
 * **Gotchas**
 *
 * A reply to the bot is not a mention. Whether it counts as one is the
 * consumer's policy.
 *
 * @see {@link repliesToSelf} for a reply to one of the bot's messages
 *
 * @stability unstable
 * @category predicates
 * @since 4.1.5
 */
export const mentionsSelf = (message: ChatMessage): boolean => message.mentions.some((mention) => mention.isSelf)

/**
 * Returns whether the message replies to one of the bot's own messages.
 *
 * **When to use**
 *
 * Use with `mentionsSelf` when a reply to the bot should count as addressed
 * to it, whether or not the reply pings.
 *
 * **Gotchas**
 *
 * - It reads `replyTo.isSelf`, so it is false when the platform does not say
 *   who wrote the message replied to.
 * - A message in a Slack thread is not a reply to the thread's first
 *   message: Slack messages carry no `replyTo`.
 *
 * @see {@link mentionsSelf} for a mention of the bot
 *
 * @stability unstable
 * @category predicates
 * @since 4.1.5
 */
export const repliesToSelf = (message: ChatMessage): boolean => message.replyTo?.isSelf === true
