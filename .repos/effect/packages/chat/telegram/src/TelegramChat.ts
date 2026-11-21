/**
 * The Telegram adapter for `effect/chat`, over the Bot API: the `Registry`
 * layer, the webhook and polling transports, the pure normaliser and the
 * address helpers.
 *
 * **Details**
 *
 * - Raw REST over `HttpClient`, through `TelegramBotApi`, which keeps the
 *   bot token out of spans and errors.
 * - Posts and edits are rich messages (`sendRichMessage`,
 *   `editMessageText` with `rich_message`), in Markdown escaped so that
 *   consumer text reaches no raw HTML, image, math, spoiler or non-web
 *   link.
 * - The base live checks ran against production. Files, buttons and
 *   commands need further checks, so they are behind `unverified`
 *   options, off by default.
 * - There is no `ephemeral`: a private answer to a command is refused
 *   through `Handler.refused`, never posted. `fetchMessage`, `history`,
 *   `opener`, `startThread`, selects, modals, native streams and reaction
 *   events are not in this version.
 *
 * @stability unstable
 * @since 4.1.5
 */
import * as ByteSize from "effect/ByteSize"
import { Registry } from "effect/chat/ChatAdapter"
import type { ChatError } from "effect/chat/ChatError"
import type { ChatEvent } from "effect/chat/ChatEvent"
import { ChatHandler } from "effect/chat/ChatHandler"
import type * as ChatInteraction from "effect/chat/ChatInteraction"
import type { ParseMention } from "effect/chat/ChatTest"
import type { ChatThread } from "effect/chat/ChatThread"
import * as Context from "effect/Context"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import { dual } from "effect/Function"
import type * as HttpClient from "effect/http/HttpClient"
import * as HttpRouter from "effect/http/HttpRouter"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import type * as Redacted from "effect/Redacted"
import type * as Schema from "effect/Schema"
import * as Adapter from "./internal/adapter.ts"
import * as Address from "./internal/address.ts"
import * as Commands from "./internal/commands.ts"
import * as Errors from "./internal/errors.ts"
import * as Normalize from "./internal/normalize.ts"
import { CurrentPostOptions } from "./internal/options.ts"
import * as Polling from "./internal/polling.ts"
import * as Receive from "./internal/receive.ts"
import * as Webhook from "./internal/webhook.ts"
import * as TelegramBotApi from "./TelegramBotApi.ts"

/**
 * Capabilities that are built but stay off until their live checks pass.
 *
 * **Details**
 *
 * - `files`: rich-message media sent as multipart `attach://` parts,
 *   up to 10 per post and 50 MB each.
 * - `buttons`: inline keyboards. A click is dispatched only when its
 *   `data` matches a button in Telegram's copy of the message.
 * - `commands`: messages that start with a `bot_command` for this bot.
 *
 * @stability unstable
 * @category models
 * @since 4.1.5
 */
export interface Unverified {
  readonly files?: boolean | undefined
  readonly buttons?: boolean | undefined
  readonly commands?: boolean | undefined
}

/**
 * What became of one update given to `receive`.
 *
 * **Details**
 *
 * - `accepted`: its event was accepted, or its click or command was
 *   answered, refused or not.
 * - `unhandled`: it gave nothing and went to `onUnhandled`.
 * - `notAccepted`: the `ChatHandler` failed `NotAccepted` or passed
 *   `deadline`.
 * - `invalid`: it is not an update, or it should give an event and could
 *   not be read.
 *
 * @stability unstable
 * @category models
 * @since 4.1.5
 */
export type Outcome = "accepted" | "unhandled" | "notAccepted" | "invalid"

/**
 * Options for running updates.
 *
 * @stability unstable
 * @category models
 * @since 4.1.5
 */
export interface ReceiveOptions {
  /** Updates that give no event, the excluded contexts among them. */
  readonly onUnhandled?: ((update: Schema.Json) => Effect.Effect<void>) | undefined
  /** How long `ChatHandler.handle` has before the update is `notAccepted`. Default 10 seconds. */
  readonly deadline?: Duration.Input | undefined
  /**
   * How long a click handler has before the click is answered. Default 2.5
   * seconds. The handler then keeps running, detached, and the update is
   * `accepted`: Telegram does not send it again.
   */
  readonly clickDeadline?: Duration.Input | undefined
  /**
   * How long a command handler has. Default 10 seconds. The handler is then
   * interrupted, and the update is `accepted`: Telegram does not send it
   * again.
   */
  readonly commandDeadline?: Duration.Input | undefined
}

/**
 * The Telegram adapter's own service.
 *
 * **Details**
 *
 * - `botId` is the numeric id in front of the token's colon.
 * - `receive` runs one update, already authenticated and parsed, as both
 *   transports do, for a consumer's own transport. It needs a
 *   `ChatHandler`. Clicks and commands go to `ChatInteraction.Handler`
 *   when there is one in context: without it a click is answered and
 *   dropped, and a command is an ordinary message.
 *
 * @stability unstable
 * @category services
 * @since 4.1.5
 */
export class TelegramChat extends Context.Service<TelegramChat, {
  readonly botId: string
  readonly environment: TelegramBotApi.Environment
  readonly receive: (
    update: unknown,
    options?: ReceiveOptions | undefined
  ) => Effect.Effect<Outcome, never, ChatHandler>
}>()("@effect/chat-telegram/TelegramChat") {}

/**
 * Registers the Telegram adapter in the `Registry` and provides the
 * `TelegramChat` and `TelegramBotApi` services.
 *
 * **Details**
 *
 * - The descriptor has `edit`, `delete`, `replyTo`, `download`,
 *   `getThread` and `getUser`, beside `post`, and whatever `unverified`
 *   turns on.
 * - `environment: "test"` uses Telegram's test environment.
 * - `apiUrl` is for a local Bot API server and is privileged configuration.
 * - Fails `Unauthenticated` when the token has no bot id. The token is not
 *   checked against Telegram here; the first call does that.
 * - The bot's username, which commands and `@` mentions need, is read with
 *   `getMe` on the first message and kept. While it can't be read, a
 *   message update is `invalid`, and Telegram sends it again.
 *
 * @stability unstable
 * @category layers
 * @since 4.1.5
 */
export const layer = (options: {
  readonly token: Redacted.Redacted<string>
  readonly environment?: TelegramBotApi.Environment | undefined
  readonly apiUrl?: string | undefined
  readonly unverified?: Unverified | undefined
}): Layer.Layer<TelegramChat | TelegramBotApi.TelegramBotApi, ChatError, HttpClient.HttpClient | Registry> =>
  Layer.effect(
    TelegramChat,
    Effect.gen(function*() {
      const api = yield* TelegramBotApi.TelegramBotApi
      const registry = yield* Registry
      const capabilities = Adapter.capabilitiesOf(options.unverified ?? {})
      const { adapter, answer } = Adapter.make({ api, capabilities })
      yield* registry.register(adapter)
      let username: string | undefined
      const env: Receive.Environment = {
        api,
        capabilities,
        answer,
        username: Effect.suspend(() =>
          username !== undefined ? Effect.succeed(username) : api.call("getMe").pipe(
            Effect.flatMap((me) => {
              const name = Normalize.string(me, "username")
              if (name === undefined) return Errors.fail("getMe", Errors.invalidResponse(false, "missing_username"))
              username = name
              return Effect.succeed(name)
            })
          )
        )
      }
      return TelegramChat.of({
        botId: api.botId,
        environment: api.environment,
        receive: Effect.fnUntraced(function*(update, receiveOptions) {
          const handler = yield* ChatHandler
          return yield* Receive.receive(update, env, receiveOptions ?? {}, handler.handle)
        })
      })
    })
  ).pipe(Layer.provideMerge(TelegramBotApi.layer(options)))

/** `TelegramChat.receive` with the layer's `ChatHandler`, as a transport runs it. */
const transportReceive = Effect.fnUntraced(function*(options: ReceiveOptions) {
  const telegram = yield* TelegramChat
  const context = yield* Effect.context<ChatHandler>()
  return (update: unknown) => Effect.provideContext(telegram.receive(update, options), context)
})

/**
 * The header Telegram sends the webhook secret in. An app that records
 * server request headers must add it to `Headers.CurrentRedactedNames`,
 * keeping the names already there, in the layer it serves:
 * `Layer.provideMerge` reaches the server span, `Layer.provide` on the
 * webhook alone does not. The README has the setup.
 *
 * @stability unstable
 * @category constants
 * @since 4.1.5
 */
export const secretHeader: string = Webhook.secretHeader

/**
 * `POST {path}`: the bot's webhook.
 *
 * **Details**
 *
 * - The `X-Telegram-Bot-Api-Secret-Token` header must equal
 *   `secretToken`, compared in constant time. Otherwise the answer is 401
 *   and the body is not read. The layer fails unless `secretToken` is 32 to
 *   256 characters of `A-Za-z0-9_-`.
 * - 413 past `maxBodyBytes` (1 MiB by default), 400 for a body that can't
 *   be read or is not an update. `maxBodyBytes` must be a non-negative safe
 *   integer; another value is a defect when the layer is built.
 * - The update goes through `receive`: 200 for `accepted` and
 *   `unhandled`, 503 for `notAccepted` and `invalid`, which Telegram
 *   sends again. A click or command is answered 200 after its reply
 *   attempt.
 *
 * @stability unstable
 * @category layers
 * @since 4.1.5
 */
export const layerWebhook = (
  options: ReceiveOptions & {
    readonly path: `/${string}`
    readonly secretToken: Redacted.Redacted<string>
    readonly maxBodyBytes?: number | undefined
  }
): Layer.Layer<never, ChatError, HttpRouter.HttpRouter | TelegramChat | ChatHandler> =>
  HttpRouter.use(Effect.fnUntraced(function*(router) {
    const secret = new TextEncoder().encode(yield* Webhook.secretToken("layerWebhook", options.secretToken))
    const maxBodySize = ByteSize.bytes(options.maxBodyBytes ?? 1024 * 1024)
    const receive = yield* transportReceive(options)
    yield* router.add(
      "POST",
      options.path,
      (request) => Webhook.handleRequest(request, { secret, maxBodySize, receive })
    )
  }))

/**
 * Long polling with `getUpdates`, for a long-running process.
 *
 * **Details**
 *
 * - Updates run one at a time, in order, through `receive`. An update is
 *   confirmed only after it ran, so a process that dies part way sees it
 *   again.
 * - `notAccepted` and `invalid` are retried up to `maxAttempts` times (3
 *   by default) with a backoff, then logged as an error and skipped:
 *   `getUpdates` is one queue, and retrying forever would stall the bot.
 * - The layer fails with `InvalidRequest` and detail `conflict` when
 *   Telegram answers 409 at start: a webhook is set, or another process
 *   polls. It never deletes a webhook itself. A later 409 stops polling
 *   with an error log.
 *
 * @stability unstable
 * @category layers
 * @since 4.1.5
 */
export const layerPolling = (options: ReceiveOptions & {
  /** The long-poll timeout. Default 30 seconds. */
  readonly timeout?: Duration.Input | undefined
  readonly maxAttempts?: number | undefined
} = {}): Layer.Layer<never, ChatError, TelegramChat | TelegramBotApi.TelegramBotApi | ChatHandler> =>
  Layer.effectDiscard(Effect.gen(function*() {
    const api = yield* TelegramBotApi.TelegramBotApi
    const pollingOptions: Polling.Options = {
      api,
      timeout: options.timeout === undefined ? Duration.seconds(30) : Duration.fromInputUnsafe(options.timeout),
      maxAttempts: Math.max(1, options.maxAttempts ?? 3),
      receive: yield* transportReceive(options)
    }
    const first = yield* Polling.getUpdates(api, undefined, Duration.zero).pipe(Effect.mapError(Polling.conflict))
    yield* Effect.forkScoped(Polling.loop(first, pollingOptions))
  }))

/**
 * Registers the webhook with exactly the `allowed_updates` the adapter
 * reads. It is never called by the adapter itself.
 *
 * @stability unstable
 * @category webhooks
 * @since 4.1.5
 */
export const setWebhook = (options: {
  readonly url: string
  readonly secretToken: Redacted.Redacted<string>
  readonly maxConnections?: number | undefined
  readonly dropPendingUpdates?: boolean | undefined
}): Effect.Effect<void, ChatError, TelegramBotApi.TelegramBotApi> =>
  Effect.gen(function*() {
    const secret = yield* Webhook.secretToken("setWebhook", options.secretToken)
    const api = yield* TelegramBotApi.TelegramBotApi
    yield* api.call("setWebhook", {
      url: options.url,
      secret_token: secret,
      allowed_updates: Receive.allowedUpdates,
      ...(options.maxConnections === undefined ? {} : { max_connections: options.maxConnections }),
      ...(options.dropPendingUpdates === undefined ? {} : { drop_pending_updates: options.dropPendingUpdates })
    }, { write: true })
  })

/**
 * The `setMyCommands` payload for a group's commands.
 *
 * **Details**
 *
 * - Fails `InvalidRequest` with detail `invalid_command_names` when a
 *   command id is not `[a-z0-9_]{1,32}`. The portable rule allows `-`;
 *   Telegram does not.
 * - An `argument` has no Telegram counterpart and is appended to the
 *   description.
 * - Commands are registered as ordinary, not ephemeral: this version has
 *   no `ephemeral`.
 *
 * @stability unstable
 * @category commands
 * @since 4.1.5
 */
export const commandRequests = (
  group: ChatInteraction.Group<any>
): Effect.Effect<
  { readonly commands: ReadonlyArray<{ readonly command: string; readonly description: string }> },
  ChatError
> => {
  const result = Commands.botCommands(group)
  return "invalid" in result
    ? Errors.fail("commandRequests", Errors.invalidRequest("invalid_command_names"))
    : Effect.succeed(result)
}

/**
 * Sends a group's commands with `setMyCommands`.
 *
 * @stability unstable
 * @category commands
 * @since 4.1.5
 */
export const setCommands = (
  group: ChatInteraction.Group<any>,
  options?: { readonly scope?: Schema.Json | undefined; readonly languageCode?: string | undefined }
): Effect.Effect<void, ChatError, TelegramBotApi.TelegramBotApi> =>
  Effect.gen(function*() {
    const payload = yield* commandRequests(group)
    const api = yield* TelegramBotApi.TelegramBotApi
    yield* api.call("setMyCommands", {
      commands: payload.commands,
      ...(options?.scope === undefined ? {} : { scope: options.scope }),
      ...(options?.languageCode === undefined ? {} : { language_code: options.languageCode })
    }, { write: true })
  })

/**
 * The address of a chat, or of a forum topic in it.
 *
 * @stability unstable
 * @category constructors
 * @since 4.1.5
 */
export const thread: (chatId: string | number, messageThreadId?: string | number | undefined) => ChatThread =
  Address.thread

/**
 * The parts of a Telegram address, or `None` for another platform's or a
 * malformed one.
 *
 * @stability unstable
 * @category destructors
 * @since 4.1.5
 */
export const parts: (thread: ChatThread) => Option.Option<{
  readonly chatId: string
  readonly messageThreadId?: string | undefined
}> = Address.parts

/**
 * What the normalisers need to know about the bot.
 *
 * @stability unstable
 * @category models
 * @since 4.1.5
 */
export interface NormalizeContext {
  readonly botId: string
  /** The bot's username without `@`, from `getMe`. */
  readonly botUsername: string
  readonly environment?: TelegramBotApi.Environment | undefined
}

/**
 * The normaliser, for a consumer's own transport. It checks no secret:
 * that is the transport's job.
 *
 * **Details**
 *
 * - A `message` or `channel_post` with text, a caption, a file or rich
 *   content gives a `MessageCreated`. `text` is verbatim, and empty for
 *   an inbound rich message, whose content is only in `raw`.
 * - `text_mention` entities are mentions by id. An `@username` is a
 *   mention only when it names the bot.
 * - The author is `sender_chat` when there is one, else `from`.
 * - A private (ephemeral) message, a service message, and anything from a
 *   business connection, a channel's direct messages or guest mode give
 *   none, as does every other update. Commands are messages here too:
 *   `receive` is what routes them.
 * - `raw` is the update.
 *
 * @stability unstable
 * @category normalization
 * @since 4.1.5
 */
export const normalize: (update: unknown, context: NormalizeContext) => ReadonlyArray<ChatEvent> = Normalize.normalize

/**
 * The click or command of an update, as `receive` would dispatch it.
 *
 * **Details**
 *
 * A click is given only when its `data` is the `callback_data` of a button
 * in Telegram's own copy of the message. That proves the bot put the button
 * there, not that it is still current or that this user may press it.
 *
 * @stability unstable
 * @category normalization
 * @since 4.1.5
 */
export const normalizeInteraction = (
  update: unknown,
  context: NormalizeContext
): Option.Option<ChatInteraction.ButtonClicked | ChatInteraction.CommandInvoked> => {
  if (!Normalize.isObject(update)) return Option.none()
  return Option.fromUndefinedOr(Receive.clickEvent(update) ?? Receive.commandEvent(update, context))
}

/**
 * The delivery key of an update, or of an event or interaction whose `raw`
 * is one: `{botId}.{update_id}.{date}`, with `test.` in front in the test
 * environment. Telegram sends an update again until it gets a 200 (or an
 * offset moves past it), clicks and commands included, so a handler whose
 * work must not be lost or run twice commits this key and a recoverable
 * work item in one transaction before it returns. A click or command
 * past its deadline counts as answered and is not sent again, so that
 * holds only for a commit within the deadline. The README has the recipe.
 *
 * @stability unstable
 * @category normalization
 * @since 4.1.5
 */
export const deliveryKey = (
  raw: unknown,
  context: { readonly botId: string; readonly environment?: TelegramBotApi.Environment | undefined }
): Option.Option<string> => Option.fromUndefinedOr(Normalize.deliveryId(raw, context))

/**
 * Reads a mention for `ChatTest`. A mention's text is a display name or an
 * `@username`, neither of which holds the id, so this is always `None`;
 * a message's `mentions` come from its entities.
 *
 * @stability unstable
 * @category testing
 * @since 4.1.5
 */
export const parseMention: ParseMention = () => Option.none()

/**
 * Telegram options for every write inside an effect.
 *
 * @stability unstable
 * @category models
 * @since 4.1.5
 */
export interface TelegramPostOptions {
  /**
   * Users whose `[name](tg://user?id=…)` links in the Markdown stay links.
   * Any other `tg://` link becomes text. Default: none.
   */
  readonly notify?: { readonly users?: ReadonlyArray<string> | undefined } | undefined
  /** Sends posts with `disable_notification`. */
  readonly silent?: boolean | undefined
}

/**
 * Scoped Telegram options for every write inside `effect`. Nested calls
 * merge, the inner one winning field by field. Answers to commands and
 * follow-ups ignore them.
 *
 * @stability unstable
 * @category combinators
 * @since 4.1.5
 */
export const withPostOptions: {
  (options: TelegramPostOptions): <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>
  <A, E, R>(effect: Effect.Effect<A, E, R>, options: TelegramPostOptions): Effect.Effect<A, E, R>
} = dual(
  2,
  <A, E, R>(effect: Effect.Effect<A, E, R>, options: TelegramPostOptions): Effect.Effect<A, E, R> =>
    Effect.updateService(effect, CurrentPostOptions, (current) => ({ ...current, ...options }))
)
