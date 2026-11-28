/**
 * The Discord adapter for `effect/chat`: the `Registry` layer, the
 * structural dispatch and interaction entries, the pure normalisers, the
 * gateway layers, address helpers and the scoped post options. It runs on
 * dfx: every REST call goes through the `DiscordREST` in context.
 *
 * **Details**
 *
 * - Gateway intents: `GUILDS`, `GUILD_MESSAGES`, `GUILD_MESSAGE_REACTIONS`,
 *   `DIRECT_MESSAGES`, `DIRECT_MESSAGE_REACTIONS` and `MESSAGE_CONTENT`.
 *   They are set in the consumer's dfx config.
 * - `MESSAGE_CONTENT` is a privileged intent: switch it on for the
 *   application in Discord's developer portal. Without it, `text` is empty
 *   on every message that doesn't mention the bot, and attachments are
 *   missing.
 * - Bot permissions: View Channel, Send Messages, Send Messages in Threads,
 *   Create Public Threads, Read Message History and Attach Files.
 * - Slash commands need the `applications.commands` scope, and are
 *   registered by the consumer with the payloads `commandRequests` gives.
 *
 * @stability unstable
 * @since 4.1.5
 */
import { DiscordConfig } from "dfx/DiscordConfig"
import { DiscordGateway } from "dfx/DiscordGateway"
import { DispatchHook } from "dfx/DiscordGateway/Shard/DispatchHook"
import { DiscordREST } from "dfx/DiscordREST"
import * as Cause from "effect/Cause"
import { Registry } from "effect/chat/ChatAdapter"
import type { ChatError } from "effect/chat/ChatError"
import type { ChatEvent, MessageCreated, ReactionAdded } from "effect/chat/ChatEvent"
import { ChatHandler, NotAccepted } from "effect/chat/ChatHandler"
import * as ChatInteraction from "effect/chat/ChatInteraction"
import type { ParseMention } from "effect/chat/ChatTest"
import type { ChatThread } from "effect/chat/ChatThread"
import * as Context from "effect/Context"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import { dual } from "effect/Function"
import * as HttpClient from "effect/http/HttpClient"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import * as Adapter from "./internal/adapter.ts"
import * as Errors from "./internal/errors.ts"
import * as Interactions from "./internal/interactions.ts"
import * as Mentions from "./internal/mentions.ts"
import * as Normalize from "./internal/normalize.ts"
import { CurrentPostOptions } from "./internal/options.ts"

/**
 * The Discord side of the adapter, for what the core has no op for.
 *
 * **Details**
 *
 * - `botUserId` comes from `GET /users/@me`, read once. A failed read is
 *   tried again next time.
 * - `dispatch` takes one gateway dispatch, `{ t, d }`, and hands its
 *   events to the `ChatHandler` one at a time. It reads `d` with a Schema
 *   and ignores what it doesn't know, so it takes no dfx type.
 * - When a `MESSAGE_CREATE` carries no `channel_type`, `dispatch` looks
 *   the channel up, cached and with a five second timeout. A failed lookup
 *   is logged and fails with `NotAccepted`. A lookup that would fail the same
 *   way again, such as a deleted channel, is logged and the event dropped.
 * - `interaction` takes one `INTERACTION_CREATE` payload, from the gateway
 *   or from an HTTP interactions endpoint. It reads it with a Schema, so it
 *   takes no dfx type, and ignores an interaction it can't express: a
 *   message or user command, an autocomplete request, a slash command with
 *   anything but at most one string option. It calls the handler through
 *   `ChatInteraction.handle` and answers through the interaction callback
 *   endpoint, which has to land inside Discord's 3 seconds: `deadline` is
 *   the handler's share, 2 seconds by default.
 * - A click is answered with callback type 6, or type 9 for `OpenModal`.
 *   A submit's `close` is type 6. An `errors` reply is type 4 with the
 *   ephemeral flag, listing each message as plain text, and the modal closes: Discord
 *   can't show an error inside a modal, so the descriptor has no
 *   `modalErrors`.
 * - A slash command goes to `Handler.command`. `respond` is callback type
 *   4 with the message a `post` sends, `defer` type 5 and `OpenModal` type
 *   9, each with the ephemeral flag when private. An `Ack`, which is what a
 *   command nobody handles gets, sends nothing, so a command another library
 *   owns is left to it. `withPostOptions` does not reach a command's
 *   answer, `respond` or `followUp`: a mention in it renders and notifies
 *   nobody.
 * - Commands were recorded in a guild channel over the gateway. A command
 *   in a direct is from Discord's docs and was not run.
 * - A click on a private answer carries the message, with the ephemeral flag
 *   (64). Its `messageId` tells which answer was clicked. Discord's docs
 *   reach an interaction's messages only through its token, under
 *   `/webhooks`, and say nothing of the channel routes `Chat.edit`,
 *   `delete` and `fetchMessage` use on an ephemeral message. Treat the id
 *   as one no message op works with. This is from the docs: no op on it was
 *   run.
 * - `followUp` edits the deferred command's original response, with the
 *   application id and token from its `raw`, so a second call replaces the
 *   first answer. It fails `NotFound` with detail `interaction_expired`
 *   from 15 minutes after the command, read from the interaction's id,
 *   without calling Discord. Otherwise it makes one HTTP request, through
 *   the layer's `HttpClient` and not dfx's client, and never sends it
 *   again, unless that `HttpClient` retries by itself: a 429 fails
 *   `RateLimited`, for the caller to retry or not.
 *   Discord answers 401 with code 50027 past 15 minutes, which is
 *   `interaction_expired` too. Code 10015 is mapped from the docs and was
 *   not seen.
 * - A modal that can't be built, a reply to a command that fails the checks
 *   of a `post`, or a callback that fails, goes to `Handler.refused`. A
 *   callback that comes back 404 `Unknown interaction` was late: that is
 *   `NotFound` with detail `interaction_expired`. A failed ack is logged.
 * - `guild` reads the channel, cached. `None` for a direct.
 *
 * @stability unstable
 * @category services
 * @since 4.1.5
 */
export class DiscordChat extends Context.Service<DiscordChat, {
  readonly botUserId: Effect.Effect<string, ChatError>
  readonly dispatch: (dispatch: {
    readonly t: string
    readonly d: unknown
  }) => Effect.Effect<void, NotAccepted, ChatHandler>
  readonly interaction: (interaction: unknown, options?: {
    /** The handler's share of Discord's 3 seconds. Default 2 seconds. */
    readonly deadline?: Duration.Duration | undefined
  }) => Effect.Effect<void, never, ChatInteraction.Handler>
  readonly guild: (thread: ChatThread) => Effect.Effect<Option.Option<string>, ChatError>
}>()("@effect/chat-discord/DiscordChat") {}

/** The dispatches `normalize` reads. */
const handled = new Set(["MESSAGE_CREATE", "MESSAGE_REACTION_ADD", "MESSAGE_REACTION_REMOVE"])

const lookupTimeout = Duration.seconds(5)

/**
 * Registers the Discord adapter in the `Registry`.
 *
 * **Details**
 *
 * - Every REST call but `followUp` goes through the `DiscordREST` in
 *   context. dfx waits on its rate-limit buckets and sends again after a
 *   429, so a rate limit shows up as a slower call.
 * - `HttpClient` downloads attachments from Discord's CDN, with no token,
 *   and sends `followUp`'s edit, which needs no bot token either. That edit
 *   skips dfx's client so a 429 is not sent again past the 15 minutes. It
 *   goes to the `rest.baseUrl` of the `DiscordConfig` in context, or
 *   Discord's own API when there is none.
 * - Content goes out as written: Discord reads Markdown itself. Every write
 *   sends `allowed_mentions: { parse: [] }` and the `SUPPRESS_EMBEDS`
 *   flag, on the post and on every edit, unless `withPostOptions` says
 *   otherwise. A reply does not ping its author.
 * - `post` and `edit` fail with `TooLarge` before calling Discord past
 *   2,000 code points.
 * - A refused file fails `denied` with detail `file_refused` and leaves
 *   nothing posted: more than 10 files or 10 MiB, by the adapter's own
 *   check, or any `denied` answer to a post with files. The reason Discord
 *   gave is the `cause`.
 * - A message's elements go out as classic components beside `content`,
 *   in action rows: five buttons to a row and a select alone in its row, in
 *   the order given, up to five rows. More fail `TooLarge` before the call.
 *   An `edit` without `actions` removes the ones there were.
 * - A button's id and encoded value share one `custom_id`, joined by one
 *   character, and so do a modal's id and its metadata. An id may not
 *   contain U+241F, the join. `limits.actionDataLength` and
 *   `limits.modalMetadataLength` are 99 code points, the 100 of
 *   `custom_id` less the join.
 * - Button styles: `default` is secondary, `primary` primary and
 *   `danger` danger.
 * - A modal's inputs are Label components around a text input or a string
 *   select, and a `text` is a text display. Inputs and texts together are
 *   5 at most. A modal over that, or with a title or label over 45
 *   characters, reaches `Handler.refused` as `TooLarge`. Discord has no
 *   submit label, so `submitLabel` is not shown.
 * - `replyTo` sends a message reference. Discord refuses a reply to a
 *   message that is gone, unless `withPostOptions({ failIfNotExists: false })`
 *   lets it through as a plain message.
 * - Only `DEFAULT`, `REPLY`, `CHAT_INPUT_COMMAND` and
 *   `CONTEXT_MENU_COMMAND` messages are messages. A forward, a poll, a
 *   sticker or a components-only message is `DEFAULT` and comes through,
 *   often with `text: ""`. Its content stays on `raw`.
 * - A deferred command reply arrives empty. Its text comes in a later edit,
 *   which is not delivered, so only `history` and `fetchMessage` have it.
 * - A webhook message has the webhook id as its author id and `isBot`.
 *   `getUser` on that id fails `NotFound`.
 * - A mention is reported when its token is in `content` outside code and
 *   Discord says it resolved. A reply that pings its author is not a
 *   mention. Only the bot's user mention is `isSelf`: a mention of its
 *   managed role is the consumer's to recognise.
 * - The address of a thread is its channel id. `startThread` names the
 *   thread after the message's text, cut to 100 characters, and gives the
 *   existing thread when the message already has one.
 * - `history` of a thread started from a message puts the opener, from the
 *   parent channel, in place of Discord's placeholder. When the opener is
 *   deleted it starts at the first reply. A forum post's starter is in the
 *   thread itself.
 * - `getUser` with `in` gives the guild nick, and its `raw` is Discord's
 *   guild member, whose `roles` are the member's role ids. Without `in`, in
 *   a direct, or for someone who left the guild, `raw` is the user.
 * - The layer provides the `DiscordChat` service as well as registering the
 *   adapter, and makes every call through the `DiscordREST` it is given. A
 *   consumer that needs more of Discord than `Chat` has reads either from
 *   context beside `Chat`. dfx keeps one rate-limit state for both.
 * - There is no native streaming: streamed replies post, then edit, at
 *   least 1.5 seconds apart.
 *
 * @stability unstable
 * @category layers
 * @since 4.1.5
 */
export const layer: Layer.Layer<DiscordChat, never, DiscordREST | HttpClient.HttpClient | Registry> = Layer.effect(
  DiscordChat,
  Effect.gen(function*() {
    const rest = yield* DiscordREST
    const http = yield* HttpClient.HttpClient
    const registry = yield* Registry
    let cached: string | undefined
    const botUserId: Effect.Effect<string, ChatError> = Effect.suspend(() => {
      if (cached !== undefined) return Effect.succeed(cached)
      return rest.getMyUser().pipe(
        Effect.mapError((error) => Errors.chatError("botUserId", Errors.reasonForRestError(error, { write: false }))),
        Effect.flatMap((user) => {
          if (typeof user.id !== "string" || user.id === "") {
            return Effect.fail(Errors.chatError("botUserId", Errors.invalidResponse(false, "missing_user_id")))
          }
          cached = user.id
          return Effect.succeed(user.id)
        })
      )
    })
    const config = yield* Effect.serviceOption(DiscordConfig)
    const baseUrl = Option.match(config, { onNone: () => Adapter.defaultBaseUrl, onSome: (_) => _.rest.baseUrl })
    const { adapter, channelType, guild, interaction } = yield* Adapter.make({ rest, http, baseUrl, botUserId })
    yield* registry.register(adapter)

    const refuse = (message: string, error: ChatError) =>
      Effect.andThen(Effect.logWarning(message, error), Effect.fail(new NotAccepted()))

    const dispatch = Effect.fnUntraced(function*(payload: { readonly t: string; readonly d: unknown }) {
      if (!handled.has(payload.t)) return
      const handler = yield* ChatHandler
      const self = yield* Effect.catch(botUserId, (error) => refuse("discord dispatch: bot user lookup failed", error))
      let result = Normalize.normalize(payload, { botUserId: self })
      if (result._tag === "MissingChannelType") {
        const lookup = yield* channelType(result.channelId).pipe(
          Effect.timeoutOrElse({
            duration: lookupTimeout,
            orElse: () => Effect.fail(Errors.chatError("dispatch", Errors.transport(false, "lookup_timeout")))
          }),
          Effect.map(Option.some),
          Effect.catch((error) =>
            error.retry === "denied"
              ? Effect.as(
                Effect.logWarning("discord dispatch: channel lookup denied, event dropped", error),
                Option.none()
              )
              : refuse("discord dispatch: channel lookup failed", error)
          )
        )
        if (Option.isNone(lookup)) return
        result = Normalize.normalize(payload, { botUserId: self, channelType: lookup.value })
        if (result._tag === "MissingChannelType") return
      }
      for (const event of result.events) yield* handler.handle(event)
    })

    return DiscordChat.of({ botUserId, dispatch, interaction, guild })
  })
)

/**
 * The address of a Discord channel, thread or direct: its channel id.
 *
 * @stability unstable
 * @category constructors
 * @since 4.1.5
 */
export const thread: (channelId: string) => ChatThread = Normalize.thread

/**
 * Error for a message whose channel type is in neither the payload nor the
 * context, from `normalize`.
 *
 * @stability unstable
 * @category errors
 * @since 4.1.5
 */
export class MissingChannelType extends Schema.TaggedError<MissingChannelType>(
  "@effect/chat-discord/DiscordChat/MissingChannelType"
)("MissingChannelType", { channelId: Schema.String }) {}

/**
 * The normaliser behind `dispatch`, without delivering.
 *
 * **Details**
 *
 * - Pure: it never looks a channel up. It reads the channel type from the
 *   payload's `channel_type`, then from `context.channelType`, Discord's
 *   numeric type, and fails with `MissingChannelType` when neither has one.
 * - Types 10, 11 and 12 are a `thread`, 1 and 3 a `direct`, and every
 *   other type a `channel`.
 * - `MESSAGE_CREATE`, `MESSAGE_REACTION_ADD` and
 *   `MESSAGE_REACTION_REMOVE` give an event. Every other dispatch, and a
 *   message type that is not a message, gives none.
 * - A custom emoji is `custom:{name}`, its id left on `raw.emoji.id`.
 * - `raw` is `d`, undecoded.
 *
 * @stability unstable
 * @category normalization
 * @since 4.1.5
 */
export const normalize = (
  dispatch: { readonly t: string; readonly d: unknown },
  context: { readonly botUserId: string; readonly channelType?: number | undefined }
): Result.Result<ReadonlyArray<ChatEvent>, MissingChannelType> => {
  const result = Normalize.normalize(dispatch, context)
  return result._tag === "Events"
    ? Result.succeed(result.events)
    : Result.fail(new MissingChannelType({ channelId: result.channelId }))
}

/**
 * The member on a message's or added reaction's `raw`: the guild, the
 * roles and the nick.
 *
 * **Details**
 *
 * Pure, with no REST call. `None` for a direct, a webhook message, or a
 * payload with no member. Discord sends no member on a removed reaction, so
 * it takes none.
 *
 * @stability unstable
 * @category accessors
 * @since 4.1.5
 */
export const member = (event: MessageCreated | ReactionAdded): Option.Option<{
  readonly guildId: string
  readonly roles: ReadonlyArray<string>
  readonly nick?: string | undefined
}> => Normalize.memberOf(event.raw)

/**
 * The guild on an event's `raw`.
 *
 * **Details**
 *
 * Pure, with no REST call. It works for every event, webhook messages and
 * removed reactions included. `None` for a direct.
 *
 * @stability unstable
 * @category accessors
 * @since 4.1.5
 */
export const guildId = (event: ChatEvent): Option.Option<string> => Normalize.guildIdOf(event.raw)

/**
 * For a long-running process: subscribes to dfx's gateway and feeds every
 * dispatch to `DiscordChat.dispatch`, one at a time.
 *
 * **Details**
 *
 * - Intents and sharding stay in the consumer's dfx config. So does the
 *   gateway session: dfx keeps the session id, the resume URL and the
 *   sequence in the `ShardStateStore` given to `DiscordGatewayLive`.
 * - It reads dfx's stream of dispatches, which a dispatch reaches after its
 *   sequence is stored. An event that fails with `NotAccepted` is logged
 *   and dropped, and so is one the process stops in the middle of: Discord
 *   does not send it again.
 *
 * @see {@link layerDispatchHook} for a host that is stopped and started again
 *
 * @stability unstable
 * @category layers
 * @since 4.1.5
 */
export const layerGateway: Layer.Layer<never, never, DiscordGateway | DiscordChat | ChatHandler> = Layer.effectDiscard(
  Effect.gen(function*() {
    const gateway = yield* DiscordGateway
    const discord = yield* DiscordChat
    const handler = yield* ChatHandler
    yield* gateway.dispatch.pipe(
      Stream.runForEach((payload) => {
        const t: unknown = payload.t
        if (typeof t !== "string") return Effect.void
        return discord.dispatch({ t, d: payload.d }).pipe(
          Effect.provideService(ChatHandler, handler),
          Effect.catchCause((cause) => Effect.logWarning("discord gateway: event dropped", cause))
        )
      }),
      Effect.forkScoped
    )
  })
)

/**
 * For a host that is stopped and started again, a Durable Object for one:
 * feeds every dispatch to `DiscordChat.dispatch` from dfx's `DispatchHook`,
 * before the shard stores the dispatch's sequence.
 *
 * **When to use**
 *
 * Use when an event must not be lost to a restart, in place of
 * `layerGateway`. Never provide both: every event would be delivered twice.
 *
 * **Details**
 *
 * - Provide it to the dfx layer that builds the shards, `DiscordGatewayLive`
 *   or `ShardLive`, beside a `ShardStateStore` over storage that outlives
 *   the host. dfx keeps the session id, the resume URL and the sequence
 *   there, so a host built again sends RESUME, not IDENTIFY, and Discord
 *   sends what it missed.
 * - The handler runs before the sequence is stored. A host stopped in the
 *   middle of an event never stored that event's sequence, so the RESUME
 *   brings the event back.
 * - An event that fails with `NotAccepted` fails the hook. dfx drops the
 *   connection, resumes from the last stored sequence and gets the event
 *   again, after 1 second, doubling with every failure in a row up to 2
 *   minutes. An event that is refused every time holds back every event
 *   after it.
 * - A defect in the handler is logged and the event dropped, as a replay
 *   would only fail the same way.
 * - Delivery is at least once. A host stopped after the handler returned and
 *   before the sequence was stored gets that event a second time, so a
 *   handler that can't take an event twice remembers the ids it took.
 * - The hook runs on the shard's read loop, one dispatch at a time. A
 *   handler slower than Discord's heartbeat interval, about 41 seconds,
 *   makes the shard reconnect.
 * - Interactions stay with `layerGatewayInteractions`: each has 3 seconds,
 *   so there is nothing to resume.
 *
 * **Gotchas**
 *
 * - Discord replays only while it keeps the session. When it refuses the
 *   RESUME, dfx identifies again and the events in between are gone.
 * - Waking the host, restarting a shard that went quiet and backing off
 *   after a close Discord won't change its mind on, an invalid token (4004)
 *   or a disallowed intent (4014), stay with the host: dfx reconnects
 *   whatever the close code.
 *
 * **Example** (Resuming from the host's own storage)
 *
 * ```ts
 * import { DiscordChat } from "@effect/chat-discord"
 * import { ShardLive } from "dfx/DiscordGateway/Shard"
 * import { type ShardState, ShardStateStore } from "dfx/DiscordGateway/Shard/StateStore"
 * import { Effect, Layer, Option } from "effect"
 *
 * // Stands in for storage that outlives the host.
 * const storage = new Map<string, ShardState>()
 *
 * const SessionStore = Layer.succeed(
 *   ShardStateStore,
 *   ShardStateStore.of({
 *     forShard: ([id, count]) => {
 *       const key = `${id}/${count}`
 *       return {
 *         get: Effect.sync(() => Option.fromUndefinedOr(storage.get(key))),
 *         set: (state) => Effect.sync(() => void storage.set(key, state)),
 *         clear: Effect.sync(() => void storage.delete(key))
 *       }
 *     }
 *   })
 * )
 *
 * // Still needs `DiscordChat`, a `ChatHandler` and the rest of dfx's gateway.
 * export const ShardResuming = ShardLive.pipe(
 *   Layer.provide([DiscordChat.layerDispatchHook, SessionStore])
 * )
 * ```
 *
 * @see {@link layerGateway} for a process that runs until it is told to stop
 *
 * @stability unstable
 * @category layers
 * @since 4.1.5
 */
export const layerDispatchHook: Layer.Layer<never, never, DiscordChat | ChatHandler> = Layer.effect(
  DispatchHook,
  Effect.gen(function*() {
    const discord = yield* DiscordChat
    const handler = yield* ChatHandler
    return (payload) => {
      const t: unknown = payload.t
      if (typeof t !== "string" || !handled.has(t)) return Effect.void
      return discord.dispatch({ t, d: payload.d }).pipe(
        Effect.provideService(ChatHandler, handler),
        // Refused or interrupted: the sequence stays unstored and a RESUME replays the event.
        Effect.catchCause((cause): Effect.Effect<void, NotAccepted> =>
          Cause.hasFails(cause) || Cause.hasInterrupts(cause)
            ? Effect.failCause(cause)
            : Effect.logError("discord gateway: handler defect, event dropped", cause)
        ),
        Effect.orDie
      )
    }
  })
)

/**
 * For a long-running process: subscribes to dfx's gateway and feeds every
 * `INTERACTION_CREATE` to `DiscordChat.interaction`.
 *
 * **Details**
 *
 * Interactions run concurrently, since each has its own 3 seconds. It is
 * separate from `layerGateway`, so a consumer with no buttons needs no
 * `ChatInteraction.Handler`.
 *
 * @stability unstable
 * @category layers
 * @since 4.1.5
 */
export const layerGatewayInteractions: Layer.Layer<
  never,
  never,
  DiscordGateway | DiscordChat | ChatInteraction.Handler
> = Layer.effectDiscard(
  Effect.gen(function*() {
    const gateway = yield* DiscordGateway
    const discord = yield* DiscordChat
    const handler = yield* ChatInteraction.Handler
    yield* gateway.fromDispatch("INTERACTION_CREATE").pipe(
      Stream.mapEffect(
        (payload) =>
          discord.interaction(payload).pipe(
            Effect.provideService(ChatInteraction.Handler, handler),
            Effect.catchCause((cause) => Effect.logWarning("discord gateway: interaction dropped", cause))
          ),
        { concurrency: "unbounded" }
      ),
      Stream.runDrain,
      Effect.forkScoped
    )
  })
)

/**
 * The normaliser behind `DiscordChat.interaction`.
 *
 * **Details**
 *
 * - Pure. A click on a button gives `ButtonClicked`, with the id and value
 *   split from the `custom_id`. A string select gives `SelectChanged`, and
 *   a modal's submit `ModalSubmitted`, its metadata split from the modal's
 *   `custom_id`.
 * - The thread and message come from the `message` Discord sends with the
 *   interaction, so a modal's submit carries the message whose element
 *   opened it. A modal a command opened has no message, so its submit has
 *   no `messageId`, and its thread is the channel.
 * - A submit's `values` hold each answered input by id. An input left
 *   empty is absent.
 * - A slash command with no options, or one string option, gives
 *   `CommandInvoked`: `id` is its name and `text` the option's value or
 *   the empty string.
 * - Anything else, a message or user command, a slash command with other
 *   options, or a click with no message, is `None`.
 * - `raw` is the payload, undecoded. For a command it holds the token that
 *   answers it, so it is a credential for 15 minutes.
 *
 * @stability unstable
 * @category normalization
 * @since 4.1.5
 */
export const normalizeInteraction: (interaction: unknown) => Option.Option<ChatInteraction.Interaction> =
  Interactions.normalize

/**
 * The create payload of each command in `group`, in the group's order, for
 * Discord's application commands endpoint.
 *
 * **Details**
 *
 * - Each is a `CHAT_INPUT` command with the definition's name and
 *   description, and one `STRING` option when it has an `argument`. Each
 *   fits dfx's `ApplicationCommandCreateRequest`.
 * - The definitions in `group` that are not commands are skipped.
 *
 * **Gotchas**
 *
 * - The adapter registers nothing. Discord's bulk overwrite replaces the
 *   application's whole list, so the consumer sends these beside its other
 *   commands, in one call.
 * - dfx's gateway runner syncs its own commands the same way when it
 *   starts, which would delete these. A consumer running both adds these to
 *   that list, or switches the sync off with `setInteractionsSync(false)`.
 * - A field the definition lacks, such as `default_member_permissions`, is
 *   spread onto the payload by the consumer.
 *
 * **Example** (Registering the commands beside dfx's own)
 *
 * ```ts import.meta.vitest
 * import { DiscordChat } from "@effect/chat-discord"
 * import { DiscordREST } from "dfx/DiscordREST"
 * import { Effect } from "effect"
 * import { ChatInteraction } from "effect/chat"
 *
 * const Commands = ChatInteraction.group(
 *   ChatInteraction.command("summarize", { description: "Summarize this thread" })
 * )
 *
 * export const register = Effect.gen(function*() {
 *   const rest = yield* DiscordREST
 *   const app = yield* rest.getMyApplication()
 *   yield* rest.bulkSetApplicationCommands(app.id, [...DiscordChat.commandRequests(Commands)])
 * })
 * ```
 *
 * @stability unstable
 * @category commands
 * @since 4.1.5
 */
export const commandRequests: (group: ChatInteraction.Group<any>) => ReadonlyArray<{
  /** `CHAT_INPUT`. */
  readonly type: 1
  readonly name: string
  readonly description: string
  /** One `STRING` option when the command has an `argument`, absent otherwise. */
  readonly options?:
    | ReadonlyArray<{
      readonly type: 3
      readonly name: string
      readonly description: string
      readonly required: boolean
    }>
    | undefined
}> = Interactions.commandRequests

/**
 * Discord options for every write inside an effect.
 *
 * @stability unstable
 * @category models
 * @since 4.1.5
 */
export interface DiscordPostOptions {
  /**
   * Who a write may notify. Default: nobody, and a reply does not ping its
   * author. `everyone` allows `@everyone` and `@here`.
   */
  readonly notify?: {
    readonly users?: ReadonlyArray<string> | undefined
    readonly roles?: ReadonlyArray<string> | undefined
    readonly everyone?: boolean | undefined
    readonly repliedUser?: boolean | undefined
  } | undefined
  /**
   * Link embeds. Default true, which sends the `SUPPRESS_EMBEDS` flag on
   * the post and on every edit, so a link a later edit adds gets no embed
   * either. False sends no flag on a post and clears it on an edit.
   */
  readonly suppressEmbeds?: boolean | undefined
  /**
   * What a post with `replyTo` does when that message is gone. Default
   * true: Discord refuses the post. False sends `fail_if_not_exists: false`,
   * and Discord posts the message without the reference.
   */
  readonly failIfNotExists?: boolean | undefined
  /** For `startThread`, in minutes. Default: the channel's. */
  readonly autoArchiveDuration?: 60 | 1440 | 4320 | 10080 | undefined
}

/**
 * Scoped Discord options for every write inside `effect`. Nested calls
 * merge, the inner one winning field by field.
 *
 * @stability unstable
 * @category combinators
 * @since 4.1.5
 */
export const withPostOptions: {
  (options: DiscordPostOptions): <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>
  <A, E, R>(effect: Effect.Effect<A, E, R>, options: DiscordPostOptions): Effect.Effect<A, E, R>
} = dual(
  2,
  <A, E, R>(effect: Effect.Effect<A, E, R>, options: DiscordPostOptions): Effect.Effect<A, E, R> =>
    Effect.updateService(effect, CurrentPostOptions, (current) => ({ ...current, ...options }))
)

/**
 * Reads one Discord mention token, `<@id>`, `<@!id>`, `<@&id>`,
 * `<#id>`, `@everyone` or `@here`, for `ChatTest.checkMessage`,
 * `ChatTest.checkEvent` and `ChatTest.conformance`.
 *
 * @stability unstable
 * @category testing
 * @since 4.1.5
 */
export const parseMention: ParseMention = (slice) => Option.fromUndefinedOr(Mentions.parseToken(slice))
