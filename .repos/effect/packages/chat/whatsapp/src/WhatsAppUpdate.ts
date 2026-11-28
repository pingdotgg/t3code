/**
 * What WhatsApp reports beside messages: delivery statuses, a user's changed
 * id, and the link between a phone number and a business-scoped user id.
 * They go to the `onUpdate` of `WhatsAppChat.layerWebhook` and
 * `WhatsAppChat.receive`, not to the `ChatHandler`.
 *
 * @stability unstable
 * @since 4.1.5
 */
import { ChatErrorReason } from "effect/chat/ChatError"
import { ChatThread } from "effect/chat/ChatThread"
import * as Schema from "effect/Schema"

/**
 * Schema for the status of a message the business sent.
 *
 * **Details**
 *
 * - `thread` is the recipient's address, with the business-scoped user id
 *   when the status carries one and the phone number when it does not.
 * - `messageId` is the id `post` gave. A `failed` status has the
 *   `reason` for Meta's error, mapped as a refused call is.
 * - `phone` and `userId` are the recipient's phone number and
 *   business-scoped user id, each when the status carries it.
 * - `raw` is the change's `metadata` and the one status.
 *
 * @stability unstable
 * @category schemas
 * @since 4.1.5
 */
export const Status = Schema.TaggedStruct("Status", {
  thread: ChatThread,
  messageId: Schema.String,
  status: Schema.Literals(["sent", "delivered", "read", "failed"]),
  timestamp: Schema.optionalKey(Schema.DateTimeUtc),
  reason: Schema.optionalKey(ChatErrorReason),
  phone: Schema.optionalKey(Schema.String),
  userId: Schema.optionalKey(Schema.String),
  raw: Schema.Json
})

/**
 * The status of a message the business sent.
 *
 * @stability unstable
 * @category models
 * @since 4.1.5
 */
export type Status = typeof Status.Type

/**
 * Schema for a user's changed phone number or business-scoped user id, from
 * a `system` message.
 *
 * **Details**
 *
 * - `thread` is the user's new address. A thread kept under the old one no
 *   longer receives messages from the user.
 * - `id` is the system message's id. `change` is Meta's `type`:
 *   `user_changed_number` or `user_changed_user_id`.
 * - `userId`, `previousUserId` and `phone` are there when Meta sends
 *   them. `previousPhone` is the system message's `from`.
 *
 * @stability unstable
 * @category schemas
 * @since 4.1.5
 */
export const UserIdChanged = Schema.TaggedStruct("UserIdChanged", {
  thread: ChatThread,
  id: Schema.String,
  change: Schema.Literals(["user_changed_number", "user_changed_user_id"]),
  userId: Schema.optionalKey(Schema.String),
  previousUserId: Schema.optionalKey(Schema.String),
  phone: Schema.optionalKey(Schema.String),
  previousPhone: Schema.optionalKey(Schema.String),
  timestamp: Schema.optionalKey(Schema.DateTimeUtc),
  raw: Schema.Json
})

/**
 * A user's changed phone number or business-scoped user id.
 *
 * @stability unstable
 * @category models
 * @since 4.1.5
 */
export type UserIdChanged = typeof UserIdChanged.Type

/**
 * Schema for a phone number and a business-scoped user id that name one
 * user.
 *
 * **Details**
 *
 * - Given for every `sent`, `delivered` or `read` status that carries
 *   both, beside the `Status`. Nothing is remembered between batches, so the
 *   same pair comes again and again.
 * - A message posted to a phone number address reports back with the
 *   user's business-scoped id, which is how a consumer learns that the
 *   inbound address (`thread`, always the business-scoped form) and the
 *   phone number address are one user. The adapter never rewrites an
 *   address.
 *
 * @stability unstable
 * @category schemas
 * @since 4.1.5
 */
export const Alias = Schema.TaggedStruct("Alias", {
  thread: ChatThread,
  phone: Schema.String,
  userId: Schema.String,
  messageId: Schema.String,
  status: Schema.Literals(["sent", "delivered", "read"]),
  raw: Schema.Json
})

/**
 * A phone number and a business-scoped user id that name one user.
 *
 * @stability unstable
 * @category models
 * @since 4.1.5
 */
export type Alias = typeof Alias.Type

/**
 * Schema for any update.
 *
 * @stability unstable
 * @category schemas
 * @since 4.1.5
 */
export const WhatsAppUpdate = Schema.Union([Status, UserIdChanged, Alias])

/**
 * Any update.
 *
 * @stability unstable
 * @category models
 * @since 4.1.5
 */
export type WhatsAppUpdate = typeof WhatsAppUpdate.Type
