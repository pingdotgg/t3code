import type { ChatEvent, ReactionAdded, ReactionRemoved, ThreadKind } from "effect/chat/ChatEvent"
import type { Attachment, ChatMessage, Mention } from "effect/chat/ChatMessage"
import * as ChatThread from "effect/chat/ChatThread"
import * as DateTime from "effect/DateTime"
import * as Option from "effect/Option"
import * as Predicate from "effect/Predicate"
import * as Schema from "effect/Schema"
import * as Mentions from "./mentions.ts"

/** @internal */
export const platform = "discord"

/** @internal */
export const thread = (channelId: string): ChatThread.ChatThread => ChatThread.make(platform, channelId)

/**
 * The message types that are a message: `DEFAULT`, `REPLY`,
 * `CHAT_INPUT_COMMAND` and `CONTEXT_MENU_COMMAND`. Inbound and history
 * both read it, and a type Discord adds later stays out.
 *
 * @internal
 */
export const messageTypes: ReadonlySet<number> = new Set([0, 19, 20, 23])

/** @internal */
export const REPLY = 19

/**
 * The thread starter placeholder in a thread started from a message.
 *
 * @internal
 */
export const THREAD_STARTER_MESSAGE = 21

/**
 * Discord's channel type as a `kind`: 10, 11 and 12 are threads, 1 and 3
 * directs, everything else a channel, unknown types included.
 *
 * @internal
 */
export const kindOf = (channelType: number): ThreadKind =>
  channelType === 10 || channelType === 11 || channelType === 12
    ? "thread"
    : channelType === 1 || channelType === 3
    ? "direct"
    : "channel"

/** @internal */
export const isThreadType = (channelType: number): boolean => kindOf(channelType) === "thread"

/**
 * A field Discord may leave out or send as `null`.
 *
 * @internal
 */
export const optional = <S extends Schema.Top>(schema: S) => Schema.optionalKey(Schema.NullOr(schema))

/** @internal */
export const UserFields = Schema.Struct({
  id: Schema.String,
  username: optional(Schema.String),
  global_name: optional(Schema.String),
  bot: optional(Schema.Boolean)
})

const MemberFields = Schema.Struct({
  nick: optional(Schema.String),
  roles: optional(Schema.Array(Schema.String))
})

const AttachmentFields = Schema.Struct({
  id: Schema.String,
  filename: optional(Schema.String),
  content_type: optional(Schema.String),
  size: optional(Schema.Int)
})

const ReferenceFields = Schema.Struct({
  type: optional(Schema.Number),
  message_id: optional(Schema.String),
  channel_id: optional(Schema.String)
})

/**
 * What the normaliser reads from a message.
 *
 * @internal
 */
export const MessageFields = Schema.Struct({
  id: Schema.String,
  channel_id: Schema.String,
  type: Schema.Number,
  content: optional(Schema.String),
  timestamp: Schema.DateTimeUtcFromString,
  author: UserFields,
  webhook_id: optional(Schema.String),
  guild_id: optional(Schema.String),
  channel_type: optional(Schema.Number),
  member: optional(MemberFields),
  mentions: optional(Schema.Array(Schema.Struct({ id: Schema.String }))),
  mention_roles: optional(Schema.Array(Schema.String)),
  mention_everyone: optional(Schema.Boolean),
  attachments: optional(Schema.Array(AttachmentFields)),
  message_reference: optional(ReferenceFields),
  referenced_message: optional(Schema.Struct({ author: optional(Schema.Struct({ id: Schema.String })) }))
})

/** @internal */
export type MessageFields = typeof MessageFields.Type

const ReactionFields = Schema.Struct({
  user_id: Schema.String,
  channel_id: Schema.String,
  message_id: Schema.String,
  guild_id: optional(Schema.String),
  message_author_id: optional(Schema.String),
  member: optional(MemberFields),
  emoji: Schema.Struct({ id: optional(Schema.String), name: optional(Schema.String) })
})

const decodeMessage = Schema.decodeUnknownOption(MessageFields)
const decodeReaction = Schema.decodeUnknownOption(ReactionFields)

/** @internal */
export const decodeMessageFields = (raw: unknown): MessageFields | undefined =>
  Option.getOrUndefined(decodeMessage(raw))

/**
 * An attachment's id: the message's id and the attachment's, since a download reads the message again.
 *
 * @internal
 */
export const attachmentId = (messageId: string, id: string): string => `${messageId}/${id}`

/** @internal */
export const parseAttachmentId = (
  id: string
): { readonly messageId: string; readonly attachmentId: string } | undefined => {
  const parts = id.split("/")
  return parts.length === 2 && parts[0] !== "" && parts[1] !== ""
    ? { messageId: parts[0], attachmentId: parts[1] }
    : undefined
}

/**
 * The mentions in `content`: a token outside code that Discord says
 * resolved, through `mentions` for a user, `mention_roles` for a role and
 * `mention_everyone` for `@everyone` and `@here`. A channel token has no
 * confirming field, so the token alone counts.
 */
const mentionsOf = (fields: MessageFields, text: string, botUserId: string): Array<Mention> => {
  const users = new Set((fields.mentions ?? []).map((user) => user.id))
  const roles = new Set(fields.mention_roles ?? [])
  const everyone = fields.mention_everyone === true
  const found: Array<Mention> = []
  for (const token of Mentions.tokens(text)) {
    const resolved = token.kind === "user"
      ? users.has(token.id)
      : token.kind === "role"
      ? roles.has(token.id)
      : token.kind === "broadcast"
      ? everyone
      : true
    if (!resolved) continue
    found.push({
      kind: token.kind,
      id: token.id,
      start: token.start,
      end: token.end,
      isSelf: token.kind === "user" && token.id === botUserId
    })
  }
  return found
}

/** @internal */
export const nonEmpty = (value: string | null | undefined): string | undefined =>
  value === null || value === undefined || value === "" ? undefined : value

/**
 * A message payload, from the gateway or REST, as a `ChatMessage`.
 * `undefined` for a type that is not a message.
 *
 * @internal
 */
export const message = (
  raw: Schema.Json,
  fields: MessageFields,
  context: { readonly botUserId: string }
): ChatMessage | undefined => {
  if (!messageTypes.has(fields.type)) return undefined
  const text = fields.content ?? ""
  const webhook = nonEmpty(fields.webhook_id)
  const name = webhook === undefined
    ? nonEmpty(fields.member?.nick) ?? nonEmpty(fields.author.global_name) ?? nonEmpty(fields.author.username)
    : nonEmpty(fields.author.username)
  const reference = fields.message_reference
  const replyId = fields.type === REPLY && (reference?.type ?? 0) === 0 ? nonEmpty(reference?.message_id) : undefined
  const replyAuthor = fields.referenced_message?.author?.id
  const attachments = (fields.attachments ?? []).map((attachment): Attachment => {
    const name = nonEmpty(attachment.filename)
    const contentType = nonEmpty(attachment.content_type)
    return {
      id: attachmentId(fields.id, attachment.id),
      ...(name === undefined ? {} : { name }),
      ...(contentType === undefined ? {} : { contentType }),
      ...(typeof attachment.size === "number" ? { size: attachment.size } : {})
    }
  })
  return {
    id: fields.id,
    thread: thread(fields.channel_id),
    author: {
      id: webhook ?? fields.author.id,
      ...(name === undefined ? {} : { name }),
      isBot: webhook !== undefined || fields.author.bot === true,
      isSelf: webhook === undefined && fields.author.id === context.botUserId
    },
    text,
    mentions: mentionsOf(fields, text, context.botUserId),
    ...(replyId === undefined
      ? {}
      : {
        replyTo: {
          messageId: replyId,
          ...(replyAuthor === undefined ? {} : { authorId: replyAuthor, isSelf: replyAuthor === context.botUserId })
        }
      }),
    attachments,
    timestamp: fields.timestamp,
    raw
  }
}

/**
 * A reaction's emoji: the Unicode emoji, or `custom:{name}` for a guild's own.
 *
 * @internal
 */
export const emojiOf = (
  emoji: { readonly id?: string | null | undefined; readonly name?: string | null | undefined }
) =>
  nonEmpty(emoji.id) === undefined
    ? nonEmpty(emoji.name)
    : `custom:${nonEmpty(emoji.name) ?? emoji.id}`

/**
 * The result of `normalize`: the events, or the channel whose type is missing.
 *
 * @internal
 */
export type Normalized =
  | { readonly _tag: "Events"; readonly events: ReadonlyArray<ChatEvent> }
  | { readonly _tag: "MissingChannelType"; readonly channelId: string }

const none: Normalized = { _tag: "Events", events: [] }

const events = (events: ReadonlyArray<ChatEvent>): Normalized => ({ _tag: "Events", events })

/** @internal */
export const normalize = (
  dispatch: { readonly t: string; readonly d: unknown },
  context: { readonly botUserId: string; readonly channelType?: number | undefined }
): Normalized => {
  const raw = dispatch.d as Schema.Json
  switch (dispatch.t) {
    case "MESSAGE_CREATE": {
      const fields = decodeMessageFields(raw)
      if (fields === undefined || !messageTypes.has(fields.type)) return none
      const channelType = fields.channel_type ?? context.channelType
      if (channelType === undefined) return { _tag: "MissingChannelType", channelId: fields.channel_id }
      const created = message(raw, fields, context)
      return created === undefined ? none : events([{
        _tag: "MessageCreated",
        thread: created.thread,
        kind: kindOf(channelType),
        message: created,
        raw
      }])
    }
    case "MESSAGE_REACTION_ADD":
    case "MESSAGE_REACTION_REMOVE": {
      const fields = Option.getOrUndefined(decodeReaction(raw))
      const emoji = fields === undefined ? undefined : emojiOf(fields.emoji)
      if (fields === undefined || emoji === undefined) return none
      const authorId = nonEmpty(fields.message_author_id)
      const reaction = {
        thread: thread(fields.channel_id),
        messageId: fields.message_id,
        ...(authorId === undefined ? {} : { messageAuthorId: authorId }),
        userId: fields.user_id,
        emoji,
        raw
      }
      return events([
        dispatch.t === "MESSAGE_REACTION_ADD"
          ? { _tag: "ReactionAdded", ...reaction } satisfies ReactionAdded
          : { _tag: "ReactionRemoved", ...reaction } satisfies ReactionRemoved
      ])
    }
    default:
      return none
  }
}

/** @internal */
export const guildIdOf = (raw: unknown): Option.Option<string> =>
  Predicate.isObject(raw) && typeof raw.guild_id === "string" && raw.guild_id !== ""
    ? Option.some(raw.guild_id)
    : Option.none()

/** @internal */
export const memberOf = (raw: unknown): Option.Option<{
  readonly guildId: string
  readonly roles: ReadonlyArray<string>
  readonly nick?: string | undefined
}> =>
  Option.flatMap(guildIdOf(raw), (guildId) => {
    const member = (raw as { readonly member?: unknown }).member
    if (!Predicate.isObject(member)) return Option.none()
    const roles = Array.isArray(member.roles) ? member.roles.filter((role) => typeof role === "string") : []
    const nick = typeof member.nick === "string" && member.nick !== "" ? member.nick : undefined
    return Option.some({ guildId, roles, ...(nick === undefined ? {} : { nick }) })
  })

/** The start of Discord's snowflake clock, in Unix milliseconds. */
const discordEpoch = 1_420_070_400_000

/**
 * When a snowflake was made, in Unix milliseconds. Throws for an id that is
 * not a number.
 *
 * @internal
 */
export const snowflakeMillis = (id: string): number => Number(BigInt(id) >> BigInt(22)) + discordEpoch

/**
 * When a snowflake was made.
 *
 * @internal
 */
export const snowflakeTime = (id: string): DateTime.Utc | undefined => {
  try {
    return DateTime.makeUnsafe(snowflakeMillis(id))
  } catch {
    return undefined
  }
}

/**
 * Orders two snowflakes.
 *
 * @internal
 */
export const compareIds = (a: string, b: string): number => {
  try {
    const x = BigInt(a)
    const y = BigInt(b)
    return x < y ? -1 : x > y ? 1 : 0
  } catch {
    return a.length !== b.length ? a.length - b.length : a < b ? -1 : a > b ? 1 : 0
  }
}
