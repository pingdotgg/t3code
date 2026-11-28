import type { DiscordREST } from "dfx/DiscordREST"
import * as Generated from "dfx/DiscordREST/Generated"
import type * as Discord from "dfx/types"
import * as Cache from "effect/Cache"
import {
  type ChatAdapter,
  checkMessageLength,
  type Descriptor,
  type File,
  type Posted,
  retrySafe,
  type ThreadInfo,
  type User
} from "effect/chat/ChatAdapter"
import {
  type ChatError,
  type ChatErrorReason,
  fileRefused,
  interactionExpired,
  NotFound,
  TooLarge
} from "effect/chat/ChatError"
import * as ChatInteraction from "effect/chat/ChatInteraction"
import type { ChatMessage } from "effect/chat/ChatMessage"
import type * as ChatThread from "effect/chat/ChatThread"
import type { Action } from "effect/chat/ChatUi"
import * as Clock from "effect/Clock"
import * as DateTime from "effect/DateTime"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import { flow } from "effect/Function"
import * as HttpClient from "effect/http/HttpClient"
import * as HttpClientRequest from "effect/http/HttpClientRequest"
import * as Option from "effect/Option"
import { isObject } from "effect/Predicate"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import type { DiscordPostOptions } from "../DiscordChat.ts"
import * as Errors from "./errors.ts"
import * as Interactions from "./interactions.ts"
import * as Length from "./length.ts"
import * as Normalize from "./normalize.ts"
import { nonEmpty, optional, UserFields } from "./normalize.ts"
import { allowedMentions, CurrentPostOptions, flags } from "./options.ts"

type Json = Schema.Json
type Rest = DiscordREST["Service"]

/** @internal */
export const descriptor: Descriptor = {
  platform: Normalize.platform,
  capabilities: new Set([
    "edit",
    "delete",
    "fetchMessage",
    "history",
    "download",
    "files",
    "replyTo",
    "startThread",
    "getThread",
    "opener",
    "getUser",
    "buttons",
    "selects",
    "modals",
    "commands",
    "ephemeral"
  ]),
  // Components sit beside `content`, so the elements cost nothing here.
  measure: (markdown) => Length.codePoints(markdown),
  limits: {
    messageLength: Length.messageLength,
    filesPerMessage: 10,
    uploadBytes: 10 * 1024 * 1024,
    minWriteInterval: Duration.millis(1500),
    followUpAge: Duration.minutes(15),
    ...Interactions.limits
  }
}

const pageSize = 100

/** Discord's code for "a thread has already been created for this message". */
const THREAD_ALREADY_CREATED = 160004
/** Discord's code for "cannot execute action on this channel type". */
const WRONG_CHANNEL_TYPE = 50024
/** Discord's code for "unknown interaction": a callback after the 3 seconds. */
const UNKNOWN_INTERACTION = 10062
/**
 * Discord's codes for an interaction token it no longer takes. After 15
 * minutes it answered 401 with 50027 "Invalid Webhook Token", recorded in
 * EFF-3802. 10015 "Unknown Webhook" is from the docs' list and was not seen.
 */
const SPENT_TOKEN = [50027, 10015]

const ChannelFields = Schema.Struct({
  id: Schema.String,
  type: Schema.Number,
  guild_id: optional(Schema.String),
  parent_id: optional(Schema.String),
  name: optional(Schema.String),
  topic: optional(Schema.String),
  thread_metadata: optional(Schema.Struct({ create_timestamp: optional(Schema.String) }))
})

/**
 * What the adapter reads from a channel.
 *
 * @internal
 */
export type Channel = typeof ChannelFields.Type & { readonly raw: Json }

const decodeChannel = Schema.decodeUnknownOption(ChannelFields)

const decodeUser = Schema.decodeUnknownOption(UserFields)

const MemberFields = Schema.Struct({ nick: optional(Schema.String), user: optional(UserFields) })

const decodeMember = Schema.decodeUnknownOption(MemberFields)

const snowflake = /^\d{1,20}$/

/** Whether `thread` is a Discord address. */
const isAddress = (thread: ChatThread.ChatThread): boolean =>
  thread.platform === Normalize.platform && snowflake.test(thread.id)

/**
 * Discord's API, as dfx's `DiscordConfig` has it by default.
 *
 * @internal
 */
export const defaultBaseUrl = "https://discord.com/api/v10"

/** @internal */
export const make = Effect.fnUntraced(function*(options: {
  readonly rest: Rest
  readonly http: HttpClient.HttpClient
  readonly baseUrl: string
  readonly botUserId: Effect.Effect<string, ChatError>
}) {
  const { rest } = options

  /**
   * dfx's requests for the interaction webhook, over the plain `HttpClient`.
   * dfx's own client sends a request again after a 429, which for
   * `followUp` could land past the 15 minutes the expiry check ran on. The
   * webhook takes the interaction's token and no bot token.
   */
  const webhooks = Generated.make(
    HttpClient.mapRequest(
      options.http,
      flow(
        HttpClientRequest.prependUrl(options.baseUrl),
        HttpClientRequest.setHeader("User-Agent", "DiscordBot (https://effect.website, 1)")
      )
    )
  )

  const fail = (op: string, reason: ChatErrorReason) => Effect.fail(Errors.chatError(op, reason))

  /** A message's elements as action rows, checked before any call. */
  const components = (op: string, actions: ReadonlyArray<Action> | undefined) => {
    const rows = Interactions.rows(actions ?? [])
    return Array.isArray(rows) ? Effect.succeed(rows) : fail(op, rows)
  }

  /** One REST call, its failure mapped to a `ChatError` and retried when nothing happened. */
  const call = <A, E>(op: string, effect: Effect.Effect<A, E>, write = false): Effect.Effect<A, ChatError> =>
    retrySafe(Effect.mapError(effect, (error) => Errors.chatError(op, Errors.reasonForRestError(error, { write }))))

  const resolve = (op: string, thread: ChatThread.ChatThread): Effect.Effect<string, ChatError> =>
    isAddress(thread) ? Effect.succeed(thread.id) : fail(op, Errors.invalidRequest("invalid_thread"))

  const getChannel = (op: string, id: string): Effect.Effect<Channel, ChatError> =>
    Effect.flatMap(call(op, rest.getChannel(id)), (raw: unknown) =>
      Option.match(decodeChannel(raw), {
        onNone: () => fail(op, Errors.invalidResponse(false, "invalid_channel")),
        onSome: (fields) => Effect.succeed({ ...fields, raw: raw as Json })
      }))

  /** Channels by id, for their type, parent and guild, none of which change. Failures are not kept. */
  const channels = yield* Cache.makeWith(
    (id: string) => getChannel("getChannel", id),
    {
      capacity: 1024,
      timeToLive: (exit) => Exit.isSuccess(exit) ? Duration.hours(1) : Duration.zero
    }
  )

  const channel = (op: string, id: string): Effect.Effect<Channel, ChatError> =>
    Cache.get(channels, id).pipe(
      Effect.mapError((error) => error.op === op ? error : Errors.chatError(op, error.reason))
    )

  const toMessage = (raw: unknown, botUserId: string): ChatMessage | undefined => {
    const fields = Normalize.decodeMessageFields(raw)
    return fields === undefined ? undefined : Normalize.message(raw as Json, fields, { botUserId })
  }

  const getMessage = (op: string, channelId: string, messageId: string): Effect.Effect<Json, ChatError> =>
    call(op, rest.getMessage(channelId, messageId)).pipe(Effect.map((raw) => raw as unknown as Json))

  const fetchMessage: ChatAdapter["fetchMessage"] = Effect.fnUntraced(function*(thread, messageId) {
    const op = "fetchMessage"
    const channelId = yield* resolve(op, thread)
    const botUserId = yield* options.botUserId
    const raw = yield* getMessage(op, channelId, messageId)
    const message = toMessage(raw, botUserId)
    return message === undefined ? yield* fail(op, Errors.notFound("not_a_message")) : message
  })

  /** The `interaction_expired` failure, with the reason Discord gave as its `cause`. */
  const expired = (op: string, cause?: ChatErrorReason) =>
    Errors.chatError(op, new NotFound({ detail: interactionExpired, ...(cause === undefined ? {} : { cause }) }))

  /** An optional read: none when the message is gone or the bot may not read it. */
  const orNone = <A>(effect: Effect.Effect<A, ChatError>): Effect.Effect<Option.Option<A>, ChatError> =>
    effect.pipe(
      Effect.map(Option.some),
      Effect.catchIf(
        (error) => error.reason._tag === "NotFound" || error.reason._tag === "Forbidden",
        () => Effect.succeed(Option.none())
      )
    )

  // Writes

  /**
   * A write's message, after the checks every write makes before a call.
   * `components` is absent when there are none.
   */
  const messageBody = Effect.fnUntraced(function*(
    op: string,
    content: { readonly markdown: string; readonly actions?: ReadonlyArray<Action> | undefined },
    postOptions: DiscordPostOptions
  ) {
    const rows = yield* components(op, content.actions)
    yield* checkMessageLength(descriptor, op, content.markdown)
    return {
      content: content.markdown,
      allowed_mentions: allowedMentions(postOptions.notify),
      flags: flags(postOptions),
      ...(rows.length === 0 ? {} : { components: rows })
    }
  })

  const toFile = (file: File) =>
    new globalThis.File([file.content as Uint8Array<ArrayBuffer>], file.name, { type: file.contentType })

  const post: ChatAdapter["post"] = Effect.fnUntraced(function*(thread, content) {
    const op = "post"
    const channelId = yield* resolve(op, thread)
    const postOptions = yield* CurrentPostOptions
    const body = yield* messageBody(op, content, postOptions)
    const files = content.files ?? []
    // The adapter's own count and size check refuses the file the way Discord would.
    if (
      files.length > descriptor.limits.filesPerMessage ||
      files.reduce((total, file) => total + file.content.length, 0) > descriptor.limits.uploadBytes
    ) {
      return yield* fail(op, new TooLarge({ subject: "files", detail: fileRefused }))
    }
    const create = rest.createMessage(channelId, {
      ...body,
      ...(content.replyTo === undefined ? {} : {
        message_reference: {
          message_id: content.replyTo.messageId,
          ...(postOptions.failIfNotExists === false ? { fail_if_not_exists: false } : {})
        }
      }),
      ...(files.length === 0 ? {} : { attachments: files.map((file, i) => ({ id: String(i), filename: file.name })) })
    })
    const answer = yield* (files.length === 0
      ? call(op, create, true)
      // Discord creates the message and its files in one request, so a denied answer left nothing posted.
      : call(op, rest.withFiles(files.map(toFile))(create), true).pipe(
        Effect.mapError((error) => Errors.chatError(op, Errors.fileRefused(error.reason)))
      ))
    if (typeof answer.id !== "string" || typeof answer.timestamp !== "string") {
      return yield* fail(op, Errors.invalidResponse(true, "missing_id"))
    }
    const timestamp = DateTime.make(answer.timestamp)
    if (Option.isNone(timestamp)) return yield* fail(op, Errors.invalidResponse(true, "invalid_timestamp"))
    return { id: answer.id, thread, timestamp: DateTime.toUtc(timestamp.value) } satisfies Posted
  })

  const edit: ChatAdapter["edit"] = Effect.fnUntraced(function*(thread, messageId, content) {
    const op = "edit"
    const channelId = yield* resolve(op, thread)
    const body = yield* messageBody(op, content, yield* CurrentPostOptions)
    // Send empty components to clear existing elements.
    yield* call(op, rest.updateMessage(channelId, messageId, { ...body, components: body.components ?? [] }), true)
  })

  const startThread: ChatAdapter["startThread"] = Effect.fnUntraced(function*(thread, messageId, startOptions) {
    const op = "startThread"
    const channelId = yield* resolve(op, thread)
    const postOptions = yield* CurrentPostOptions
    const given = nonEmpty(startOptions?.name?.trim())
    const name = given ?? (yield* Effect.map(
      getMessage(op, channelId, messageId),
      (raw) => {
        const text = isObject(raw) && typeof raw.content === "string" ? raw.content.replace(/\s+/g, " ").trim() : ""
        return text === "" ? "Thread" : Length.cut(text, 100)
      }
    ))
    return yield* call(
      op,
      rest.createThreadFromMessage(channelId, messageId, {
        name: Length.cut(name, 100),
        ...(postOptions.autoArchiveDuration === undefined
          ? {}
          : { auto_archive_duration: postOptions.autoArchiveDuration })
      }),
      true
    ).pipe(
      Effect.map((answer) => Normalize.thread(typeof answer.id === "string" ? answer.id : messageId)),
      // The thread under a message has the message's id.
      Effect.catchIf(Errors.hasCode(THREAD_ALREADY_CREATED), () => Effect.succeed(Normalize.thread(messageId))),
      // A message in a thread has no thread of its own: the thread is the answer.
      Effect.catchIf(Errors.hasCode(WRONG_CHANNEL_TYPE), (error) =>
        Effect.flatMap(
          channel(op, channelId),
          (found) => Normalize.isThreadType(found.type) ? Effect.succeed(thread) : Effect.fail(error)
        ))
    )
  })

  // Reads

  /**
   * A thread's messages, with the `THREAD_STARTER_MESSAGE` placeholder
   * replaced by the opener from the parent channel, or dropped when the
   * opener is gone.
   */
  const history: ChatAdapter["history"] = (thread, { direction, from }) =>
    Stream.unwrap(Effect.gen(function*() {
      const op = "history"
      const channelId = yield* resolve(op, thread)
      const botUserId = yield* options.botUserId
      const page = (cursor: string | undefined) =>
        call(
          op,
          rest.listMessages(
            channelId,
            direction === "backward"
              ? { ...(cursor === undefined ? {} : { before: cursor }), limit: pageSize }
              : { after: cursor ?? "0", limit: pageSize }
          )
        ).pipe(Effect.map((answer) => {
          const found: ReadonlyArray<Json> = Array.isArray(answer) ? answer as ReadonlyArray<Json> : []
          const sorted = [...found].sort((a, b) =>
            Normalize.compareIds(idOf(a), idOf(b)) * (direction === "backward" ? -1 : 1)
          )
          const last = sorted.at(-1)
          return [
            sorted,
            found.length < pageSize || last === undefined ? Option.none<string>() : Option.some(idOf(last))
          ] as const
        }))
      const after = (message: ChatMessage) =>
        from === undefined ||
        (direction === "forward"
          ? Normalize.compareIds(message.id, from) > 0
          : Normalize.compareIds(message.id, from) < 0)
      return Stream.paginate(from, page).pipe(
        Stream.mapEffect((raw) => resolveStarter(op, raw, botUserId)),
        Stream.filter((message): message is ChatMessage => message !== undefined && after(message))
      )
    }))

  const idOf = (raw: Json): string => isObject(raw) && typeof raw.id === "string" ? raw.id : ""

  const resolveStarter = (
    op: string,
    raw: Json,
    botUserId: string
  ): Effect.Effect<ChatMessage | undefined, ChatError> => {
    const fields = Normalize.decodeMessageFields(raw)
    if (fields === undefined) return Effect.succeed(undefined)
    if (fields.type !== Normalize.THREAD_STARTER_MESSAGE) {
      return Effect.succeed(Normalize.message(raw, fields, { botUserId }))
    }
    const referenced = isObject(raw) ? raw.referenced_message : undefined
    if (referenced === null) return Effect.succeed(undefined)
    if (referenced !== undefined) return Effect.succeed(toMessage(referenced, botUserId))
    const reference = fields.message_reference
    const channelId = nonEmpty(reference?.channel_id)
    const messageId = nonEmpty(reference?.message_id)
    if (channelId === undefined || messageId === undefined) return Effect.succeed(undefined)
    return orNone(getMessage(op, channelId, messageId)).pipe(
      Effect.map((found) => Option.isSome(found) ? toMessage(found.value, botUserId) : undefined)
    )
  }

  /**
   * The message whose id is the thread's: in the thread for a forum post,
   * otherwise in the parent channel.
   */
  const opener: ChatAdapter["opener"] = Effect.fnUntraced(function*(thread) {
    const op = "opener"
    const channelId = yield* resolve(op, thread)
    const found = yield* channel(op, channelId)
    if (!Normalize.isThreadType(found.type)) return Option.none()
    const botUserId = yield* options.botUserId
    const inThread = yield* orNone(getMessage(op, channelId, channelId))
    const parent = nonEmpty(found.parent_id)
    const raw = Option.isSome(inThread) || parent === undefined
      ? inThread
      : yield* orNone(getMessage(op, parent, channelId))
    return Option.flatMap(raw, (raw) => Option.fromUndefinedOr(toMessage(raw, botUserId)))
  })

  const getThread: ChatAdapter["getThread"] = Effect.fnUntraced(function*(thread) {
    const op = "getThread"
    const channelId = yield* resolve(op, thread)
    const found = yield* getChannel(op, channelId)
    const kind = Normalize.kindOf(found.type)
    const name = kind === "direct" ? undefined : nonEmpty(found.name)
    const topic = nonEmpty(found.topic)
    const parent = kind === "thread" ? nonEmpty(found.parent_id) : undefined
    const created = Option.flatMap(
      Option.fromUndefinedOr(nonEmpty(found.thread_metadata?.create_timestamp)),
      DateTime.make
    )
    const createdAt = Option.isSome(created) ? DateTime.toUtc(created.value) : Normalize.snowflakeTime(found.id)
    return {
      thread,
      kind,
      ...(name === undefined ? {} : { name }),
      ...(topic === undefined ? {} : { topic }),
      ...(parent === undefined ? {} : { parent: Normalize.thread(parent) }),
      ...(createdAt === undefined ? {} : { createdAt }),
      raw: found.raw
    } satisfies ThreadInfo
  })

  const getUser: ChatAdapter["getUser"] = Effect.fnUntraced(function*(id, userOptions) {
    const op = "getUser"
    const botUserId = yield* options.botUserId
    const toUser = (user: typeof UserFields.Type, nick: string | null | undefined, raw: unknown): User => ({
      id: user.id,
      name: nonEmpty(nick) ?? nonEmpty(user.global_name) ?? nonEmpty(user.username) ?? user.id,
      isBot: user.bot === true,
      isSelf: user.id === botUserId,
      raw: raw as Json
    })
    const where = userOptions?.in
    const guildId = where === undefined
      ? undefined
      : nonEmpty((yield* channel(op, yield* resolve(op, where))).guild_id)
    if (guildId !== undefined) {
      const member = yield* orNone(call(op, rest.getGuildMember(guildId, id)))
      if (Option.isSome(member)) {
        const fields = Option.getOrUndefined(decodeMember(member.value))
        const user = fields?.user
        if (fields !== undefined && user !== null && user !== undefined) return toUser(user, fields.nick, member.value)
      }
    }
    const raw = yield* call(op, rest.getUser(id))
    const user = Option.getOrUndefined(decodeUser(raw))
    if (user === undefined) return yield* fail(op, Errors.invalidResponse(false, "invalid_user"))
    return toUser(user, undefined, raw)
  })

  const download: ChatAdapter["download"] = (thread, attachment, { maxBytes }) =>
    Stream.unwrap(Effect.gen(function*() {
      const op = "download"
      const channelId = yield* resolve(op, thread)
      const tooLarge = Errors.chatError(op, new TooLarge({ subject: "files", detail: "max_bytes" }))
      const transport = (error: { readonly reason: { readonly _tag: string } }) =>
        Errors.chatError(op, Errors.transport(false, error.reason._tag, error))
      if (attachment.size !== undefined && attachment.size > maxBytes) return yield* Effect.fail(tooLarge)
      const ids = Normalize.parseAttachmentId(attachment.id)
      if (ids === undefined) return yield* fail(op, Errors.invalidRequest("invalid_attachment"))
      const raw = yield* getMessage(op, channelId, ids.messageId)
      const list = isObject(raw) && Array.isArray(raw.attachments) ? raw.attachments : []
      const found = list.find((item) => isObject(item) && item.id === ids.attachmentId)
      const url = isObject(found) && typeof found.url === "string" ? found.url : undefined
      if (url === undefined) return yield* fail(op, Errors.notFound("attachment_not_found"))
      const response = yield* Effect.mapError(options.http.execute(HttpClientRequest.get(url)), transport)
      if (response.status < 200 || response.status >= 300) {
        return yield* fail(op, Errors.reasonForResponse(response.status, undefined, { write: false }))
      }
      let received = 0
      return response.stream.pipe(
        Stream.mapError(transport),
        Stream.mapEffect((chunk) => {
          received += chunk.length
          return received > maxBytes ? Effect.fail(tooLarge) : Effect.succeed(chunk)
        })
      )
    }))

  /**
   * The message a `post` of the same content sends with the default post
   * options, after the same checks: no mentions and no embeds.
   * `withPostOptions` does not reach a command's answer.
   */
  const answerBody = (
    op: string,
    content: { readonly markdown: string; readonly actions?: ReadonlyArray<Action> | undefined }
  ) => messageBody(op, content, {})

  /**
   * Edits the original response of a deferred command in one HTTP request:
   * not through `call`, nor dfx's client, whose retries would send again
   * after the expiry check. Refused before the call past `followUpAge`,
   * read from the interaction's id. A token Discord no longer takes is
   * `interaction_expired` too.
   */
  const followUp: ChatAdapter["followUp"] = Effect.fnUntraced(function*(deferred, content) {
    const op = "followUp"
    const to = isAddress(deferred.command.thread) ? Interactions.followUpTo(deferred.command.raw) : undefined
    if (to === undefined || !snowflake.test(to.id)) return yield* fail(op, Errors.invalidRequest("invalid_interaction"))
    const now = yield* Clock.currentTimeMillis
    if (now - Normalize.snowflakeMillis(to.id) >= Duration.toMillis(descriptor.limits.followUpAge!)) {
      return yield* Effect.fail(expired(op))
    }
    const body = yield* answerBody(op, content)
    yield* webhooks.updateOriginalWebhookMessage(to.applicationId, to.token, {
      payload: Interactions.withVisibility(body, deferred.visibility)
    }).pipe(Effect.mapError((cause) => {
      const error = Errors.chatError(op, Errors.reasonForRestError(cause, { write: true }))
      return SPENT_TOKEN.some((code) => Errors.hasCode(code)(error)) ? expired(op, error.reason) : error
    }))
  })

  const adapter: ChatAdapter = {
    descriptor,
    post,
    edit,
    followUp,
    delete: Effect.fnUntraced(function*(thread, messageId) {
      const channelId = yield* resolve("delete", thread)
      yield* call("delete", rest.deleteMessage(channelId, messageId), true)
    }),
    fetchMessage,
    history,
    download,
    startThread,
    getThread,
    opener,
    getUser
  }

  /** The guild a channel or thread is in, from the cached channel. */
  const guild = (thread: ChatThread.ChatThread): Effect.Effect<Option.Option<string>, ChatError> =>
    Effect.flatMap(
      resolve("guild", thread),
      (id) => Effect.map(channel("guild", id), (found) => Option.fromUndefinedOr(nonEmpty(found.guild_id)))
    )

  /** A channel's type, for `dispatch`. */
  const channelType = (id: string): Effect.Effect<number, ChatError> =>
    Effect.map(channel("dispatch", id), (found) => found.type)

  // Interactions

  /** One callback, Discord's answer to an interaction. */
  const callback = (
    op: string,
    to: { readonly id: string; readonly token: string },
    payload: Discord.CreateInteractionResponseRequest
  ): Effect.Effect<void, ChatError> =>
    Effect.asVoid(call(op, rest.createInteractionResponse(to.id, to.token, { payload }), true))

  const logged = (effect: Effect.Effect<void, ChatError>) =>
    Effect.catch(effect, (error) => Effect.logWarning("@effect/chat-discord: an interaction callback failed", error))

  /**
   * Normalises an `INTERACTION_CREATE` payload, runs the handler inside
   * `deadline` and answers through the callback endpoint.
   */
  const interaction = (
    raw: unknown,
    interactionOptions?: { readonly deadline?: Duration.Duration | undefined }
  ): Effect.Effect<void, never, ChatInteraction.Handler> =>
    Effect.gen(function*() {
      const event = Interactions.normalize(raw)
      const to = Interactions.answerTo(raw)
      if (Option.isNone(event) || to === undefined) return
      const reply = yield* ChatInteraction.handle(event.value, interactionOptions?.deadline ?? Duration.seconds(2))
      switch (reply._tag) {
        // Too late to answer: Discord shows its own banner.
        case "Late":
          return
        case "Ack":
        case "Close":
          // Type 6 is no answer to a command, so an unhandled one is left to whoever owns it.
          if (event.value._tag === "CommandInvoked") return
          return yield* logged(callback("ack", to, Interactions.ackCallback))
        case "Errors":
          return yield* logged(callback("errors", to, Interactions.errorsCallback(reply.errors)))
        case "OpenModal": {
          const from = event.value as
            | ChatInteraction.ButtonClicked
            | ChatInteraction.SelectChanged
            | ChatInteraction.CommandInvoked
          const data = Interactions.modalData(reply.modal)
          if (!("custom_id" in data)) {
            // A click is still answered, so the person sees no failure for a modal that could not be built.
            // A command has no silent answer, so it gets none, and Discord shows its own failure.
            if (from._tag !== "CommandInvoked") yield* logged(callback("ack", to, Interactions.ackCallback))
            const handler = yield* ChatInteraction.Handler
            return yield* handler.refused(from, Errors.chatError("openModal", data))
          }
          return yield* answer(from, "openModal", to, Effect.succeed(Interactions.modalCallback(data)))
        }
        case "Respond":
          return yield* answer(
            event.value as ChatInteraction.CommandInvoked,
            "respond",
            to,
            Effect.map(answerBody("respond", reply), (body) => Interactions.respondCallback(body, reply.visibility))
          )
        case "Defer":
          return yield* answer(
            event.value as ChatInteraction.CommandInvoked,
            "defer",
            to,
            Effect.succeed(Interactions.deferCallback(reply.visibility))
          )
      }
    })

  /**
   * Sends a reply that must land, or tells `Handler.refused`: a reply that
   * fails its checks sends nothing, and a callback that comes back
   * `Unknown interaction` was late, which is `interaction_expired`.
   */
  const answer = (
    event: ChatInteraction.ButtonClicked | ChatInteraction.SelectChanged | ChatInteraction.CommandInvoked,
    op: string,
    to: { readonly id: string; readonly token: string },
    payload: Effect.Effect<Discord.CreateInteractionResponseRequest, ChatError>
  ): Effect.Effect<void, never, ChatInteraction.Handler> =>
    Effect.gen(function*() {
      const handler = yield* ChatInteraction.Handler
      yield* Effect.flatMap(payload, (built) => callback(op, to, built)).pipe(
        Effect.catch((error) =>
          handler.refused(
            event,
            Errors.hasCode(UNKNOWN_INTERACTION)(error) ? expired(op, error.reason) : error
          )
        )
      )
    })

  return { adapter, guild, channelType, interaction }
})
