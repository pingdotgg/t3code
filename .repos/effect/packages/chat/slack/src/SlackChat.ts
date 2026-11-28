/**
 * The Slack adapter for `effect/chat`: the `Registry` layer, the Events API
 * webhook, the Interactivity route for buttons and modals, the pure
 * normalisers, address helpers and the scoped post options.
 *
 * **Details**
 *
 * - Bot token scopes: `chat:write`, `channels:history`, `groups:history`,
 *   `im:history`, `mpim:history`, `channels:read`, `groups:read`,
 *   `im:read`, `mpim:read`, `users:read`, `reactions:read`, `files:read`
 *   and `files:write`.
 * - Event subscriptions, sent to `layerWebhook`'s path: `message.channels`,
 *   `message.groups`, `message.im`, `message.mpim`, `app_mention`,
 *   `reaction_added`, `reaction_removed` and `agent_session_stopped`.
 * - Buttons, selects and modals need Interactivity, which is its own
 *   switch in the app settings, off by default, with its own Request URL,
 *   separate from Event Subscriptions. Point it at `layerInteractivity`'s
 *   path. With Socket Mode on, Slack sends interactions over the socket and
 *   never to the URL: pass each payload to `SlackChat.interaction` and send
 *   its result as the envelope ack's `payload`.
 * - Slash commands need the `commands` scope. Declare each in the app
 *   manifest under `features.slash_commands`, or in the app settings under
 *   Slash Commands, with its Request URL set to `layerInteractivity`'s path.
 *   The name, less its slash, is the id of the `ChatInteraction.command`,
 *   and the manifest's description and usage hint are what Slack shows.
 *   With Socket Mode on, commands come as `slash_commands` envelopes: pass
 *   the envelope's `payload` to `SlackChat.interaction` in the same way.
 *   That path is from Slack's docs and was not run, nor were commands in
 *   Slack Connect channels or directs.
 * - A command can't be run inside a thread: Slack doesn't offer it there.
 *   A command that acts on a thread has to be told which one. Command names are shared by every app
 *   in a workspace. "Escape channels, users, and links" is off by default;
 *   with it on, `text` carries `<@U…|name>` and `<#C…|name>` tokens.
 * - Slack's stop button also needs the app declared as an agent with
 *   `features.agent_view` in the manifest. Slack documents that declaration
 *   as irreversible. Without it the adapter's session status calls answer
 *   `not_authorized`; it then stops making them, and replies still work.
 * - A click on the stop button stops nothing by itself: the consumer gets a
 *   `StopRequested` and ends the reply. Until it does, the user sees a
 *   disabled button. Every click is a separate `StopRequested`, and only
 *   the first in a thread lists the open stream in `messageIds`.
 *
 * @stability unstable
 * @since 4.1.5
 */
import * as ByteSize from "effect/ByteSize"
import { Registry } from "effect/chat/ChatAdapter"
import { type ChatError, ChatErrorReason } from "effect/chat/ChatError"
import type { ChatEvent } from "effect/chat/ChatEvent"
import { ChatHandler } from "effect/chat/ChatHandler"
import * as ChatInteraction from "effect/chat/ChatInteraction"
import type { ParseMention } from "effect/chat/ChatTest"
import { ChatThread } from "effect/chat/ChatThread"
import * as Context from "effect/Context"
import type * as Mac from "effect/crypto/Mac"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import { dual } from "effect/Function"
import * as HttpClient from "effect/http/HttpClient"
import * as HttpRouter from "effect/http/HttpRouter"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import type * as Redacted from "effect/Redacted"
import * as Schema from "effect/Schema"
import * as Adapter from "./internal/adapter.ts"
import * as Address from "./internal/address.ts"
import * as Emoji from "./internal/emoji.ts"
import * as Errors from "./internal/errors.ts"
import * as Interactions from "./internal/interactions.ts"
import * as Json from "./internal/json.ts"
import * as Mentions from "./internal/mentions.ts"
import * as Normalize from "./internal/normalize.ts"
import { CurrentPostOptions } from "./internal/options.ts"
import * as Webhook from "./internal/webhook.ts"
import { SlackWebApi } from "./SlackWebApi.ts"
import * as WebApi from "./SlackWebApi.ts"

/**
 * A Slack user from `users.info`, with guest and Slack Connect status.
 *
 * @stability unstable
 * @category models
 * @since 4.1.5
 */
export interface SlackUser {
  readonly id: string
  readonly teamId: string
  readonly name: string
  readonly isBot: boolean
  readonly isRestricted: boolean
  readonly isUltraRestricted: boolean
  /** A Slack Connect user from another organisation. */
  readonly isStranger: boolean
  readonly deleted: boolean
  readonly raw: Schema.Json
}

/**
 * The Slack side of the adapter, for what the core has no op for.
 *
 * **Details**
 *
 * - `botUserId` comes from `auth.test`, read once. A failed read is tried
 *   again next time.
 * - `user` calls `users.info` each time. Nothing is cached.
 * - `interaction` is the entry for a decoded Interactivity `payload`
 *   (`block_actions` or `view_submission`), as `DiscordChat.interaction`
 *   is for Discord, and for a slash command: the form fields of its
 *   request, or the `payload` of a `slash_commands` envelope, as one
 *   object. It normalises with `normalizeInteraction`, calls the
 *   handler through `ChatInteraction.handle` inside `deadline` (2.5
 *   seconds by default, the handler's share of Slack's 3), opens a modal
 *   with `views.open` and calls `Handler.refused` when it can't.
 * - A modal's title is held to 24 code points, each input label to 2,000 and
 *   the modal's id to 255. These are not on the descriptor. A modal past one
 *   of them is not opened: `Handler.refused` gets `TooLarge`, and the click
 *   is still acked. A portable modal keeps its title to 24.
 * - Slack needs a submit button on a modal with inputs, so a modal with no
 *   `submitLabel` gets the English "Submit". Pass `submitLabel` to localise
 *   it.
 * - It succeeds with the body to answer Slack with: the JSON of the 200 on
 *   the Request URL, or the `payload` of the envelope ack on Socket Mode.
 *   For a command answered with `respond` that body is the message, with
 *   `response_type` `ephemeral` or `in_channel`, after the checks of a
 *   `post`; one that fails them goes to `Handler.refused`. A command's
 *   answer, `respond` or `followUp`, mentions nobody: `withPostOptions`
 *   does not reach it, so `<@U…>` goes out escaped and shows as text, as a
 *   `post` without `withPostOptions` does. There is no way to allow a
 *   mention in it.
 *   `undefined` is an empty answer: an ack, a close, a late click, a
 *   deferred command, a command that opened a modal, a command nobody
 *   handles, or a payload that is not from an element this adapter built.
 * - `Late` is a submit or a command whose handler ran past the deadline
 *   and was interrupted. It is not an answer, since an empty one would close
 *   the modal, or tell the user the command worked: `layerInteractivity`
 *   answers 503 for it, and a caller on Socket Mode sends no ack. For a
 *   command, Slack's desktop client then shows its own private failure
 *   notice and keeps the text; its iOS client shows nothing. `Late` is
 *   itself a JSON value, so test for it with `Schema.is(ChatInteraction.Late)`
 *   before treating the result as a body.
 * - `Chat.followUp` on a deferred command posts once to the command's
 *   `response_url`, which must be on a Slack host, through the layer's
 *   `HttpClient`. It is a write and is not retried. Slack takes five posts
 *   to one `response_url` within 30 minutes, each a new message. A spent
 *   or expired one answers 404 `used_url` or `expired_url`, which is
 *   `NotFound` with detail `interaction_expired`. A 410 or a JSON `error`
 *   with either string is mapped the same, from the docs: neither was seen.
 * - A click on a private answer has no `message`. Its `messageId` is the
 *   answer's `container.message_ts`, which tells which answer was clicked
 *   and which no Web API method reaches: `chat.update` on it answers
 *   `message_not_found`, so `edit` fails `NotFound`. `raw` has
 *   `container.is_ephemeral`. A public answer reads back as a
 *   `bot_message` whose `bot_id` is not the app's own, so it is not
 *   `isSelf`.
 * - `interaction` checks no signature and no app id: that is the
 *   transport's job. It needs `ChatInteraction.Handler` where it is
 *   called, so the layer does not need it.
 *
 * @stability unstable
 * @category services
 * @since 4.1.5
 */
export class SlackChat extends Context.Service<SlackChat, {
  readonly teamId: string
  readonly botUserId: Effect.Effect<string, ChatError>
  readonly user: (id: string) => Effect.Effect<SlackUser, ChatError>
  readonly interaction: (payload: unknown, options?: {
    /** The handler's share of Slack's 3 seconds. Default 2.5 seconds. */
    readonly deadline?: Duration.Duration | undefined
  }) => Effect.Effect<Schema.Json | undefined | ChatInteraction.Late, never, ChatInteraction.Handler>
}>()("@effect/chat-slack/SlackChat") {}

/**
 * Registers the Slack adapter in the `Registry`, for one workspace.
 *
 * **Details**
 *
 * - `post` and `edit` send the Markdown as one `markdown` block, in which
 *   a `<` outside inline and fenced code goes as `&lt;`, plus a `text` the
 *   adapter builds, in which every `<`, `>` and `&` goes as an entity.
 *   Slack decides who a message mentions from `text`, so no token notifies
 *   unless `withPostOptions({ notify })` allows it. Allowed tokens stay
 *   intact in both.
 * - That `text` is cut to 16,000 code points on a post and 3,800 UTF-8
 *   bytes on an edit, on a grapheme cluster boundary, ending in `…` with
 *   the allowed tokens the cut left out appended. The cut never fails.
 * - Stream appends go as `markdown_text`, which has no `text` beside it.
 *   A stream decodes the character references for `<`, `@` and `!`, so
 *   the adapter finds token shapes (`<@`, and `<!` followed by a letter)
 *   with those references decoded, in prose and in code alike, and puts a
 *   zero-width space (U+200B) straight after whatever spells the `<`.
 *   Allowed tokens are sent as they are. An append holds back an unclosed
 *   `<`, a trailing character reference that is not finished and a
 *   trailing high surrogate, and reports them as `held`. The start and a
 *   `flush` hold nothing, so a shape that the next write completes gets
 *   its zero-width space at the start of that write.
 * - Once a stream is stopped, by `stop` or by a user, a message whose appends differ from what
 *   `post` would send gets one `chat.update` as blocks plus `text`,
 *   which takes the zero-width spaces out. It is skipped, leaving them, when
 *   the block would pass 12,000 code points, when the edit fails, and when
 *   an append to the message was left unconfirmed, since `ChatMarkdown`
 *   then rewrites the message itself. A skip fails nothing and sets the
 *   span attribute `slack.stream.cleanup`. A cleanup that is interrupted
 *   runs again on the next `stop` for that message.
 * - `post`, `edit` and stream writes fail with `TooLarge` before calling
 *   Slack when the text as sent passes 12,000 code points. Slack's second
 *   limit, 13,200 with every emoji counted as its shortcode, is left to
 *   Slack, whose refusal is also `TooLarge` and posts nothing.
 *   `descriptor.measure` keeps a part under both.
 * - A post with files uploads them with no channel, posts the message, then
 *   attaches them with `chat.update` and `file_ids`. Both calls send the
 *   same blocks and `text`, so the `text` of a post with files is cut to the
 *   update budget of 3,800 bytes. A post with files and no Markdown carries
 *   the file names, joined by ", ", as its text, and keeps them.
 * - A post with files is all-or-nothing. A file Slack refuses at upload,
 *   one past `limits`, or an attach Slack refuses fails the post `denied`
 *   with detail `file_refused`: a refused attach first deletes the message
 *   and then the files, best effort. A timed out attach is retried, for up
 *   to a minute in all, waits after a 429 included; past that it is rolled
 *   back the same way. When the message can't be deleted, the post fails
 *   `Unknown` with detail `attach_failed_message_left` and a
 *   `SlackAttachFailed` as its cause. From the post on, the route can't be
 *   interrupted, and each call has a timeout.
 * - `edit` keeps a message's files, and `delete` removes the message and
 *   not its files: a user may have shared them on. Read the file ids with
 *   `fetchMessage` before deleting to remove them too.
 * - A mention in a post with files can notify for a message that a refused
 *   attach then deletes.
 * - A post with files in a Slack Connect channel is untested.
 * - `replyTo` is not supported.
 * - A message from another app or an incoming webhook (`bot_message`) has
 *   the `bot_id` as its author id. `getUser` on that id fails `NotFound`.
 * - `getUser`'s `raw` is the user from `users.info`, with its `team_id`.
 *   `SlackChat.user` is the same call with the team, guest and Slack
 *   Connect status as typed fields.
 * - The layer provides the `SlackChat` and `SlackWebApi` services as well
 *   as registering the adapter. A consumer that needs more of Slack than
 *   `Chat` has reads either from context beside `Chat`.
 * - A thread root whose subtype is not a message, such as an agent-view
 *   chat's `assistant_app_thread` root, is treated as deleted: `opener`
 *   gives `None` and history starts at the first reply.
 * - Edits to one message are at least 3 seconds apart.
 * - After a 429 on a stream append or an edit, the next write to that
 *   message waits for the retry-after, and later writes to it wait twice
 *   the interval, for the rest of the reply. A stream started with
 *   `continues` keeps the pace of the part it continues.
 * - The native stream needs a thread and a recipient, and rotates before
 *   Slack's ten minute cap. A reply that ends after a click on the stop
 *   button moves the agent session off `processing`.
 * - A message's buttons, link buttons and selects go in one `actions` block
 *   after the `markdown` block, on `post` and on `edit`. A button's id is
 *   its `action_id` and its value its `value`. A message with elements and
 *   no Markdown has no `markdown` block, and its `text` is the button
 *   labels joined by a space. A streamed reply gets its buttons by `edit`
 *   after the stream stops.
 * - Elements are refused before the call past 25 in a message, for an id
 *   longer than 255 or holding U+241F, and for an id plus a value longer
 *   than 2,000, all in code points.
 * - Text and elements share Slack's 13,200 budget, so
 *   `descriptor.measure(markdown, actions)` counts the `actions` block as
 *   Slack stores it, with every non-ASCII unit at 6. A `value` near 2,000
 *   uses up the budget by itself. A `post` whose elements push it past the
 *   cap fails `TooLarge` with `msg_blocks_too_long`, and nothing is posted.
 *   The adapter never falls back to posting the text and adding the elements
 *   by `edit`. A caller can: `chat.update` had no 13,200 cap when tested,
 *   which Slack does not document.
 *
 * @stability unstable
 * @category layers
 * @since 4.1.5
 */
export const layer = (options: {
  readonly botToken: Redacted.Redacted
  readonly teamId: string
}): Layer.Layer<SlackChat | SlackWebApi, never, HttpClient.HttpClient | Registry> =>
  Layer.effect(
    SlackChat,
    Effect.gen(function*() {
      const api = yield* SlackWebApi
      const http = yield* HttpClient.HttpClient
      const registry = yield* Registry
      let cached: string | undefined
      const botUserId: Effect.Effect<string, ChatError> = Effect.suspend(() => {
        if (cached !== undefined) return Effect.succeed(cached)
        return api.call("auth.test", {}).pipe(
          Effect.mapError(Errors.withOp("botUserId")),
          Effect.flatMap((answer) => {
            const id = Json.string(answer, "user_id")
            if (id === undefined) {
              return Effect.fail(Errors.chatError("botUserId", Errors.invalidResponse(false, "missing_user_id")))
            }
            cached = id
            return Effect.succeed(id)
          })
        )
      })
      const { adapter, answer, user } = Adapter.make({
        api,
        http,
        botToken: options.botToken,
        teamId: options.teamId,
        botUserId,
        attachFailed: (fields) => new SlackAttachFailed(fields)
      })
      yield* registry.register(adapter)
      const interaction = Interactions.make({ api, teamId: options.teamId, answer })
      return SlackChat.of({ teamId: options.teamId, botUserId, user, interaction })
    })
  ).pipe(Layer.provideMerge(WebApi.layer({ botToken: options.botToken })))

/**
 * The `cause` of a `post` with files that failed `uncertain` with detail
 * `attach_failed_message_left`.
 *
 * **Details**
 *
 * - The attach failed and the message could not be deleted. The message may
 *   still exist, with or without its files: an attach that timed out may
 *   have landed, and a delete that timed out may have too. `messageId` is
 *   that message and `fileIds` are its files, which are kept. `reason` is
 *   the attach's own.
 * - Its `message` leaves the ids out.
 *
 * @stability unstable
 * @category errors
 * @since 4.1.5
 */
export class SlackAttachFailed
  extends Schema.TaggedError<SlackAttachFailed>("@effect/chat-slack/SlackChat/SlackAttachFailed")(
    "SlackAttachFailed",
    {
      thread: ChatThread,
      messageId: Schema.String,
      fileIds: Schema.Array(Schema.String),
      reason: ChatErrorReason
    }
  )
{
  override get message(): string {
    return `Slack did not attach the files and the message may be left: ${this.reason.message}`
  }
}

/**
 * The address of a Slack channel, direct conversation or thread:
 * `{team}/{channel}`, or `{team}/{channel}/{threadTs}` for a thread.
 *
 * @stability unstable
 * @category constructors
 * @since 4.1.5
 */
export const thread: (parts: {
  readonly team: string
  readonly channel: string
  readonly threadTs?: string | undefined
}) => ChatThread = Address.thread

/**
 * The parts of a Slack address, or `None` for another platform's or a
 * malformed one.
 *
 * @stability unstable
 * @category destructors
 * @since 4.1.5
 */
export const parts: (thread: ChatThread) => Option.Option<{
  readonly team: string
  readonly channel: string
  readonly threadTs?: string | undefined
}> = Address.parts

/**
 * `POST {path}`: the Events API webhook.
 *
 * **Details**
 *
 * - Checks the `v0` signature with the signing secret and a five minute
 *   window, then answers `url_verification`.
 * - An envelope for another app, another workspace or of another type is
 *   answered 200 and dropped.
 * - The events go through `normalize` to the `ChatHandler`, one at a time.
 * - Answers 503, so Slack retries, when the handler fails `NotAccepted`,
 *   when the bot user can't be read, or when the request, from reading its
 *   body to the handler's return, takes longer than `deadline` (2.5 seconds
 *   by default). Each of the three is logged with its own message, the
 *   unreadable bot user as an error with its `ChatError` and the other two
 *   as warnings.
 * - Answers 413 past `maxBodyBytes` (1 MiB by default), and for a body that
 *   can't be read, before the signature is checked. `maxBodyBytes` must be
 *   a non-negative safe integer; another value is a defect when the layer is
 *   built.
 * - Slack redelivers on a timeout or an error, so an event can arrive twice.
 *   `ChatEvent.dedupeKey` gives the two deliveries equal keys.
 *
 * Signature checks use the required `Mac` service. Provide
 * `NodeCrypto.layerMac`, `BunCrypto.layerMac`, `DenoCrypto.layerMac`,
 * `BrowserCrypto.layerMac`, or `Mac.layerWebCrypto` with
 * `SecureRandom.layerWebCrypto` for other runtimes such as Workers.
 * Key construction failures are configuration defects; verification errors
 * fail the signature check (401).
 *
 * @stability unstable
 * @category layers
 * @since 4.1.5
 */
export const layerWebhook = (options: {
  readonly path: `/${string}`
  readonly signingSecret: Redacted.Redacted
  readonly appId: string
  readonly deadline?: Duration.Duration | undefined
  readonly maxBodyBytes?: number | undefined
}): Layer.Layer<never, never, HttpRouter.HttpRouter | SlackChat | ChatHandler | Mac.Mac> =>
  HttpRouter.use(Effect.fnUntraced(function*(router) {
    const slack = yield* SlackChat
    const handler = yield* ChatHandler
    const verify = yield* Webhook.makeVerifier(options.signingSecret)
    const webhookOptions: Webhook.Options = {
      verify,
      appId: options.appId,
      teamId: slack.teamId,
      botUserId: slack.botUserId,
      handle: handler.handle,
      deadline: options.deadline ?? Duration.millis(2500),
      maxBodySize: ByteSize.bytes(options.maxBodyBytes ?? Webhook.defaultMaxBodyBytes)
    }
    yield* router.add("POST", options.path, (request) => Webhook.handleRequest(request, webhookOptions))
  }))

/**
 * `POST {path}`: the Interactivity Request URL, which Slack posts
 * form-encoded and separately from the Events API.
 *
 * **Details**
 *
 * - Checks the `v0` signature as `layerWebhook` does, decodes the form's
 *   `payload` and drops one for another app with a 200.
 * - It is also the Request URL of a slash command. A command's form has no
 *   `payload` field and has a `command` field, which is how the route tells
 *   the two apart. Its fields go to `SlackChat.interaction` as one object,
 *   after the same signature and app checks.
 * - Hands the payload to `SlackChat.interaction` with `deadline` (2.5
 *   seconds by default). Its body is the response, and `Late` is answered
 *   with a 503, so the modal stays open with Slack's own error.
 * - Answers 413 past `maxBodyBytes`, as `layerWebhook` does.
 * - Slack never redelivers an interaction, so a click or submit that is not
 *   answered in time is lost. A user can submit again, as a new request.
 *
 * Signature checks use the required `Mac` service. Provide
 * `NodeCrypto.layerMac`, `BunCrypto.layerMac`, `DenoCrypto.layerMac`,
 * `BrowserCrypto.layerMac`, or `Mac.layerWebCrypto` with
 * `SecureRandom.layerWebCrypto` for other runtimes such as Workers.
 * Key construction failures are configuration defects; verification errors
 * fail the signature check (401).
 *
 * @stability unstable
 * @category layers
 * @since 4.1.5
 */
export const layerInteractivity = (options: {
  readonly path: `/${string}`
  readonly signingSecret: Redacted.Redacted
  readonly appId: string
  readonly deadline?: Duration.Duration | undefined
  readonly maxBodyBytes?: number | undefined
}): Layer.Layer<never, never, HttpRouter.HttpRouter | SlackChat | ChatInteraction.Handler | Mac.Mac> =>
  HttpRouter.use(Effect.fnUntraced(function*(router) {
    const slack = yield* SlackChat
    const handler = yield* ChatInteraction.Handler
    const verify = yield* Webhook.makeVerifier(options.signingSecret)
    const interactivityOptions: Webhook.InteractivityOptions = {
      verify,
      appId: options.appId,
      interaction: (payload, interactionOptions) =>
        Effect.provideService(slack.interaction(payload, interactionOptions), ChatInteraction.Handler, handler),
      deadline: options.deadline ?? Interactions.defaultDeadline,
      maxBodySize: ByteSize.bytes(options.maxBodyBytes ?? Webhook.defaultMaxBodyBytes)
    }
    yield* router.add("POST", options.path, (request) => Webhook.handleInteractivity(request, interactivityOptions))
  }))

/**
 * The normaliser behind `SlackChat.interaction`.
 *
 * **Details**
 *
 * - Pure: takes the decoded `payload` of a `block_actions` or
 *   `view_submission` request, or the fields of a slash command.
 * - None for any other payload, and for one that is not from an element
 *   this adapter built: a block of the consumer's own, a link button, or a
 *   view the adapter did not open.
 * - Every command gives a `CommandInvoked`, known or not: the registry
 *   decides that later. `id` is `command` less its slash, `text` is `text`
 *   or the empty string, and the thread is the channel's.
 * - A submit's thread and message are those of the click that opened the
 *   modal, which the adapter packed into `private_metadata` beside the
 *   consumer's metadata. A modal a command opened has no message, so its
 *   submit has no `messageId`.
 * - The team in an address is `context.teamId`. `raw` is the payload
 *   without its verification `token`. A command's holds its `response_url`,
 *   so it is a credential for 30 minutes.
 *
 * @stability unstable
 * @category normalization
 * @since 4.1.5
 */
export const normalizeInteraction: (
  payload: unknown,
  context: { readonly teamId: string }
) => Option.Option<ChatInteraction.Interaction> = Interactions.normalize

/**
 * The normaliser, for Socket Mode or a consumer's own transport.
 *
 * **Details**
 *
 * - Pure: takes an `event_callback` envelope, gives zero or more events.
 * - An envelope for another workspace gives none. The team in an address is
 *   the workspace, from the envelope's `team_id` or `authorizations`.
 * - `message` and `app_mention` for one message give equal events. An
 *   `app_mention` that carries `edited` gives none.
 * - A message subtype other than `file_share`, `thread_broadcast`,
 *   `bot_message` and `me_message` gives none.
 * - Mentions come from the message's `rich_text` block when it has one,
 *   and only for elements whose token is in `text`, since Slack decides a
 *   mention from `text`. Without a `rich_text` block they come from `text`
 *   outside code.
 * - The bot's own messages with a `rich_text` block read back with `text`
 *   rendered from the blocks as Markdown, whole and with its newlines, as
 *   the stored `text` the adapter sent may be cut. Everyone else's `text`
 *   is Slack's field as stored.
 * - `agent_session_stopped` gives a `StopRequested`.
 * - `raw` is the envelope without its verification `token`.
 *
 * @stability unstable
 * @category normalization
 * @since 4.1.5
 */
export const normalize: (
  envelope: unknown,
  context: { readonly teamId: string; readonly botUserId: string }
) => ReadonlyArray<ChatEvent> = Normalize.normalize

/**
 * Slack options for every write inside an effect.
 *
 * @stability unstable
 * @category models
 * @since 4.1.5
 */
export interface SlackPostOptions {
  /** Which mention tokens may notify. Default: none. */
  readonly notify?: {
    readonly users?: ReadonlyArray<string> | undefined
    readonly groups?: ReadonlyArray<string> | undefined
    readonly broadcast?: boolean | undefined
  } | undefined
  /**
   * Link and media previews. Default false, which sends `unfurl_links` and
   * `unfurl_media` both false; true sends both true.
   *
   * **Details**
   *
   * - It applies to `post` only: `chat.update` has no unfurl parameter.
   *   An edit that adds a link gets no preview either way, which a live
   *   check confirmed, so a post-then-edit stream never unfurls.
   * - Slack disables unfurling in streaming messages, so it does nothing on
   *   a native stream.
   */
  readonly unfurl?: boolean | undefined
  /** Default true where the workspace supports it. */
  readonly nativeStream?: boolean | undefined
  /** For a Connect channel, where the recipient is on another team. */
  readonly recipientTeamId?: string | undefined
  /** The agent session status at a normal end of a native stream. Default `active`. */
  readonly sessionStatusAtEnd?: "active" | "processing" | "suspended" | "closed" | undefined
}

/**
 * Scoped Slack options for every write inside `effect`. Nested calls merge,
 * the inner one winning field by field.
 *
 * @stability unstable
 * @category combinators
 * @since 4.1.5
 */
export const withPostOptions: {
  (options: SlackPostOptions): <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>
  <A, E, R>(effect: Effect.Effect<A, E, R>, options: SlackPostOptions): Effect.Effect<A, E, R>
} = dual(
  2,
  <A, E, R>(effect: Effect.Effect<A, E, R>, options: SlackPostOptions): Effect.Effect<A, E, R> =>
    Effect.updateService(effect, CurrentPostOptions, (current) => ({ ...current, ...options }))
)

/**
 * A Slack emoji name, with or without colons and with at most one skin tone
 * suffix (`+1::skin-tone-4`), as Unicode. `None` for a name the table
 * doesn't know, such as a custom emoji, and for a name with two tones.
 *
 * @stability unstable
 * @category emoji
 * @since 4.1.5
 */
export const emojiFromName = (name: string): Option.Option<string> => Option.fromUndefinedOr(Emoji.fromName(name))

/**
 * An emoji as its Slack name, without colons.
 *
 * @stability unstable
 * @category emoji
 * @since 4.1.5
 */
export const emojiToName = (emoji: string): Option.Option<string> => Option.fromUndefinedOr(Emoji.toName(emoji))

/**
 * Reads one Slack mention token, such as `<@U123>`, `<!subteam^S123|@team>`,
 * `<#C123|name>` or `<!here>`, for `ChatTest.checkMessage`,
 * `ChatTest.checkEvent` and `ChatTest.conformance`.
 *
 * @stability unstable
 * @category testing
 * @since 4.1.5
 */
export const parseMention: ParseMention = (slice) => Option.fromUndefinedOr(Mentions.parseToken(slice))
