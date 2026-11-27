import {
  type ChatAdapter,
  checkMessageLength,
  type Descriptor,
  type File,
  type Posted,
  type ThreadInfo
} from "effect/chat/ChatAdapter"
import { type Capability, type ChatError, interactionExpired } from "effect/chat/ChatError"
import type * as ChatInteraction from "effect/chat/ChatInteraction"
import type { ChatThread } from "effect/chat/ChatThread"
import type * as ChatUi from "effect/chat/ChatUi"
import * as DateTime from "effect/DateTime"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Stream from "effect/Stream"
import type { TelegramBotApi } from "../TelegramBotApi.ts"
import * as Actions from "./actions.ts"
import * as Address from "./address.ts"
import * as Errors from "./errors.ts"
import * as Markdown from "./markdown.ts"
import { displayName, fullName, integer, messageOf, object, string } from "./normalize.ts"
import { CurrentPostOptions, type PostOptions } from "./options.ts"

/** Capabilities that are built but not yet confirmed against Telegram. @internal */
export interface Unverified {
  readonly files?: boolean | undefined
  readonly buttons?: boolean | undefined
  readonly commands?: boolean | undefined
}

/** @internal */
export const capabilitiesOf = (unverified: Unverified): ReadonlySet<Capability> => {
  const set = new Set<Capability>(["edit", "delete", "replyTo", "download", "getThread", "getUser"])
  if (unverified.files === true) set.add("files")
  if (unverified.buttons === true) set.add("buttons")
  if (unverified.commands === true) set.add("commands")
  return set
}

/** How long Telegram takes an answer to a command, from the command's `date`. @internal */
export const followUpAge = Duration.seconds(15)

/** The largest file the cloud Bot API server hands out. @internal */
export const downloadLimit = 20 * 1024 * 1024

/** @internal */
export const descriptorOf = (capabilities: ReadonlySet<Capability>): Descriptor => ({
  platform: Address.platform,
  capabilities,
  measure: (markdown) => Markdown.measure(markdown),
  limits: {
    messageLength: Markdown.messageLength,
    filesPerMessage: capabilities.has("files") ? Markdown.filesPerMessage : 0,
    uploadBytes: 50 * 1024 * 1024,
    minWriteInterval: Duration.seconds(3),
    ...(capabilities.has("buttons")
      ? { actionsPerMessage: Actions.actionsPerMessage, actionDataLength: Actions.actionDataLength }
      : {}),
    ...(capabilities.has("commands") ? { followUpAge } : {})
  }
})

/** Where a command's answer goes: the chat it came from, and the message to reply to, if any. @internal */
export interface Origin {
  readonly thread: ChatThread
  readonly replyTo?: number | undefined
  /** The command's `date`, in seconds. */
  readonly date: number
}

/**
 * Where a command's answers go. A reply to an ephemeral command would have
 * to be ephemeral itself, and a reply would quote the private prompt, so
 * a public answer to one is a new post.
 *
 * @internal
 */
export const originOf = (command: ChatInteraction.CommandInvoked): Origin | undefined => {
  const message = messageOf(command.raw)
  const id = integer(message, "message_id")
  const date = integer(message, "date")
  if (id === undefined || date === undefined) return undefined
  return { thread: command.thread, ...(id === 0 ? {} : { replyTo: id }), date }
}

/** @internal */
export const make = (options: {
  readonly api: TelegramBotApi["Service"]
  readonly capabilities: ReadonlySet<Capability>
}) => {
  const { api, capabilities } = options
  const descriptor = descriptorOf(capabilities)

  const unsupported = (op: string, capability: Capability) => Errors.fail(op, Errors.unsupported(capability))

  const resolve = (op: string, thread: ChatThread): Effect.Effect<Address.Parts, ChatError> => {
    const parts = Address.parts(thread)
    return Option.isNone(parts) ? Errors.fail(op, Errors.invalidRequest("invalid_thread")) : Effect.succeed(parts.value)
  }

  const target = (parts: Address.Parts) => ({
    chat_id: Number(parts.chatId),
    ...(parts.messageThreadId === undefined ? {} : { message_thread_id: Number(parts.messageThreadId) })
  })

  /** A message id Telegram can act on, or `NotFound` without a call: a private answer's label reaches nothing. */
  const messageId = (op: string, id: string): Effect.Effect<number, ChatError> => {
    const n = Address.numericId(id)
    return n === undefined ? Errors.fail(op, Errors.notFound("message_not_found")) : Effect.succeed(n)
  }

  const markup = (op: string, actions: ReadonlyArray<ChatUi.Action>) => {
    if (actions.length === 0) return Effect.succeed(undefined)
    if (actions.some((action) => action._tag === "Select")) return unsupported(op, "selects")
    if (!capabilities.has("buttons")) return unsupported(op, "buttons")
    const keyboard = Actions.keyboard(actions)
    return "inline_keyboard" in keyboard ? Effect.succeed(keyboard) : Errors.fail(op, keyboard)
  }

  const checkFiles = (op: string, files: ReadonlyArray<File>) => {
    if (files.length === 0) return Effect.void
    if (!capabilities.has("files")) return unsupported(op, "files")
    const refused = files.length > descriptor.limits.filesPerMessage ||
      files.some((file) => file.content.length > descriptor.limits.uploadBytes)
    return refused ? Errors.fail(op, Errors.refusedFile) : Effect.void
  }

  const richMessage = (markdown: string, files: number, postOptions: PostOptions) => ({
    markdown: Markdown.render(markdown, { mentions: new Set(postOptions.notify?.users ?? []), files }),
    skip_entity_detection: true,
    ...(files === 0 ? {} : {
      media: Array.from({ length: files }, (_, i) => ({
        id: `f${i + 1}`,
        media: { type: "document", media: `attach://f${i + 1}` }
      }))
    })
  })

  const posted = (op: string, thread: ChatThread, answer: unknown): Effect.Effect<Posted, ChatError> => {
    const id = integer(answer, "message_id")
    const date = integer(answer, "date")
    if (id === undefined || id === 0) return Errors.fail(op, Errors.invalidResponse(true, "missing_message_id"))
    return Effect.map(
      date === undefined ? DateTime.now : Effect.succeed(DateTime.makeUnsafe(date * 1000)),
      (timestamp) => ({ id: String(id), thread, timestamp })
    )
  }

  /** One `sendRichMessage`. `retry` false for answers, which are never retried. */
  const send = Effect.fnUntraced(function*(op: string, thread: ChatThread, content: {
    readonly markdown: string
    readonly actions?: ReadonlyArray<ChatUi.Action> | undefined
    readonly files?: ReadonlyArray<File> | undefined
    readonly replyTo?: number | undefined
    readonly retry?: boolean | undefined
  }) {
    const parts = yield* resolve(op, thread)
    const actions = content.actions ?? []
    const files = content.files ?? []
    const replyMarkup = yield* markup(op, actions)
    yield* checkFiles(op, files)
    yield* checkMessageLength(descriptor, op, content.markdown, actions)
    if (content.markdown.trim() === "" && files.length === 0) {
      return yield* Errors.fail(op, Errors.invalidRequest("empty_message"))
    }
    const postOptions = yield* CurrentPostOptions
    const answer = yield* api.call("sendRichMessage", {
      ...target(parts),
      rich_message: richMessage(content.markdown, files.length, postOptions),
      ...(content.replyTo === undefined
        ? {}
        : { reply_parameters: { message_id: content.replyTo, allow_sending_without_reply: false } }),
      ...(replyMarkup === undefined ? {} : { reply_markup: replyMarkup }),
      ...(postOptions.silent === true ? { disable_notification: true } : {})
    }, {
      write: true,
      retry: content.retry,
      files: files.map((file, i) => ({ field: `f${i + 1}`, file }))
    }).pipe(Effect.mapError(Errors.withOp(op)))
    return yield* posted(op, thread, answer)
  })

  const post: ChatAdapter["post"] = Effect.fnUntraced(function*(thread, content) {
    const replyTo = content.replyTo === undefined ? undefined : yield* messageId("post", content.replyTo.messageId)
    return yield* send("post", thread, { ...content, replyTo })
  })

  const edit: ChatAdapter["edit"] = Effect.fnUntraced(function*(thread, id, content) {
    const op = "edit"
    const parts = yield* resolve(op, thread)
    const message = yield* messageId(op, id)
    const actions = content.actions ?? []
    const replyMarkup = yield* markup(op, actions)
    yield* checkMessageLength(descriptor, op, content.markdown, actions)
    if (content.markdown.trim() === "") return yield* Errors.fail(op, Errors.invalidRequest("empty_message"))
    yield* api.call("editMessageText", {
      chat_id: Number(parts.chatId),
      message_id: message,
      rich_message: richMessage(content.markdown, 0, yield* CurrentPostOptions),
      // An edit replaces the whole message: no actions removes the keyboard.
      reply_markup: replyMarkup ?? { inline_keyboard: [] }
    }, { write: true }).pipe(
      Effect.catchIf(
        (error) => error.reason._tag === "InvalidRequest" && error.reason.detail === "not_modified",
        () => Effect.void
      ),
      Effect.mapError(Errors.withOp(op))
    )
  })

  const deleteMessage: ChatAdapter["delete"] = Effect.fnUntraced(function*(thread, id) {
    const op = "delete"
    const parts = yield* resolve(op, thread)
    const message = yield* messageId(op, id)
    yield* api.call("deleteMessage", { chat_id: Number(parts.chatId), message_id: message }, { write: true }).pipe(
      Effect.mapError(Errors.withOp(op))
    )
  })

  const download: ChatAdapter["download"] = (thread, attachment, { maxBytes }) =>
    Stream.unwrap(Effect.gen(function*() {
      const op = "download"
      yield* resolve(op, thread)
      const limit = Math.min(maxBytes, downloadLimit)
      const tooLarge = Errors.tooLarge("files", "max_bytes")
      if (attachment.size !== undefined && attachment.size > limit) return yield* Errors.fail(op, tooLarge)
      const answer = yield* api.call("getFile", { file_id: attachment.id }).pipe(Effect.mapError(Errors.withOp(op)))
      const path = string(answer, "file_path")
      const size = integer(answer, "file_size")
      if (size !== undefined && size > limit) return yield* Errors.fail(op, tooLarge)
      if (path === undefined) return yield* Errors.fail(op, Errors.invalidResponse(false, "missing_file_path"))
      return api.file(path, { maxBytes: limit })
    }))

  const getThread: ChatAdapter["getThread"] = Effect.fnUntraced(function*(thread) {
    const op = "getThread"
    const parts = yield* resolve(op, thread)
    const answer = yield* api.call("getChat", { chat_id: Number(parts.chatId) }).pipe(
      Effect.mapError(Errors.withOp(op))
    )
    if (parts.messageThreadId !== undefined) {
      return { thread, kind: "thread", parent: Address.thread(parts.chatId), raw: answer } satisfies ThreadInfo
    }
    const name = string(answer, "title") ?? (fullName(answer) || undefined)
    const topic = string(answer, "description")
    return {
      thread,
      kind: string(answer, "type") === "private" ? "direct" : "channel",
      ...(name === undefined ? {} : { name }),
      ...(topic === undefined ? {} : { topic }),
      raw: answer
    } satisfies ThreadInfo
  })

  const getUser: ChatAdapter["getUser"] = Effect.fnUntraced(function*(id, userOptions) {
    const op = "getUser"
    if (userOptions?.in === undefined) return yield* Errors.fail(op, Errors.invalidRequest("in_required"))
    const parts = yield* resolve(op, userOptions.in)
    const userId = Address.numericId(id)
    if (userId === undefined) return yield* Errors.fail(op, Errors.notFound("user_not_found"))
    const answer = yield* api.call("getChatMember", { chat_id: Number(parts.chatId), user_id: userId }).pipe(
      Effect.mapError(Errors.withOp(op))
    )
    const user = object(answer, "user")
    if (user === undefined || String(integer(user, "id")) !== id) {
      return yield* Errors.fail(op, Errors.invalidResponse(false, "missing_user"))
    }
    return {
      id,
      name: displayName(user) ?? id,
      isBot: user.is_bot === true,
      isSelf: id === api.botId,
      raw: answer
    }
  })

  /** A public answer to a command. Never retried, so a timeout can't post it twice. @internal */
  const answer = (op: string, origin: Origin, content: {
    readonly markdown: string
    readonly actions?: ReadonlyArray<ChatUi.Action> | undefined
  }): Effect.Effect<Posted, ChatError> =>
    send(op, origin.thread, { ...content, replyTo: origin.replyTo, retry: false }).pipe(
      Effect.provideService(CurrentPostOptions, {})
    )

  const followUp: ChatAdapter["followUp"] = Effect.fnUntraced(function*(deferred, content) {
    const op = "followUp"
    if (!capabilities.has("commands")) return yield* unsupported(op, "commands")
    if (deferred.visibility === "ephemeral") return yield* unsupported(op, "ephemeral")
    const origin = originOf(deferred.command)
    if (origin === undefined) return yield* Errors.fail(op, Errors.invalidRequest("invalid_command"))
    const now = yield* DateTime.now
    const deadline = (origin.date + 1) * 1000 + Duration.toMillis(followUpAge)
    if (DateTime.toEpochMillis(now) > deadline) return yield* Errors.fail(op, Errors.notFound(interactionExpired))
    yield* answer(op, origin, content)
  })

  const adapter: ChatAdapter = {
    descriptor,
    post,
    edit,
    delete: deleteMessage,
    fetchMessage: () => unsupported("fetchMessage", "fetchMessage"),
    history: () => Stream.fail(Errors.chatError("history", Errors.unsupported("history"))),
    download,
    startThread: () => unsupported("startThread", "startThread"),
    getThread,
    opener: () => unsupported("opener", "opener"),
    getUser,
    followUp
  }

  return { adapter, answer }
}

/** @internal */
export type Made = ReturnType<typeof make>
