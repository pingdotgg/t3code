/**
 * The Microsoft Teams adapter for `effect/chat`, over the Bot Framework
 * Connector: the `Registry` layer, the messaging endpoint, the pure
 * normaliser and address helpers.
 *
 * **Details**
 *
 * - One layer serves one Entra tenant, with a single-tenant Azure Bot
 *   registration. The cloud's endpoints and host allowlists come as a unit
 *   from `publicCloud` or a `Cloud` of the consumer's own. They are
 *   privileged configuration and never read from an activity.
 * - Nothing here has run against a real tenant yet, the default
 *   capabilities included. Live testing is follow-up work, and the README
 *   lists its checks. Until a check passes, what it covers is unverified.
 * - Implemented but unverified, and off by default: `buttons`, `modals`,
 *   `modalErrors`, `commands`, `ephemeral`, `startThread` and
 *   `download`, each behind an `unverified` option. Turning one on
 *   advertises a capability no tenant has confirmed.
 * - Not implemented in this version, whatever the options: reading
 *   messages (`fetchMessage`, `history`, `opener`, which need Microsoft
 *   Graph), `replyTo`, files, native streams and selects. They are
 *   `Unsupported`.
 *
 * @stability unstable
 * @since 4.1.5
 */
import * as ByteSize from "effect/ByteSize"
import { Registry } from "effect/chat/ChatAdapter"
import type { ChatError } from "effect/chat/ChatError"
import type { ChatEvent } from "effect/chat/ChatEvent"
import { ChatHandler } from "effect/chat/ChatHandler"
import * as ChatInteraction from "effect/chat/ChatInteraction"
import type { ParseMention } from "effect/chat/ChatTest"
import type { ChatThread } from "effect/chat/ChatThread"
import * as Context from "effect/Context"
import type * as Digest from "effect/crypto/Digest"
import type * as Mac from "effect/crypto/Mac"
import type * as Signature from "effect/crypto/Signature"
import type * as DateTime from "effect/DateTime"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as HttpClient from "effect/http/HttpClient"
import * as HttpRouter from "effect/http/HttpRouter"
import type { SecretJwk } from "effect/jose/Jwk"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import type * as Redacted from "effect/Redacted"
import type * as Schema from "effect/Schema"
import * as Adapter from "./internal/adapter.ts"
import * as Address from "./internal/address.ts"
import * as Auth from "./internal/auth.ts"
import * as Connector from "./internal/connector.ts"
import * as Envelope from "./internal/envelope.ts"
import * as Interactions from "./internal/interactions.ts"
import * as Normalize from "./internal/normalize.ts"
import * as Webhook from "./internal/webhook.ts"

/**
 * The endpoints and host allowlists of one Microsoft cloud.
 *
 * **Details**
 *
 * - `connectorUrl` is where thread ops go. Ops tied to an inbound activity
 *   (an invoke's answer, a command's answer, `followUp`) go to that
 *   activity's `serviceUrl`, which must be `https:` on the default port
 *   with a host exactly in `connectorHosts`, checked before a token is
 *   attached. There is no fallback from one to the other.
 * - `openIdMetadataUrl` and `issuer` check inbound tokens. The metadata's
 *   `jwks_uri` must be on the metadata's own host.
 * - `fileHostSuffixes` and `redirectHosts` bound downloads.
 *
 * @stability unstable
 * @category models
 * @since 4.1.5
 */
export interface Cloud {
  /** The Connector base for thread ops, such as `https://smba.trafficmanager.net/teams`. */
  readonly connectorUrl: string
  /** The exact hosts an activity's `serviceUrl` may name. */
  readonly connectorHosts: ReadonlyArray<string>
  /** Bot Framework's OpenID metadata. Its `jwks_uri` must be on the same host. */
  readonly openIdMetadataUrl: string
  /** The `iss` of an inbound token. */
  readonly issuer: string
  /** The Entra authority, without the tenant: `https://login.microsoftonline.com`. */
  readonly loginUrl: string
  /** The scope of a Connector token. */
  readonly connectorScope: string
  /** The host suffixes of a personal chat's pre-authorised file URL, matched at a label boundary. */
  readonly fileHostSuffixes: ReadonlyArray<string>
  /** Extra exact hosts a download may be redirected to. */
  readonly redirectHosts: ReadonlyArray<string>
}

/**
 * The public Azure cloud: Connector `smba.trafficmanager.net`, Bot
 * Framework's OpenID metadata, Entra at `login.microsoftonline.com`, and
 * `sharepoint.com` for files. No extra redirect hosts.
 *
 * @stability unstable
 * @category constants
 * @since 4.1.5
 */
export const publicCloud: Cloud = Connector.publicCloud

/**
 * How the adapter gets its Connector token: the bot's client secret, for
 * client credentials against the tenant, or a provider that gets a token
 * for a scope, for certificates or managed identities.
 *
 * **Details**
 *
 * A token is cached until five minutes before `expiresAt`. A token
 * without `expiresAt` is not cached, and the provider is called for every
 * request.
 *
 * @stability unstable
 * @category models
 * @since 4.1.5
 */
export type Credentials =
  | Redacted.Redacted<string>
  | ((scope: string) => Effect.Effect<{
    readonly token: Redacted.Redacted<string>
    readonly expiresAt?: DateTime.DateTime | undefined
  }, ChatError>)

/**
 * Capabilities whose live checks have not passed. Each is off by default
 * and, when off, is absent from the descriptor and its op fails
 * `Unsupported`.
 *
 * **Details**
 *
 * - `buttons`: buttons and link buttons on a card. Needs
 *   `interactionKeys`. Selects are never supported.
 * - `modals`: dialogs opened by the buttons named in `modalButtons`, with
 *   field errors. Needs `buttons`.
 * - `commands`: agent slash commands, answered in private or in public,
 *   and `followUp` for 24 hours. Also turns on `ephemeral`.
 * - `startThread`: the reply chain under a channel post.
 * - `download`: files on inbound messages.
 *
 * @stability unstable
 * @category models
 * @since 4.1.5
 */
export interface Unverified {
  readonly buttons?: boolean | undefined
  readonly modals?: boolean | undefined
  readonly commands?: boolean | undefined
  readonly startThread?: boolean | undefined
  readonly download?: boolean | undefined
}

/**
 * The Teams side of the adapter.
 *
 * **Details**
 *
 * - `call` sends one Connector request, with the bot's token, for what the
 *   adapter has no op for. `path` starts with `/v3/` and has its segments
 *   encoded. A `serviceUrl` routes it to an inbound activity's Connector,
 *   after the allowlist check. A write is never retried once sent, and a
 *   failure that may have landed is `uncertain`.
 *
 * @stability unstable
 * @category services
 * @since 4.1.5
 */
export class TeamsChat extends Context.Service<TeamsChat, {
  readonly appId: string
  readonly tenantId: string
  readonly cloud: Cloud
  readonly call: (
    method: "GET" | "POST" | "PUT" | "DELETE",
    path: string,
    body?: unknown,
    options?: {
      readonly write?: boolean | undefined
      readonly serviceUrl?: string | undefined
      readonly query?: Readonly<Record<string, string>> | undefined
    }
  ) => Effect.Effect<Schema.Json | undefined, ChatError>
}>()("@effect/chat-teams/TeamsChat") {}

/**
 * Registers the Teams adapter in the `Registry`, for one tenant.
 *
 * **Details**
 *
 * - `post` and `edit` without elements send the Markdown as `text` with
 *   `textFormat: "extendedmarkdown"`, with every `<` and `&` as an entity,
 *   so no HTML and no `<at>` mention forms, and every `$` outside code as
 *   `\$`, so Teams reads no math. Mentions notify nobody.
 * - With elements, the message is one Adaptive Card and no `text`:
 *   `TextBlock`, `CodeBlock` and `Table` elements from the Markdown, then
 *   `ActionSet` rows. An `edit` may switch between the two forms.
 * - `limits.messageLength` is a budget, not Microsoft's number. It is the
 *   provisional size `Edge` (50,000 UTF-16 units of activity JSON, half of
 *   the 100 KB Microsoft documents, until a live check sets it) less a fixed
 *   reservation `R` for the card's structure, the auxiliary members and
 *   4,000 units of mention entities: 44,288 today. `measure` prices each
 *   unit by what escaping and card structure can make of it.
 * - A button carries a signed token (HS256 JWT) under the card data key
 *   `effect`, bound to the app, the tenant and the conversation. It is
 *   signed, not encrypted: anyone who sees the card can read the id and
 *   value. A token has no replay protection: a click can be sent again
 *   while the conversation exists. A dialog token also binds the user and
 *   expires after an hour.
 * - The adapter's own caps, as Teams publishes none: 6 elements per
 *   message, 10 fields per modal, and two caps counted as the signed token
 *   that carries the data, envelope included. `actionDataLength` is 1,000
 *   units of button token, about 500 ASCII characters of id plus value with
 *   a GUID app and tenant. `modalMetadataLength` is 4,000 units of dialog
 *   token, and the whole token counts: the modal's id, metadata, title,
 *   labels, options and texts together get about 1,880 bytes of JSON. A
 *   modal over it is refused `TooLarge` before anything opens.
 *   A message with every element at its cap still fits `messageLength`.
 * - The `HttpClient` must add no credentials of its own and follow no
 *   redirects. The adapter decides per request which host gets the bot's
 *   token, asks Fetch for `redirect: "manual"` and fails a response from
 *   any other URL than the one it sent to. A client other than
 *   `FetchHttpClient`, or middleware that rewrites requests, must keep
 *   that.
 * - `getUser` needs `in`, the thread whose roster to read: without it
 *   it fails `InvalidRequest` with `thread_required`. A user's id is the
 *   Entra object id when Teams sends one, and the Connector id (`29:…`,
 *   `28:…`) otherwise; `raw` keeps the Connector record.
 * - The layer provides `TeamsChat` beside registering the adapter. It
 *   needs `Mac` and `Digest` for the interaction tokens; the adapter
 *   never calls `crypto.subtle` itself.
 *
 * @stability unstable
 * @category layers
 * @since 4.1.5
 */
export const layer = (options: {
  readonly appId: string
  readonly tenantId: string
  readonly credentials: Credentials
  readonly cloud?: Cloud | undefined
  /**
   * The keys that sign button and dialog tokens. The first signs, and any
   * verifies by its `kid`, so a rotation adds a key in front and drops the
   * old one later. Each needs a distinct `kid` of 1 to 16 characters from
   * `[A-Za-z0-9_-]` and at least 32 bytes. Without keys, there are no
   * buttons or modals.
   */
  readonly interactionKeys?: readonly [Redacted.Redacted<SecretJwk>, ...Array<Redacted.Redacted<SecretJwk>>] | undefined
  /** The ids of the buttons that open a dialog. Only these may answer `OpenModal`. */
  readonly modalButtons?: ReadonlyArray<string> | undefined
  readonly unverified?: Unverified | undefined
}): Layer.Layer<TeamsChat, never, HttpClient.HttpClient | Registry | Mac.Mac | Digest.Digest> =>
  Layer.effect(
    TeamsChat,
    Effect.gen(function*() {
      const http = yield* HttpClient.HttpClient
      const registry = yield* Registry
      const cloud = options.cloud ?? publicCloud
      const tokens = Connector.makeTokens({
        http,
        cloud,
        appId: options.appId,
        tenantId: options.tenantId,
        credentials: options.credentials
      })
      const connector = Connector.make({ http, cloud, token: tokens })
      const envelope = options.interactionKeys === undefined
        ? undefined
        : yield* Envelope.make({ appId: options.appId, tenantId: options.tenantId, keys: options.interactionKeys })
      const modalButtons = new Set(options.modalButtons ?? [])
      const { adapter, answer } = Adapter.make({
        connector,
        http,
        cloud,
        appId: options.appId,
        tenantId: options.tenantId,
        envelope,
        unverified: options.unverified ?? {},
        token: tokens(cloud.connectorScope),
        modalButtons
      })
      yield* registry.register(adapter)
      const service = TeamsChat.of({
        appId: options.appId,
        tenantId: options.tenantId,
        cloud,
        call: connector.call
      })
      Adapter.internals.set(service, { capabilities: adapter.descriptor.capabilities, envelope, modalButtons, answer })
      return service
    })
  )

/**
 * `POST {path}`: the bot's messaging endpoint.
 *
 * **Details**
 *
 * - Checks the bearer token: RS256 with a key from Bot Framework's key set
 *   that is endorsed for `msteams`, the cloud's issuer, the app id as
 *   audience, five minutes of skew and an `exp`. Then the token's
 *   `serviceurl` must equal the activity's `serviceUrl`, `channelId`
 *   must be `msteams` and the tenant the layer's. Any failure is 403. A
 *   key set that can't be read is 503.
 * - A targeted activity, one only the bot can see, is classified before
 *   anything else, whatever its type. A targeted message takes the command
 *   path: its first word names the command and the rest is its `text`. One
 *   that names no registered command is acked and nothing is sent. A
 *   targeted invoke goes to the interaction handler. Any other targeted
 *   activity is answered 200 and dropped. None reaches the `ChatHandler`,
 *   `onUnhandled`, or anything public.
 * - Invokes go to `ChatInteraction.Handler` within `interactionDeadline`
 *   (4 seconds by default). Without a `Handler` in context, every invoke
 *   and every targeted message gets an empty 200.
 * - Other activities go through `normalize` to the `ChatHandler`: 200
 *   when it succeeds, 503 when it fails `NotAccepted` or a message can't
 *   be normalised. An activity with no event goes to `onUnhandled` and is
 *   answered 200. Past `deadline` (10 seconds by default) the handler is
 *   interrupted and the answer is 503. Each 503 is logged with its reason.
 * - Answers 413 past `maxBodyBytes` (1 MiB by default), and 400 for a body
 *   that can't be read or is not a JSON object, both before the token is
 *   checked. `maxBodyBytes` must be a non-negative safe integer; another
 *   value is a defect when the layer is built.
 *
 * The metadata and the key set are fetched with redirects off, and the
 * metadata is read up to 64 KiB. A metadata document or `jwks_uri` that
 * can't be read is 503. The `HttpClient` has the same requirements as for
 * `layer`.
 *
 * Token checks need the `Signature` service. Importing the key set's
 * public keys goes through `Jwk.importPublic`, which needs a `WebCrypto`
 * reference whatever crypto backend provides `Signature`.
 *
 * @stability unstable
 * @category layers
 * @since 4.1.5
 */
export const layerWebhook = (options: {
  readonly path: `/${string}`
  readonly deadline?: Duration.Input | undefined
  readonly interactionDeadline?: Duration.Input | undefined
  readonly maxBodyBytes?: number | undefined
  readonly onUnhandled?: ((activity: Schema.Json) => Effect.Effect<void>) | undefined
}): Layer.Layer<
  never,
  never,
  HttpRouter.HttpRouter | TeamsChat | ChatHandler | HttpClient.HttpClient | Signature.Signature
> =>
  HttpRouter.use(Effect.fnUntraced(function*(router) {
    const teams = yield* TeamsChat
    const internals = Adapter.internals.get(teams)
    if (internals === undefined) return yield* Effect.die(new Error("TeamsChat.layerWebhook needs TeamsChat.layer"))
    const handler = yield* ChatHandler
    const interactionHandler = yield* Effect.serviceOption(ChatInteraction.Handler)
    const interactionRegistry = yield* Effect.serviceOption(ChatInteraction.Registry)
    const verify = yield* Auth.makeVerifier({ cloud: teams.cloud, appId: teams.appId, tenantId: teams.tenantId })
    const interactionOptions: Interactions.Options = {
      capabilities: internals.capabilities,
      envelope: internals.envelope,
      modalButtons: internals.modalButtons,
      answer: internals.answer,
      deadline: options.interactionDeadline === undefined
        ? Interactions.defaultDeadline
        : Duration.fromInputUnsafe(options.interactionDeadline)
    }
    const webhookOptions: Webhook.Options = {
      verify,
      context: {
        appId: teams.appId,
        connectorHosts: new Set(teams.cloud.connectorHosts),
        fileHostSuffixes: teams.cloud.fileHostSuffixes
      },
      handle: handler.handle,
      onUnhandled: options.onUnhandled ?? (() => Effect.void),
      invoke: (activity) =>
        Option.isNone(interactionHandler)
          ? Effect.succeed({ status: 200 })
          : Effect.provideService(
            Interactions.invoke(activity, interactionOptions),
            ChatInteraction.Handler,
            interactionHandler.value
          ),
      command: (activity) =>
        Option.isNone(interactionHandler) || Option.isNone(interactionRegistry)
          ? Effect.void
          : Effect.provideService(
            Interactions.command(activity, {
              ...interactionOptions,
              isRegistered: (id) =>
                Effect.map(interactionRegistry.value.get(id), (entry) => entry?.definition.kind === "command")
            }),
            ChatInteraction.Handler,
            interactionHandler.value
          ),
      deadline: options.deadline ?? Duration.seconds(10),
      maxBodySize: ByteSize.bytes(options.maxBodyBytes ?? 1024 * 1024)
    }
    yield* router.add("POST", options.path, (request) => Webhook.handleRequest(request, webhookOptions))
  }))

/**
 * The address of a Teams conversation: the Bot Framework conversation id as
 * it is. A channel thread is the channel's id followed by
 * `;messageid={root}`.
 *
 * @stability unstable
 * @category constructors
 * @since 4.1.5
 */
export const thread: (conversationId: string) => ChatThread = Address.thread

/**
 * The parts of a Teams address, or `None` for another platform's or a
 * malformed one.
 *
 * @stability unstable
 * @category destructors
 * @since 4.1.5
 */
export const parts: (thread: ChatThread) => Option.Option<{
  readonly conversationId: string
  readonly base: string
  readonly root?: string | undefined
}> = Address.parts

/**
 * The normaliser, for a consumer's own transport. It checks no token: that
 * is the transport's job.
 *
 * **Details**
 *
 * - Pure: takes an activity, gives zero or more events.
 * - A `message` gives a `MessageCreated`. Its `text` is Teams' `text` as
 *   delivered, with `<at>…</at>` for each mention, where `mentions` point.
 *   A channel post is addressed to the channel, a reply to the post's
 *   thread.
 * - `messageReaction` gives a `ReactionAdded` or `ReactionRemoved` per
 *   reaction. The six types Teams documents are Unicode emoji; any other is
 *   `custom:{type}`.
 * - A targeted activity, a card submit and anything else give none.
 * - `raw` is the activity.
 *
 * @stability unstable
 * @category normalization
 * @since 4.1.5
 */
export const normalize = (
  activity: unknown,
  context: { readonly appId: string; readonly cloud?: Cloud | undefined }
): ReadonlyArray<ChatEvent> => {
  const cloud = context.cloud ?? publicCloud
  return Normalize.normalize(activity, {
    appId: context.appId,
    connectorHosts: new Set(cloud.connectorHosts),
    fileHostSuffixes: cloud.fileHostSuffixes
  })
}

/**
 * Reads one Teams mention, `<at>…</at>`, for `ChatTest`. The tag holds a
 * display name and no id, so this is always `None`; a message's
 * `mentions` come from its entities.
 *
 * @stability unstable
 * @category testing
 * @since 4.1.5
 */
export const parseMention: ParseMention = () => Option.none()
