/**
 * The WhatsApp Cloud API adapter for `effect/chat`: the `Registry` layer
 * for one business phone number, the webhook, the pure normaliser, delivery
 * keys, templates, read receipts and the scoped post options.
 *
 * **Details**
 *
 * - Cloud API only. One adapter is one business phone number, and a
 *   `Registry` holds one adapter per platform.
 * - An address is `{phoneNumberId}/u/{user}`, where `user` is a phone
 *   number in digits or a business-scoped user id (BSUID), such as
 *   `US.13491208655302741918`. `{phoneNumberId}/g/{groupId}` is
 *   reserved for groups, which are not supported yet: every op on it fails
 *   `InvalidRequest` with detail `group_unsupported`, and group webhooks
 *   are logged and dropped.
 * - Inbound messages carry the BSUID form when the webhook has a BSUID, and
 *   the phone number only when it has none. The adapter never rewrites an
 *   address: a reply goes where the thread says. `WhatsAppUpdate.Alias`
 *   reports a phone number and a BSUID that name one user.
 * - A business may only write freely within 24 hours of the user's last
 *   message. Outside it, a `post` fails `Forbidden` with detail
 *   `outsideWindow`, and `sendTemplate` is the way to write.
 * - The access token needs `whatsapp_business_messaging`. Subscribe the app
 *   to the WhatsApp Business Account's `messages` field.
 *
 * @stability unstable
 * @since 4.1.5
 */
import * as ByteSize from "effect/ByteSize"
import { type Posted, Registry } from "effect/chat/ChatAdapter"
import type { ChatError } from "effect/chat/ChatError"
import type * as ChatEvent from "effect/chat/ChatEvent"
import { ChatHandler, type NotAccepted } from "effect/chat/ChatHandler"
import * as ChatInteraction from "effect/chat/ChatInteraction"
import type { ParseMention } from "effect/chat/ChatTest"
import type { ChatThread } from "effect/chat/ChatThread"
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
import type * as Schema from "effect/Schema"
import * as Adapter from "./internal/adapter.ts"
import * as Address from "./internal/address.ts"
import * as Errors from "./internal/errors.ts"
import * as Normalize from "./internal/normalize.ts"
import { CurrentPostOptions } from "./internal/options.ts"
import * as Webhook from "./internal/webhook.ts"
import { WhatsAppGraphApi } from "./WhatsAppGraphApi.ts"
import * as GraphApi from "./WhatsAppGraphApi.ts"
import type { WhatsAppUpdate } from "./WhatsAppUpdate.ts"

/**
 * The detail of a `post` refused outside the 24 hour customer service
 * window, Graph error 131047. The reason is `Forbidden`. Write with
 * `sendTemplate` instead.
 *
 * @stability unstable
 * @category constants
 * @since 4.1.5
 */
export const outsideWindow: string = Errors.outsideWindow

/**
 * A template message: its approved name, its language code, such as
 * `en_US`, and Meta's `components` for its parameters, sent as they are.
 *
 * @stability unstable
 * @category models
 * @since 4.1.5
 */
export interface Template {
  readonly name: string
  readonly language: string
  readonly components?: ReadonlyArray<Schema.Json> | undefined
}

/**
 * What one webhook delivery holds, in order: messages and reactions, clicks,
 * and updates.
 *
 * @stability unstable
 * @category models
 * @since 4.1.5
 */
export type Inbound =
  | ChatEvent.MessageCreated
  | ChatEvent.ReactionAdded
  | ChatInteraction.ButtonClicked
  | ChatInteraction.SelectChanged
  | WhatsAppUpdate

/**
 * The WhatsApp side of the adapter, for what the core has no op for.
 *
 * **Details**
 *
 * - `sendTemplate` sends an approved template, which is how v1 writes
 *   outside the 24 hour window. A template needs Meta's approval first; a
 *   Direct Send template, where Meta offers it, does not need a separate
 *   review. An authentication template with one-tap, zero-tap or copy-code
 *   buttons can't be sent to a BSUID: Meta refuses it with error 131062,
 *   which is `InvalidRequest`. Send those to a phone number address.
 * - `markRead` marks a received message read, which shows blue ticks, and
 *   with `typing` shows the typing indicator until the next message or for
 *   up to 25 seconds.
 * - `receive` runs one webhook delivery, already verified and parsed, as
 *   `layerWebhook` does, for a consumer's own transport. It needs a
 *   `ChatHandler`, and a `ChatInteraction.Handler` when there are
 *   clicks: without one a click is logged and dropped. `deadline` is a
 *   click handler's share, 3 seconds by default.
 *
 * @stability unstable
 * @category services
 * @since 4.1.5
 */
export class WhatsAppChat extends Context.Service<WhatsAppChat, {
  readonly phoneNumberId: string
  readonly sendTemplate: (thread: ChatThread, template: Template) => Effect.Effect<Posted, ChatError>
  readonly markRead: (
    thread: ChatThread,
    messageId: string,
    options?: { readonly typing?: boolean | undefined }
  ) => Effect.Effect<void, ChatError>
  readonly receive: (envelope: unknown, options?: {
    readonly onUpdate?: ((update: WhatsAppUpdate) => Effect.Effect<void, NotAccepted>) | undefined
    readonly deadline?: Duration.Duration | undefined
  }) => Effect.Effect<void, NotAccepted, ChatHandler>
}>()("@effect/chat-whatsapp/WhatsAppChat") {}

/**
 * Registers the WhatsApp adapter in the `Registry`, for one business phone
 * number.
 *
 * **Details**
 *
 * - Capabilities: `replyTo`, `files`, `download`, `getThread`,
 *   `opener`, `buttons` and `selects`. Every other op fails
 *   `Unsupported`. WhatsApp has no edit, so `ChatMarkdown` posts each
 *   part of a streamed reply once.
 * - Every `post` is one send, and every check runs before any upload or
 *   send. `Posted` means Meta accepted the message, not that it was
 *   delivered: a later `failed` status goes to `onUpdate`. A send that
 *   failed after the request left is `uncertain`.
 * - Markdown is rendered to WhatsApp's formatting: bold as `*b*`, italics
 *   as `_i_`, strikethrough as `~s~`, a link as `label (url)`, a heading
 *   as bold, a table without its delimiter row and a fence without its info
 *   string. Each replacement is used only when it is no longer than the
 *   Markdown it replaces, so the text never grows; anything else is sent as
 *   typed, including reference links and their definitions, and code fenced
 *   inside a quote or a list item.
 * - `descriptor.measure` and the label limits count UTF-16 units. In live
 *   checks on Graph `v23.0`, Meta counted text bodies, interactive bodies,
 *   reply button titles, list row titles and row ids in code points, which a
 *   UTF-16 count never undercounts: it is stricter only for characters
 *   outside the Basic Multilingual Plane, such as emoji. Captions, the list
 *   button and section titles were not measured, and are counted the same
 *   way.
 * - Link previews are off unless `withPostOptions({ linkPreview: true })`.
 * - One file per post. It is uploaded, then sent as one media message with
 *   the text as its caption, or as the header of a message with reply
 *   buttons or a link button. Refused with `TooLarge`, subject `files` and
 *   detail `file_refused`, before anything is sent: more than one file, a
 *   MIME type outside Meta's table, `image/webp`, a file past its type's
 *   size limit, audio with text or actions, text over 1,024 beside a file,
 *   and a file beside a list. An upload Meta refuses as invalid or too large
 *   fails the same way, so `ChatMarkdown`'s `unattachedNote` applies. `text/markdown` is uploaded as
 *   `text/plain`, with its bytes and name unchanged.
 * - Actions: one to three buttons with labels up to 20 go as reply buttons;
 *   a lone link button with a label up to 20 as a link button; otherwise
 *   buttons and select options become the rows of one list, at most ten,
 *   with labels up to 24. Link buttons beside anything else, or with a
 *   longer label, are appended to the text as `Label: url` lines. A body
 *   beside reply buttons or a link button is held to 1,024, which
 *   `descriptor.measure` counts. A post with actions and no text gets the
 *   labels, joined by ", ", as its text.
 * - The list's button is the first select's placeholder, or
 *   `withPostOptions({ listButton })`, "Options" by default, up to 20.
 *   With buttons and a select, or two selects, each section has a title up
 *   to 24: the select's placeholder, or `buttonsSection`, "Actions" by
 *   default, for the buttons.
 * - Refused before the call: more than ten rows (`TooLarge`,
 *   `list_rows`), a label past its limit (`TooLarge`,
 *   `label_too_long`), an id holding U+241F, two reply buttons with one
 *   label, and two elements with one id and value (`InvalidRequest`). A
 *   select's `selected` and a button's `style` are ignored.
 * - A reply button's id on the wire is `b`, the id, U+241F and the value,
 *   and Meta counts it in UTF-8 bytes, up to 256. Over that, the post is
 *   refused before the call with `TooLarge`, `action_data_too_long`,
 *   even when the id and value are within `limits.actionDataLength`.
 * - `getThread` is built from the address alone, as `direct`. `opener`
 *   is always `None`.
 * - The pair rate limit is one message every 6 seconds to one user, which is
 *   `limits.minWriteInterval`. Meta accepts short bursts above that rate
 *   but refuses a sustained faster pace with error 131056, `RateLimited`.
 * - `messagingAccountId` is sent as `messaging_account_id` on every
 *   message. Include it to say which Messaging account sends when the
 *   access token can send from more than one on the phone number. Meta
 *   documents it as optional for now, required for such a token on the
 *   newest Graph version from H1 2027, and on every version from H1 2028.
 *   Without it, Meta picks the account from the token. Not yet checked
 *   against a production number.
 * - Built against Graph API `v24.0`, the default `baseUrl`. The
 *   adapter's live checks ran on `v23.0`.
 *
 * @stability unstable
 * @category layers
 * @since 4.1.5
 */
export const layer = (options: {
  readonly accessToken: Redacted.Redacted
  readonly phoneNumberId: string
  readonly messagingAccountId?: string | undefined
  readonly baseUrl?: string | undefined
}): Layer.Layer<WhatsAppChat | WhatsAppGraphApi, never, HttpClient.HttpClient | Registry> =>
  Layer.effect(
    WhatsAppChat,
    Effect.gen(function*() {
      const graph = yield* WhatsAppGraphApi
      const http = yield* HttpClient.HttpClient
      const registry = yield* Registry
      const { adapter, markRead, sendTemplate } = Adapter.make({
        graph,
        http,
        accessToken: options.accessToken,
        phoneNumberId: options.phoneNumberId,
        messagingAccountId: options.messagingAccountId
      })
      yield* registry.register(adapter)
      const context = { phoneNumberId: options.phoneNumberId }
      return WhatsAppChat.of({
        phoneNumberId: options.phoneNumberId,
        sendTemplate,
        markRead,
        receive: (envelope, receiveOptions) =>
          Effect.flatMap(ChatHandler, (handler) =>
            Webhook.receive(Normalize.normalize(envelope, context), {
              handle: handler.handle,
              onUpdate: receiveOptions?.onUpdate,
              clickDeadline: Effect.succeed(receiveOptions?.deadline ?? Duration.seconds(3))
            }))
      })
    })
  ).pipe(Layer.provideMerge(GraphApi.layer({ accessToken: options.accessToken, baseUrl: options.baseUrl })))

/**
 * The address of a WhatsApp user: `{phoneNumberId}/u/{user}`, where
 * `user` is a phone number in digits or a BSUID.
 *
 * @stability unstable
 * @category constructors
 * @since 4.1.5
 */
export const thread = (parts: { readonly phoneNumberId: string; readonly user: string }): ChatThread =>
  Address.thread({ phoneNumberId: parts.phoneNumberId, kind: "user", id: parts.user })

/**
 * The parts of a WhatsApp address, or `None` for another platform's or a
 * malformed one. A group address, which is reserved, has `kind` `group`.
 *
 * @stability unstable
 * @category destructors
 * @since 4.1.5
 */
export const parts: (thread: ChatThread) => Option.Option<{
  readonly phoneNumberId: string
  readonly kind: "user" | "group"
  readonly id: string
}> = Address.parts

/**
 * `GET {path}` and `POST {path}`: the webhook's subscription check and its
 * deliveries.
 *
 * **Details**
 *
 * - `GET` answers Meta's check with `hub.challenge` when `hub.verify_token`
 *   is `verifyToken`, and 403 otherwise.
 * - `POST` reads at most `maxBodyBytes` (3 MiB by default, 413; a body
 *   that can't be read is 400), checks `X-Hub-Signature-256` with the app
 *   secret (401), and drops a delivery for another object or another phone
 *   number with a 200. `maxBodyBytes` must be a non-negative safe integer;
 *   another value is a defect when the layer is built.
 * - The updates run in order. Messages and reactions go to the
 *   `ChatHandler`, clicks to `ChatInteraction.handle`, and statuses and
 *   changed ids to `onUpdate`. A removed reaction is dropped.
 * - A `NotAccepted` stops the delivery and answers 503, as does a request
 *   that takes longer than `deadline`, 10 seconds by default. Meta then
 *   delivers the whole batch again, for up to 7 days, so a batch that
 *   always runs past the deadline repeats until then. At the deadline the
 *   work is interrupted without waiting for its finalizers. In a live check
 *   Meta gave up on a response after about 22 seconds and redelivered.
 * - A click never causes a 503. It gets what is left of the deadline, less
 *   a margin. `Ack` and `Late` count as handled, and a late handler keeps
 *   running. `OpenModal` goes to `Handler.refused` as
 *   `Unsupported("modals")`, which is awaited only within the click's share. Without a `ChatInteraction.Handler` in the
 *   layer's context, a click is logged and dropped.
 * - Delivery is at least once. A message, a reaction or a click can arrive
 *   twice, a click even at the same time as its first delivery. Drop
 *   repeated events with `ChatEvent.dedupeKey`; a click handler for which
 *   a second run is unsafe must claim `deliveryKey` atomically, before any
 *   side effect. The adapter keeps no seen-store. Deliveries are not in
 *   order either: order by the updates' timestamps.
 * - A user can tap more than one reply button of a message, or pick one
 *   list row twice. Each tap is a click of its own, with its own
 *   `deliveryKey`, so a choice that must be made once needs its own
 *   claim.
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
  readonly appSecret: Redacted.Redacted
  readonly verifyToken: Redacted.Redacted
  readonly onUpdate?: ((update: WhatsAppUpdate) => Effect.Effect<void, NotAccepted>) | undefined
  readonly deadline?: Duration.Duration | undefined
  readonly maxBodyBytes?: number | undefined
}): Layer.Layer<never, never, HttpRouter.HttpRouter | WhatsAppChat | ChatHandler | Mac.Mac> =>
  HttpRouter.use(Effect.fnUntraced(function*(router) {
    const whatsapp = yield* WhatsAppChat
    const handler = yield* ChatHandler
    const interactions = yield* Effect.serviceOption(ChatInteraction.Handler)
    const verify = yield* Webhook.makeVerifier(options.appSecret)
    const context = { phoneNumberId: whatsapp.phoneNumberId }
    const webhookOptions: Webhook.Options = {
      verify,
      normalize: (envelope) => Normalize.normalize(envelope, context),
      handle: handler.handle,
      onUpdate: options.onUpdate,
      deadline: options.deadline ?? Duration.seconds(10),
      maxBodySize: ByteSize.bytes(options.maxBodyBytes ?? 3 * 1024 * 1024)
    }
    yield* router.add(
      "GET",
      options.path,
      (request) => Effect.succeed(Webhook.handleVerification(request, options.verifyToken))
    )
    yield* router.add("POST", options.path, (request) => {
      const response = Webhook.handleRequest(request, webhookOptions)
      return Option.isSome(interactions)
        ? Effect.provideService(response, ChatInteraction.Handler, interactions.value)
        : response
    })
  }))

/**
 * The normaliser, for a consumer's own transport.
 *
 * **Details**
 *
 * - Pure: takes a parsed webhook body, gives what it holds, in order. A
 *   change for another phone number, and a group message, give nothing.
 * - A message's `thread` is the sender's BSUID address when the webhook
 *   has one, and its phone number address otherwise. `kind` is
 *   `direct`. Text is as the user typed it, a caption for media, and empty
 *   for a message with neither, such as a location. Media are attachments,
 *   with the media id as their `id`.
 * - `raw` of an event or a click is the change's `metadata`, the
 *   sender's entry of `contacts`, with `wa_id` when Meta shares the
 *   number, and the one message. `message.raw` is the message.
 * - A reaction with an emoji is `ReactionAdded`; a removed reaction gives
 *   nothing.
 * - A reply button or a list row the adapter built is `ButtonClicked` or
 *   `SelectChanged`, whose `messageId` is the message that carried it.
 *   Any other interactive reply gives nothing.
 * - Statuses give `Status`, and `Alias` too when they carry both ids. A
 *   `system` message about a changed number or id gives `UserIdChanged`.
 *
 * @stability unstable
 * @category normalization
 * @since 4.1.5
 */
export const normalize: (
  envelope: unknown,
  context: { readonly phoneNumberId: string }
) => ReadonlyArray<Inbound> = Normalize.normalize

const encodeKey = (parts: ReadonlyArray<string>) => parts.map(encodeURIComponent).join("/")

const phoneNumberOf = (thread: ChatThread) => thread.id.split("/")[0]

/**
 * The key of one delivery of a click or a reaction:
 * `{phoneNumberId}/{messageId}`, the id of the webhook message that carried
 * it, each part percent-encoded.
 *
 * **When to use**
 *
 * Use to make a click handler safe to run twice. Meta redelivers a batch
 * that was not answered in time, so a click can run again, even at the same
 * time as the first run. Claim the key atomically, such as with an insert
 * that fails on a duplicate, before any side effect, and skip the click when
 * the claim fails.
 *
 * @stability unstable
 * @category getters
 * @since 4.1.5
 */
export const deliveryKey = (
  event: ChatInteraction.ButtonClicked | ChatInteraction.SelectChanged | ChatEvent.ReactionAdded
): string => {
  const raw = event.raw as { readonly messages?: ReadonlyArray<{ readonly id?: unknown }> }
  const id = Array.isArray(raw?.messages) && typeof raw.messages[0]?.id === "string" ? raw.messages[0].id : ""
  return encodeKey([phoneNumberOf(event.thread), id])
}

/**
 * The key of an update, for dropping a redelivered one, its parts
 * percent-encoded and joined by `/`.
 *
 * **Details**
 *
 * - `Status`: `{phoneNumberId}/status/{messageId}/{status}`.
 * - `UserIdChanged`: `{phoneNumberId}/user_changed/{id}`.
 * - `Alias`: `{phoneNumberId}/alias/{messageId}/{status}/{phone}/{userId}`.
 *
 * @stability unstable
 * @category getters
 * @since 4.1.5
 */
export const updateKey = (update: WhatsAppUpdate): string => {
  const phoneNumberId = phoneNumberOf(update.thread)
  switch (update._tag) {
    case "Status":
      return encodeKey([phoneNumberId, "status", update.messageId, update.status])
    case "UserIdChanged":
      return encodeKey([phoneNumberId, "user_changed", update.id])
    case "Alias":
      return encodeKey([phoneNumberId, "alias", update.messageId, update.status, update.phone, update.userId])
  }
}

/**
 * WhatsApp options for every write inside an effect.
 *
 * @stability unstable
 * @category models
 * @since 4.1.5
 */
export interface WhatsAppPostOptions {
  /** A preview of the first link in a text message. Default false. */
  readonly linkPreview?: boolean | undefined
  /** The button that opens a list, when no select has a placeholder. Default "Options", up to 20. */
  readonly listButton?: string | undefined
  /** The title of a list's buttons section beside a select. Default "Actions", up to 24. */
  readonly buttonsSection?: string | undefined
}

/**
 * Scoped WhatsApp options for every write inside `effect`. Nested calls
 * merge, the inner one winning field by field.
 *
 * @stability unstable
 * @category combinators
 * @since 4.1.5
 */
export const withPostOptions: {
  (options: WhatsAppPostOptions): <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>
  <A, E, R>(effect: Effect.Effect<A, E, R>, options: WhatsAppPostOptions): Effect.Effect<A, E, R>
} = dual(
  2,
  <A, E, R>(effect: Effect.Effect<A, E, R>, options: WhatsAppPostOptions): Effect.Effect<A, E, R> =>
    Effect.updateService(effect, CurrentPostOptions, (current) => ({ ...current, ...options }))
)

/**
 * WhatsApp has no mention tokens outside groups, so nothing is a mention:
 * for `ChatTest.checkMessage`, `ChatTest.checkEvent` and
 * `ChatTest.conformance`.
 *
 * @stability unstable
 * @category testing
 * @since 4.1.5
 */
export const parseMention: ParseMention = () => Option.none()
