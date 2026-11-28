/**
 * Inbound events from a chat platform.
 *
 * Adapters deliver a `ChatEvent` to the consumer's `ChatHandler`. Delivery is
 * at-least-once: `dedupeKey` gives two deliveries of one event the same key,
 * and the library keeps no seen-store.
 *
 * @stability unstable
 * @since 4.1.5
 */
import * as Schema from "../Schema.ts"
import { ChatMessage } from "./ChatMessage.ts"
import * as ChatThread from "./ChatThread.ts"

/**
 * Schema for what an address turned out to be: a channel, a thread or a direct
 * conversation.
 *
 * @stability unstable
 * @category schemas
 * @since 4.1.5
 */
export const ThreadKind = Schema.Literals(["channel", "thread", "direct"])

/**
 * What an address turned out to be: a channel, a thread or a direct
 * conversation.
 *
 * @stability unstable
 * @category models
 * @since 4.1.5
 */
export type ThreadKind = typeof ThreadKind.Type

/**
 * Schema for a message that arrived in a thread.
 *
 * **Details**
 *
 * `thread` equals `message.thread`. `raw` is the delivery envelope; the
 * message payload is on `message.raw`.
 *
 * @stability unstable
 * @category schemas
 * @since 4.1.5
 */
export const MessageCreated = Schema.TaggedStruct("MessageCreated", {
  thread: ChatThread.ChatThread,
  kind: ThreadKind,
  message: ChatMessage,
  raw: Schema.Json
}).annotate({ identifier: "ChatEvent.MessageCreated" })

/**
 * A message that arrived in a thread.
 *
 * @stability unstable
 * @category models
 * @since 4.1.5
 */
export type MessageCreated = typeof MessageCreated.Type

const reaction = {
  thread: ChatThread.ChatThread,
  messageId: Schema.String,
  messageAuthorId: Schema.optionalKey(Schema.String),
  userId: Schema.String,
  emoji: Schema.String,
  timestamp: Schema.optionalKey(Schema.DateTimeUtc),
  raw: Schema.Json
}

/**
 * Schema for a reaction a user added to a message.
 *
 * **Details**
 *
 * - `thread` is where the platform says it happened. On Slack this is the
 *   channel, even for a message in a thread; `Chat.fetchMessage` returns the
 *   message with its real address.
 * - `emoji` is a Unicode emoji, or `custom:{name}` for one the adapter's table
 *   does not know.
 * - `messageAuthorId` and `timestamp` are missing when the platform does not
 *   send them.
 *
 * @stability unstable
 * @category schemas
 * @since 4.1.5
 */
export const ReactionAdded = Schema.TaggedStruct("ReactionAdded", reaction).annotate({
  identifier: "ChatEvent.ReactionAdded"
})

/**
 * A reaction a user added to a message.
 *
 * @stability unstable
 * @category models
 * @since 4.1.5
 */
export type ReactionAdded = typeof ReactionAdded.Type

/**
 * Schema for a reaction a user removed from a message.
 *
 * **Details**
 *
 * The fields mean the same as on `ReactionAdded`.
 *
 * @stability unstable
 * @category schemas
 * @since 4.1.5
 */
export const ReactionRemoved = Schema.TaggedStruct("ReactionRemoved", reaction).annotate({
  identifier: "ChatEvent.ReactionRemoved"
})

/**
 * A reaction a user removed from a message.
 *
 * @stability unstable
 * @category models
 * @since 4.1.5
 */
export type ReactionRemoved = typeof ReactionRemoved.Type

/**
 * Schema for a user asking the bot to stop working in a thread, as Slack's
 * stop button does.
 *
 * **Details**
 *
 * - Nothing has been stopped. The thread's streams stay open and keep taking
 *   text until the consumer ends them, and the platform shows a disabled
 *   button until then.
 * - `messageIds` holds the streams the platform named. It is empty when no
 *   stream was open, but an empty list does not mean none is: Slack names
 *   the stream only on the first click in a thread. End the thread's reply
 *   whatever it holds.
 * - `id` is the platform's id for the request, Slack's `event_ts`. Two
 *   deliveries of one request share it.
 * - It has no `kind`.
 *
 * @stability unstable
 * @category schemas
 * @since 4.1.5
 */
export const StopRequested = Schema.TaggedStruct("StopRequested", {
  thread: ChatThread.ChatThread,
  id: Schema.String,
  userId: Schema.String,
  messageIds: Schema.Array(Schema.String),
  raw: Schema.Json
}).annotate({ identifier: "ChatEvent.StopRequested" })

/**
 * A user asking the bot to stop working in a thread.
 *
 * @stability unstable
 * @category models
 * @since 4.1.5
 */
export type StopRequested = typeof StopRequested.Type

/**
 * Schema for an inbound chat event.
 *
 * **Gotchas**
 *
 * The union is open: later releases add members such as edits and deletes, so
 * a `switch` over `_tag` needs a `default`.
 *
 * @stability unstable
 * @category schemas
 * @since 4.1.5
 */
export const ChatEvent = Schema.Union([MessageCreated, ReactionAdded, ReactionRemoved, StopRequested]).annotate({
  identifier: "ChatEvent"
})

/**
 * An inbound chat event.
 *
 * @stability unstable
 * @category models
 * @since 4.1.5
 */
export type ChatEvent = typeof ChatEvent.Type

/**
 * Returns the key two deliveries of one event share.
 *
 * **When to use**
 *
 * Use to drop redelivered events: delivery is at-least-once and the library
 * keeps no seen-store.
 *
 * **Details**
 *
 * - A message is `message/{thread}/{id}`, with the thread in its
 *   `{platform}:{id}` form.
 * - A reaction is `reaction/{messageId}/{userId}/{emoji}/{added|removed}`.
 * - A stop request is `stop/{thread}/{id}`.
 * - Slack's `message` and `app_mention` for one message share a key.
 *
 * @stability unstable
 * @category getters
 * @since 4.1.5
 */
export const dedupeKey = (event: ChatEvent): string => {
  switch (event._tag) {
    case "MessageCreated":
      return `message/${ChatThread.toString(event.message.thread)}/${event.message.id}`
    case "ReactionAdded":
      return `reaction/${event.messageId}/${event.userId}/${event.emoji}/added`
    case "ReactionRemoved":
      return `reaction/${event.messageId}/${event.userId}/${event.emoji}/removed`
    case "StopRequested":
      return `stop/${ChatThread.toString(event.thread)}/${event.id}`
  }
}
