import {
  type ChatAdapter,
  checkMessageLength,
  type Descriptor,
  type Posted,
  type ThreadInfo,
  type User
} from "effect/chat/ChatAdapter"
import { type Capability, type ChatError, type ChatErrorReason, interactionExpired } from "effect/chat/ChatError"
import type { Defer } from "effect/chat/ChatInteraction"
import type { Attachment } from "effect/chat/ChatMessage"
import type { ChatThread } from "effect/chat/ChatThread"
import type { Action } from "effect/chat/ChatUi"
import * as Clock from "effect/Clock"
import * as DateTime from "effect/DateTime"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import type * as HttpClient from "effect/http/HttpClient"
import * as Option from "effect/Option"
import type * as Redacted from "effect/Redacted"
import type * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import type { Cloud, Unverified } from "../TeamsChat.ts"
import * as Address from "./address.ts"
import { type Connector, segment } from "./connector.ts"
import * as Download from "./download.ts"
import type * as Envelope from "./envelope.ts"
import * as Errors from "./errors.ts"
import * as Length from "./length.ts"
import { botId, userId } from "./normalize.ts"
import { isObject, object, string } from "./parse.ts"
import * as Render from "./render.ts"

/** The adapter's own cap on elements in one message. @internal */
export const actionsPerMessage = Render.actionsPerRow

/**
 * The adapter's own cap on an element's id plus value, counted as the
 * signed token that carries them: 329 units of it are the envelope with a
 * GUID app and tenant, which leaves about 500 ASCII characters.
 *
 * @internal
 */
export const actionDataLength = 1_000

/**
 * The adapter's own cap on a modal's id plus metadata, counted as the whole
 * signed dialog token that carries them: the claims, the metadata and the
 * modal's definition (title, labels, options, texts). With a GUID app and
 * tenant and every id at its longest, the claims take at most 1,483 units,
 * which leaves about 1,880 bytes for the rest of the modal's JSON.
 *
 * @internal
 */
export const modalMetadataLength = 4_000

/** The adapter's own cap on a modal's inputs and texts. @internal */
export const modalFields = 10

/** How long a targeted message can be answered. @internal */
export const followUpAge = Duration.hours(24)

/** @internal */
export const capabilitiesOf = (unverified: Unverified, hasKeys: boolean): ReadonlySet<Capability> => {
  const set = new Set<Capability>(["edit", "delete", "getThread", "getUser"])
  if (unverified.startThread === true) set.add("startThread")
  if (unverified.download === true) set.add("download")
  if (hasKeys && unverified.buttons === true) {
    set.add("buttons")
    if (unverified.modals === true) {
      set.add("modals")
      set.add("modalErrors")
    }
  }
  if (unverified.commands === true) {
    set.add("commands")
    set.add("ephemeral")
  }
  return set
}

/** @internal */
export const makeDescriptor = (capabilities: ReadonlySet<Capability>, tokenLength: Length.TokenLength): Descriptor => ({
  platform: Address.platform,
  capabilities,
  measure: Length.makeMeasure(tokenLength),
  limits: {
    messageLength: Length.messageLength,
    filesPerMessage: 0,
    uploadBytes: 0,
    minWriteInterval: Duration.seconds(1),
    ...(capabilities.has("buttons") ? { actionsPerMessage, actionDataLength } : {}),
    ...(capabilities.has("modals") ? { modalMetadataLength, modalFields } : {}),
    ...(capabilities.has("commands") ? { followUpAge } : {})
  }
})

/** A fallback token length for a layer without keys: the largest a token can be. */
const noKeys: Length.TokenLength = () => 0

/** @internal */
export interface Options {
  readonly connector: Connector
  readonly http: HttpClient.HttpClient
  readonly cloud: Cloud
  readonly appId: string
  readonly tenantId: string
  readonly envelope: Envelope.Envelope | undefined
  readonly unverified: Unverified
  readonly token: Effect.Effect<Redacted.Redacted<string>, ChatError>
  /** The ids of the buttons that open a dialog. */
  readonly modalButtons: ReadonlySet<string>
}

/** @internal */
export interface Made {
  readonly adapter: ChatAdapter
  /**
   * Sends a command's answer through the inbound `serviceUrl` in `raw`:
   * private as a targeted message to the command's user, public as a new
   * post. A failure is never retried in the other form.
   */
  readonly answer: (
    op: string,
    raw: Schema.Json,
    content: { readonly markdown: string; readonly actions?: ReadonlyArray<Action> | undefined },
    visibility: "ephemeral" | "public"
  ) => Effect.Effect<void, ChatError>
}

const fail = (op: string, reason: ChatErrorReason) => Effect.fail(Errors.chatError(op, reason))

/** @internal */
export const make = (options: Options): Made => {
  const capabilities = capabilitiesOf(options.unverified, options.envelope !== undefined)
  const descriptor = makeDescriptor(capabilities, options.envelope?.tokenLength ?? noKeys)
  const { connector } = options
  const self = botId(options.appId)
  const downloadOptions = {
    token: options.token,
    connectorHosts: new Set(options.cloud.connectorHosts),
    fileHostSuffixes: options.cloud.fileHostSuffixes,
    redirectHosts: new Set(options.cloud.redirectHosts),
    http: options.http
  }

  const unsupported = (op: string, capability: Capability) => fail(op, Errors.unsupported(capability))

  const address = (op: string, thread: ChatThread): Effect.Effect<Address.Parts, ChatError> => {
    const parts = Address.parts(thread)
    return Option.isSome(parts) ? Effect.succeed(parts.value) : fail(op, Errors.invalidRequest("invalid_thread"))
  }

  const checkId = (op: string, id: string): Effect.Effect<void, ChatError> =>
    id.length === 0 || id.length > Address.maxIdLength ? fail(op, Errors.invalidRequest("invalid_id")) : Effect.void

  /**
   * The activity body for Markdown and elements: the text form without
   * elements, one card with them. Checks capabilities and limits first.
   */
  const body = (
    op: string,
    conversationId: string,
    content: { readonly markdown: string; readonly actions?: ReadonlyArray<Action> | undefined }
  ): Effect.Effect<Record<string, unknown>, ChatError> =>
    Effect.gen(function*() {
      const actions = content.actions ?? []
      if (actions.some((action) => action._tag === "Select")) return yield* unsupported(op, "selects")
      if (actions.length > 0 && (!capabilities.has("buttons") || options.envelope === undefined)) {
        return yield* unsupported(op, "buttons")
      }
      yield* checkMessageLength(descriptor, op, content.markdown, actions)
      if (actions.length === 0) return Render.textActivity(content.markdown)
      if (actions.length > actionsPerMessage) return yield* fail(op, Errors.tooLarge(undefined, "too_many_actions"))
      const tokens = new Map<Action, string>()
      for (const action of actions) {
        if (action._tag !== "Button") continue
        if (options.envelope!.tokenLength(action) > actionDataLength) {
          return yield* fail(op, Errors.tooLarge(undefined, "action_data_too_long"))
        }
        const token = yield* Effect.mapError(
          options.envelope!.signButton(conversationId, {
            id: action.id,
            ...(action.value === undefined ? {} : { value: action.value })
          }),
          (reason) => Errors.chatError(op, reason)
        )
        tokens.set(action, token)
      }
      return Render.cardActivity(
        content.markdown,
        actions,
        (button) => tokens.get(button)!,
        (button) => options.modalButtons.has(button.id)
      )
    })

  const now = Effect.map(Clock.currentTimeMillis, (millis) => DateTime.makeUnsafe(millis))

  const activityId = (op: string, answer: Schema.Json | undefined): Effect.Effect<string, ChatError> => {
    const id = string(answer, "id")
    return id === undefined ? fail(op, Errors.invalidResponse(true, "missing_id")) : Effect.succeed(id)
  }

  const activities = (conversationId: string) => `/v3/conversations/${segment(conversationId)}/activities`

  const adapter: ChatAdapter = {
    descriptor,
    post: Effect.fnUntraced(function*(thread, content) {
      const op = "post"
      const parts = yield* address(op, thread)
      if (content.files !== undefined && content.files.length > 0) return yield* unsupported(op, "files")
      if (content.replyTo !== undefined) return yield* unsupported(op, "replyTo")
      const activity = yield* body(op, parts.conversationId, content)
      const answer = yield* connector.call("POST", activities(parts.conversationId), activity, { write: true, op })
      const id = yield* activityId(op, answer)
      return { id, thread, timestamp: yield* now } satisfies Posted
    }),
    edit: Effect.fnUntraced(function*(thread, messageId, content) {
      const op = "edit"
      const parts = yield* address(op, thread)
      yield* checkId(op, messageId)
      const activity = yield* body(op, parts.conversationId, content)
      yield* connector.call(
        "PUT",
        `${activities(parts.conversationId)}/${segment(messageId)}`,
        { ...activity, id: messageId },
        { write: true, op }
      )
    }),
    delete: Effect.fnUntraced(function*(thread, messageId) {
      const op = "delete"
      const parts = yield* address(op, thread)
      yield* checkId(op, messageId)
      yield* connector.call("DELETE", `${activities(parts.conversationId)}/${segment(messageId)}`, undefined, {
        write: true,
        op
      })
    }),
    fetchMessage: () => unsupported("fetchMessage", "fetchMessage"),
    history: () => Stream.fail(Errors.chatError("history", Errors.unsupported("history"))),
    download: (_thread: ChatThread, attachment: Attachment, { maxBytes }: { readonly maxBytes: number }) =>
      capabilities.has("download")
        ? Download.download(attachment.id, { ...downloadOptions, maxBytes })
        : Stream.fail(Errors.chatError("download", Errors.unsupported("download"))),
    startThread: Effect.fnUntraced(function*(thread, messageId) {
      const op = "startThread"
      if (!capabilities.has("startThread")) return yield* unsupported(op, "startThread")
      const parts = yield* address(op, thread)
      yield* checkId(op, messageId)
      if (parts.root !== undefined) return parts.root === messageId ? thread : Address.threadOf(parts.base, messageId)
      if (!Address.isChannel(parts.base)) return yield* fail(op, Errors.invalidRequest("not_a_channel"))
      if (!/^\d+$/.test(messageId)) return yield* fail(op, Errors.invalidRequest("invalid_id"))
      return Address.threadOf(parts.base, messageId)
    }),
    getThread: Effect.fnUntraced(function*(thread) {
      const op = "getThread"
      const parts = yield* address(op, thread)
      const raw = yield* connector.call(
        "GET",
        `/v3/conversations/${segment(parts.base)}/pagedmembers`,
        undefined,
        { op, query: { pageSize: "1" } }
      )
      const info: ThreadInfo = {
        thread,
        kind: Address.kind(parts.conversationId),
        ...(parts.root === undefined ? {} : { parent: Address.thread(parts.base) }),
        raw: raw ?? null
      }
      return info
    }),
    opener: () => unsupported("opener", "opener"),
    getUser: Effect.fnUntraced(function*(id, userOptions) {
      const op = "getUser"
      if (userOptions?.in === undefined) return yield* fail(op, Errors.invalidRequest("thread_required"))
      const parts = yield* address(op, userOptions.in)
      yield* checkId(op, id)
      const raw = yield* connector.call(
        "GET",
        `/v3/conversations/${segment(parts.base)}/members/${segment(id)}`,
        undefined,
        { op }
      )
      const connectorId = string(raw, "id")
      const canonical = userId(raw)
      if (!isObject(raw) || connectorId === undefined || canonical === undefined) {
        return yield* fail(op, Errors.invalidResponse(false, "invalid_member"))
      }
      const user: User = {
        id: canonical,
        name: string(raw, "name") ?? string(raw, "givenName") ?? canonical,
        isBot: connectorId.startsWith("28:"),
        isSelf: connectorId === self,
        raw
      }
      return user
    }),
    followUp: Effect.fnUntraced(function*(deferred: Defer, content) {
      const op = "followUp"
      if (!capabilities.has("commands")) return yield* unsupported(op, "commands")
      const raw = deferred.command.raw
      const sent = string(raw, "timestamp")
      const at = sent === undefined ? undefined : Option.getOrUndefined(DateTime.make(sent))
      const current = yield* Clock.currentTimeMillis
      if (at === undefined || current - DateTime.toEpochMillis(at) > Duration.toMillis(followUpAge)) {
        return yield* fail(op, Errors.notFound(interactionExpired))
      }
      yield* answer(op, raw, content, deferred.visibility)
    })
  }

  const answer: Made["answer"] = Effect.fnUntraced(function*(op, raw, content, visibility) {
    if (!isObject(raw)) return yield* fail(op, Errors.invalidRequest("invalid_command"))
    const serviceUrl = string(raw, "serviceUrl")
    const conversationId = string(object(raw, "conversation"), "id")
    const messageId = string(raw, "id")
    const recipientId = string(object(raw, "from"), "id")
    if (
      serviceUrl === undefined || conversationId === undefined || messageId === undefined ||
      recipientId === undefined
    ) {
      return yield* fail(op, Errors.invalidRequest("invalid_command"))
    }
    for (const id of [conversationId, messageId, recipientId]) yield* checkId(op, id)
    const activity = yield* body(op, conversationId, content)
    if (visibility === "ephemeral") {
      yield* connector.call("POST", activities(conversationId), {
        ...activity,
        // Only the id: `Length.A` reserves it, and an unbounded name would break the size bound.
        recipient: { id: recipientId },
        entities: [{ type: "targetedMessageInfo", messageId }]
      }, { write: true, op, serviceUrl, query: { isTargetedActivity: "true" } })
    } else {
      yield* connector.call("POST", activities(conversationId), activity, { write: true, op, serviceUrl })
    }
  })

  return { adapter, answer }
}

/** What `layerWebhook` needs from the layer that registered the adapter. @internal */
export interface Internals {
  readonly capabilities: ReadonlySet<Capability>
  readonly envelope: Envelope.Envelope | undefined
  readonly modalButtons: ReadonlySet<string>
  readonly answer: Made["answer"]
}

/** Keyed by the `TeamsChat` service the layer built. @internal */
export const internals = new WeakMap<object, Internals>()
