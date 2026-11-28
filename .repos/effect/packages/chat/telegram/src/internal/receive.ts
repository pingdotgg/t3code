import type { Capability, ChatError } from "effect/chat/ChatError"
import type * as ChatEvent from "effect/chat/ChatEvent"
import type { NotAccepted } from "effect/chat/ChatHandler"
import * as ChatInteraction from "effect/chat/ChatInteraction"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import type * as Schema from "effect/Schema"
import type { TelegramBotApi } from "../TelegramBotApi.ts"
import * as Actions from "./actions.ts"
import type { Made } from "./adapter.ts"
import { originOf } from "./adapter.ts"
import * as Errors from "./errors.ts"
import {
  commandOf,
  type Context,
  integer,
  isEphemeral,
  isExcluded,
  isObject,
  type JsonObject,
  messageCreated,
  messageIdOf,
  messageOf,
  object,
  string,
  threadOf
} from "./normalize.ts"

/**
 * What became of one update.
 *
 * - `accepted`: its event was accepted, or its interaction was answered.
 * - `unhandled`: it gave nothing, and went to `onUnhandled`.
 * - `notAccepted`: the `ChatHandler` refused its event, or it passed the deadline.
 * - `invalid`: it should give an event and could not be read.
 *
 * @internal
 */
export type Outcome = "accepted" | "unhandled" | "notAccepted" | "invalid"

/** @internal */
export const defaults = {
  deadline: Duration.seconds(10),
  clickDeadline: Duration.millis(2500),
  commandDeadline: Duration.seconds(10)
} as const

/** The update types the adapter reads, for `allowed_updates`. @internal */
export const allowedUpdates = ["message", "channel_post", "callback_query"] as const

/** @internal */
export interface Options {
  readonly onUnhandled?: ((update: Schema.Json) => Effect.Effect<void>) | undefined
  readonly deadline?: Duration.Input | undefined
  readonly clickDeadline?: Duration.Input | undefined
  readonly commandDeadline?: Duration.Input | undefined
}

/** @internal */
export interface Environment {
  readonly api: TelegramBotApi["Service"]
  readonly capabilities: ReadonlySet<Capability>
  readonly answer: Made["answer"]
  /** The bot's username, read once from `getMe`. */
  readonly username: Effect.Effect<string, ChatError>
}

const duration = (input: Duration.Input | undefined, fallback: Duration.Duration) =>
  input === undefined ? fallback : Duration.fromInputUnsafe(input)

/** Modals are not in this version: an `OpenModal` reply is refused. */
const refuseModal = (
  handler: ChatInteraction.Handler["Service"],
  event: ChatInteraction.ButtonClicked | ChatInteraction.CommandInvoked
) => handler.refused(event, Errors.chatError("openModal", Errors.unsupported("modals")))

const answerQuery = (api: TelegramBotApi["Service"], id: string) =>
  api.call("answerCallbackQuery", { callback_query_id: id }, { write: true, retry: false }).pipe(
    Effect.catch((error) =>
      Effect.logWarning("telegram: answerCallbackQuery failed").pipe(
        Effect.annotateLogs({ "chat.error.reason": error.reason._tag })
      )
    )
  )

/** A callback the adapter leaves alone: inline mode, a game, or an excluded context. */
const isForeignCallback = (query: JsonObject): boolean => {
  const message = object(query, "message")
  return message === undefined || typeof query.data !== "string" || isExcluded(message)
}

/**
 * The click of a `callback_query`, only when its `data` is the
 * `callback_data` of a button in Telegram's own copy of the message:
 * `data` comes from the client and can be anything. Undefined for an
 * inaccessible message, a message with no keyboard, or a mismatch.
 *
 * @internal
 */
export const clickEvent = (update: JsonObject): ChatInteraction.ButtonClicked | undefined => {
  const query = object(update, "callback_query")
  const message = object(query, "message")
  const data = string(query, "data")
  if (query === undefined || message === undefined || data === undefined || isForeignCallback(query)) return undefined
  const user = integer(object(query, "from"), "id")
  const at = threadOf(message)
  const messageId = messageIdOf(message)
  if (
    integer(message, "date") === 0 || !Actions.keyboardData(message.reply_markup).has(data) ||
    user === undefined || at === undefined || messageId === undefined
  ) return undefined
  const parsed = Actions.parseData(data)
  return ChatInteraction.ButtonClicked.make({
    id: parsed.id,
    ...(parsed.value === undefined ? {} : { value: parsed.value }),
    thread: at.thread,
    messageId,
    userId: String(user),
    raw: update
  })
}

/** A click. Every click is answered, since the client shows a progress bar until it is. */
const click = (
  update: JsonObject,
  id: string,
  env: Environment,
  options: Options,
  handler: Option.Option<ChatInteraction.Handler["Service"]>
): Effect.Effect<void> =>
  Effect.gen(function*() {
    const answer = answerQuery(env.api, id)
    if (Option.isNone(handler) || !env.capabilities.has("buttons")) return yield* answer
    const event = clickEvent(update)
    if (event === undefined) {
      yield* Effect.logWarning("telegram: a click matched no button on its message, answered and dropped").pipe(
        Effect.annotateLogs({ "chat.interaction.reason": "InvalidValue" })
      )
      return yield* answer
    }
    const reply = yield* Effect.provideService(
      ChatInteraction.handle(event, duration(options.clickDeadline, defaults.clickDeadline)),
      ChatInteraction.Handler,
      handler.value
    )
    yield* answer
    if (reply._tag === "OpenModal") yield* refuseModal(handler.value, event)
  })

/** The command of a message update, for this bot. @internal */
export const commandEvent = (update: JsonObject, context: Context): ChatInteraction.CommandInvoked | undefined => {
  const message = messageOf(update)
  if (message === undefined || isExcluded(message)) return undefined
  const found = commandOf(message, context)
  const at = threadOf(message)
  // As in `normalize`: an anonymous admin's `from` is Telegram's shared stand-in, the chat is the sender.
  const user = integer(object(message, "sender_chat"), "id") ?? integer(object(message, "from"), "id")
  if (found === undefined || at === undefined || user === undefined) return undefined
  return ChatInteraction.CommandInvoked.make({
    id: found.id,
    text: found.text,
    thread: at.thread,
    userId: String(user),
    raw: update
  })
}

/**
 * A command. `false` when it was not handled: no handler, no
 * `commands`, or an `Ack`, which means no definition matched.
 */
const command = (
  event: ChatInteraction.CommandInvoked,
  env: Environment,
  options: Options,
  handler: Option.Option<ChatInteraction.Handler["Service"]>
): Effect.Effect<boolean> =>
  Effect.gen(function*() {
    if (Option.isNone(handler) || !env.capabilities.has("commands")) return false
    const reply = yield* Effect.provideService(
      ChatInteraction.handle(event, duration(options.commandDeadline, defaults.commandDeadline)),
      ChatInteraction.Handler,
      handler.value
    )
    switch (reply._tag) {
      case "Ack":
        return false
      case "Late":
      case "Defer":
        return true
      case "OpenModal":
        yield* refuseModal(handler.value, event)
        return true
      case "Respond": {
        // No `ephemeral` in this version: a private answer is refused, never posted.
        if (reply.visibility === "ephemeral") {
          yield* handler.value.refused(event, Errors.chatError("respond", Errors.unsupported("ephemeral")))
          return true
        }
        const origin = originOf(event)
        if (origin === undefined) return true
        yield* env.answer("respond", origin, {
          markdown: reply.markdown,
          ...(reply.actions === undefined ? {} : { actions: reply.actions })
        }).pipe(Effect.catch((error) => handler.value.refused(event, error)))
        return true
      }
    }
  })

/**
 * One update, as both transports run it.
 *
 * - A click goes to `ChatInteraction.Handler` and is answered.
 * - An ephemeral message only ever takes the command path. Whatever its
 *   answer, it never reaches `ChatHandler` or `onUnhandled`.
 * - A command goes to `ChatInteraction.Handler`. One answered `Ack`
 *   continues as an ordinary message.
 * - A message with content becomes `MessageCreated` for `ChatHandler`,
 *   within `deadline`.
 * - Anything else, including the excluded contexts, goes to `onUnhandled`.
 *
 * @internal
 */
export const receive = (
  update: unknown,
  env: Environment,
  options: Options,
  handle: (event: ChatEvent.ChatEvent) => Effect.Effect<void, NotAccepted>
): Effect.Effect<Outcome> =>
  Effect.gen(function*() {
    if (!isObject(update) || integer(update, "update_id") === undefined) return "invalid"
    const unhandled = Effect.as(options.onUnhandled?.(update) ?? Effect.void, "unhandled" as const)
    const handler = yield* Effect.serviceOption(ChatInteraction.Handler)
    const query = object(update, "callback_query")
    if (query !== undefined) {
      const id = string(query, "id")
      if (isForeignCallback(query)) {
        // A business chat's button is answered, so its client stops waiting, but never dispatched.
        const message = object(query, "message")
        if (id !== undefined && message !== undefined && isExcluded(message)) yield* answerQuery(env.api, id)
        return yield* unhandled
      }
      if (id === undefined) return "invalid"
      return yield* Effect.as(click(update, id, env, options, handler), "accepted" as const)
    }
    const message = messageOf(update)
    if (message === undefined || isExcluded(message)) return yield* unhandled
    const username = yield* Effect.option(env.username)
    if (Option.isNone(username)) return "invalid"
    const context: Context = { botId: env.api.botId, botUsername: username.value, environment: env.api.environment }
    const found = commandEvent(update, context)
    if (isEphemeral(message)) {
      if (found !== undefined) yield* command(found, env, options, handler)
      return "accepted"
    }
    if (integer(message, "message_id") === 0) return yield* unhandled
    if (found !== undefined && (yield* command(found, env, options, handler))) return "accepted"
    const event = messageCreated(update, context)
    if (event === "none") return yield* unhandled
    if (event === "invalid") return "invalid"
    return yield* handle(event).pipe(
      Effect.timeoutOption(duration(options.deadline, defaults.deadline)),
      Effect.map(Option.match({ onNone: () => "notAccepted" as const, onSome: () => "accepted" as const })),
      Effect.catchTag("NotAccepted", () => Effect.succeed("notAccepted" as const))
    )
  })
