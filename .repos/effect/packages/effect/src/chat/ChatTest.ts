/**
 * Testing tools for chat adapters and their consumers.
 *
 * `layer` builds a whole chat in memory: `Chat`, its registry and one fake
 * adapter with configurable capabilities and fault injection. `conformance`
 * is the suite of rules every adapter obeys, as plain Effects keyed by rule
 * name. `checkMessage`, `checkEvent` and `checkInteraction` assert the
 * invariants every message, event and interaction holds, for fixture tests
 * and live runs.
 *
 * **Details**
 *
 * The fake adapter's mention syntax is `<@id>` for a user, `<@&id>` for a
 * role, `<#id>` for a channel and `<!id>` for a broadcast.
 *
 * @stability unstable
 * @since 4.1.5
 */
import * as Bytes from "../Bytes.ts"
import * as Clock from "../Clock.ts"
import * as Context from "../Context.ts"
import * as DateTime from "../DateTime.ts"
import * as Duration from "../Duration.ts"
import * as Effect from "../Effect.ts"
import * as Exit from "../Exit.ts"
import * as Layer from "../Layer.ts"
import * as Option from "../Option.ts"
import * as Predicate from "../Predicate.ts"
import * as Schema from "../Schema.ts"
import * as Stream from "../Stream.ts"
import * as Str from "../String.ts"
import * as Chat from "./Chat.ts"
import type { ChatAdapter, Descriptor, File, NativeStream, Posted } from "./ChatAdapter.ts"
import { checkMessageLength, Registry, retrySafe } from "./ChatAdapter.ts"
import type { ChatErrorReason } from "./ChatError.ts"
import {
  Capability,
  ChatError,
  fileRefused,
  Forbidden,
  interactionExpired,
  InvalidRequest,
  isChatError,
  NotFound,
  RateLimited,
  TooLarge,
  Transport,
  Unsupported
} from "./ChatError.ts"
import type { ThreadKind } from "./ChatEvent.ts"
import * as ChatEvent from "./ChatEvent.ts"
import { ChatHandler } from "./ChatHandler.ts"
import type { NotAccepted } from "./ChatHandler.ts"
import * as ChatInteraction from "./ChatInteraction.ts"
import type { Attachment, Mention, ReplyTo } from "./ChatMessage.ts"
import * as ChatMessage from "./ChatMessage.ts"
import * as ChatThread from "./ChatThread.ts"
import type * as ChatUi from "./ChatUi.ts"

/**
 * Reads a slice of `ChatMessage.text` as one of the platform's mention
 * tokens.
 *
 * **Details**
 *
 * The core does not know any platform's syntax, so the caller supplies it. A
 * slice that is not a mention token returns `None`.
 *
 * @stability unstable
 * @category models
 * @since 4.1.5
 */
export type ParseMention = (slice: string) => Option.Option<{
  readonly kind: Mention["kind"]
  readonly id: string
}>

/**
 * One call the fake adapter received, in order. Every attempt is a call, so a
 * retried request shows up once per attempt.
 *
 * @stability unstable
 * @category models
 * @since 4.1.5
 */
export interface Call {
  readonly op: string
  readonly thread: ChatThread.ChatThread
  readonly messageId?: string | undefined
  readonly markdown?: string | undefined
  readonly files?: ReadonlyArray<File> | undefined
  readonly outcome: "ok" | ChatErrorReason["_tag"]
}

/**
 * Error for a click on an element the message does not carry, or on a
 * message that is gone.
 *
 * @stability unstable
 * @category errors
 * @since 4.1.5
 */
export class NoSuchElement extends Schema.TaggedError<NoSuchElement>("effect/chat/ChatTest/NoSuchElement")(
  "NoSuchElement",
  { messageId: Schema.String, id: Schema.String }
) {}

/**
 * Service that controls the fake adapter built by `layer`.
 *
 * **Details**
 *
 * - `makeThread` creates a fresh address: a channel by default, a direct
 *   conversation, or a thread under a user's message in a fresh channel.
 * - `userPosts` puts another identity's message in a thread and returns its
 *   event without delivering it. `deliver` delivers an event the way an
 *   adapter does, by calling the `ChatHandler` service.
 * - `messages` is what a thread shows now, oldest first, and `calls` is every
 *   call the adapter received.
 * - `failNext` makes the next `times` calls of `op` fail with `reason`.
 *   `landed` makes the write happen anyway, which is what `uncertain` means.
 *   The native stream's ops are `nativeStream.start`, `nativeStream.append`
 *   and `nativeStream.stop`.
 * - `refuseFiles` makes the next `times` posts with files fail `denied` with
 *   detail `file_refused`, storing nothing. Text-only posts do not consume it.
 * - `clickStop` is a user clicking stop on a native stream. It closes
 *   nothing, as on Slack: the stream keeps taking text, and
 *   `NativeStream.stop` then reports `stopped: true`.
 * - `closeStream` closes a native stream from outside, so the next append
 *   gives `closed`, or `stopped` after a click.
 * - `click` builds the click on element `id` of a message from what the
 *   fake stored at `post` or `edit`, without delivering it. For a select,
 *   `option` is the encoded value of the option to choose, the first by
 *   default. It fails `NoSuchElement` when the message has no such element,
 *   or no such option, or is gone.
 * - `command` builds a command typed at `thread`, without delivering it.
 *   `text` defaults to the empty string. The fake has no registration, so
 *   any id can be typed.
 * - `submit` builds the submit of a modal. It takes the click or the command
 *   that opened it, because an `OpenModal` reply does not say where it was
 *   opened from and a `ModalSubmitted` has to. A command gives a submit
 *   with no `messageId`. `values` are by field id, still encoded, and an
 *   empty one is left out, as for an optional field left empty.
 * - `interact` delivers an interaction the way an adapter does: through
 *   `ChatInteraction.handle` with the layer's `interactionDeadline`, then
 *   the fake's own checks on an `OpenModal` (the `modals` capability,
 *   `limits.modalMetadataLength` against the modal's id plus its encoded
 *   metadata, and `limits.modalFields`), calling `Handler.refused` when one
 *   fails. It succeeds with the handler's reply as it returned it, or
 *   `Late`. An `OpenModal` shows in `calls` as op `openModal`.
 * - For a command, `interact` runs the checks of `post` on a `Respond`
 *   (the element capabilities, `limits.messageLength` and the element
 *   limits), and refuses a private `Respond` or `Defer` without
 *   `ephemeral`. A `Respond` shows in `calls` as op `respond`, and a
 *   `followUp` as op `followUp`, each with the command's thread and the
 *   Markdown. Neither is stored as a message.
 * - The fake's `followUp` succeeds once for a `Defer` that `interact`
 *   returned, inside `limits.followUpAge` on `Clock`. Later, a second time,
 *   or for a deferral the fake never saw, it fails `NotFound` with detail
 *   `interaction_expired`. Failing the second call is stricter than either
 *   platform, to catch a handler that relies on more than one: Slack posts
 *   another message and Discord replaces the first.
 *
 * @stability unstable
 * @category services
 * @since 4.1.5
 */
export class ChatTest extends Context.Service<ChatTest, {
  readonly platform: string
  readonly selfId: string
  readonly makeThread: (kind?: ThreadKind) => Effect.Effect<ChatThread.ChatThread>
  readonly userPosts: (thread: ChatThread.ChatThread, message: {
    readonly text: string
    readonly authorId?: string | undefined
    readonly isBot?: boolean | undefined
    readonly mentionsSelf?: boolean | undefined
    readonly replyTo?: ReplyTo | undefined
    readonly files?: ReadonlyArray<File> | undefined
  }) => Effect.Effect<ChatEvent.ChatEvent>
  readonly deliver: (event: ChatEvent.ChatEvent) => Effect.Effect<void, NotAccepted, ChatHandler>
  readonly messages: (thread: ChatThread.ChatThread) => Effect.Effect<ReadonlyArray<ChatMessage.ChatMessage>>
  readonly calls: Effect.Effect<ReadonlyArray<Call>>
  readonly failNext: (op: string, reason: ChatErrorReason, options?: {
    readonly times?: number | undefined
    readonly landed?: boolean | undefined
  }) => Effect.Effect<void>
  readonly refuseFiles: (options?: { readonly times?: number | undefined }) => Effect.Effect<void>
  readonly clickStop: (messageId: string) => Effect.Effect<void>
  readonly closeStream: (messageId: string) => Effect.Effect<void>
  readonly click: (messageId: string, id: string, options?: {
    readonly userId?: string | undefined
    readonly option?: string | undefined
  }) => Effect.Effect<ChatInteraction.ButtonClicked | ChatInteraction.SelectChanged, NoSuchElement>
  readonly command: (thread: ChatThread.ChatThread, id: string, options?: {
    readonly text?: string | undefined
    readonly userId?: string | undefined
  }) => Effect.Effect<ChatInteraction.CommandInvoked>
  readonly submit: (
    from: ChatInteraction.ButtonClicked | ChatInteraction.SelectChanged | ChatInteraction.CommandInvoked,
    opened: ChatInteraction.OpenModal,
    values: Readonly<Record<string, string>>,
    options?: { readonly userId?: string | undefined }
  ) => Effect.Effect<ChatInteraction.ModalSubmitted>
  readonly interact: {
    (event: ChatInteraction.ButtonClicked | ChatInteraction.SelectChanged): Effect.Effect<
      ChatInteraction.ClickReply | ChatInteraction.Late,
      never,
      ChatInteraction.Handler
    >
    (event: ChatInteraction.ModalSubmitted): Effect.Effect<
      ChatInteraction.SubmitReply | ChatInteraction.Late,
      never,
      ChatInteraction.Handler
    >
    (event: ChatInteraction.CommandInvoked): Effect.Effect<
      ChatInteraction.CommandReply | ChatInteraction.Late,
      never,
      ChatInteraction.Handler
    >
  }
}>()("effect/chat/ChatTest") {}

// -----------------------------------------------------------------------------
// fake adapter
// -----------------------------------------------------------------------------

const allCapabilities: ReadonlyArray<Capability> = Capability.literals

/** Counts code points. */
const codePoints = (markdown: string): number => {
  let count = 0
  for (const _ of markdown) count++
  return count
}

interface StoredStream {
  readonly startedAt: number
  open: boolean
  clicked: boolean
}

/** An append holds back an unclosed `<` tail, as Slack does, up to this many characters. */
const heldBound = 100

interface StoredThread {
  readonly thread: ChatThread.ChatThread
  readonly kind: ThreadKind
  readonly name?: string | undefined
  readonly parent?: ChatThread.ChatThread | undefined
  readonly openerId?: string | undefined
  readonly createdAt: DateTime.Utc
}

interface StoredMessage {
  readonly id: string
  readonly thread: ChatThread.ChatThread
  readonly authorId: string
  readonly isBot: boolean
  readonly isSelf: boolean
  text: string
  mentions: ReadonlyArray<Mention>
  readonly replyTo?: ReplyTo | undefined
  readonly attachments: ReadonlyArray<{ readonly attachment: Attachment; readonly content: Uint8Array }>
  readonly timestamp: DateTime.Utc
  actions: ReadonlyArray<ChatUi.Action>
}

interface Fault {
  readonly reason: ChatErrorReason
  remaining: number
  readonly landed: boolean
}

const mentionPattern = /<(@&|@|#|!)([^<>\s]+)>/g

const mentionKinds: Record<string, Mention["kind"]> = {
  "@": "user",
  "@&": "role",
  "#": "channel",
  "!": "broadcast"
}

const parseMentions = (text: string, selfId: string): ReadonlyArray<Mention> =>
  Array.from(text.matchAll(mentionPattern), (match) => {
    const kind = mentionKinds[match[1]]
    return {
      kind,
      id: match[2],
      start: match.index,
      end: match.index + match[0].length,
      isSelf: kind === "user" && match[2] === selfId
    }
  })

const downloadChunkSize = 1024

const makeFake = (options: {
  readonly platform: string
  readonly selfId: string
  readonly capabilities: ReadonlyArray<Capability>
  readonly limits: Partial<Descriptor["limits"]>
  readonly measure: Descriptor["measure"]
  readonly interactionDeadline: Duration.Duration
}) => {
  const { platform, selfId } = options
  const capabilities = new Set(options.capabilities)
  const messageLength = options.limits.messageLength ?? 4000
  const hasActions = capabilities.has("buttons") || capabilities.has("selects")
  const descriptor: Descriptor = {
    platform,
    capabilities,
    measure: options.measure,
    limits: {
      messageLength,
      filesPerMessage: 10,
      uploadBytes: 10 * 1024 * 1024,
      minWriteInterval: Duration.zero,
      ...(capabilities.has("nativeStream") ? { streamLength: messageLength, streamAge: Duration.minutes(10) } : {}),
      ...(hasActions ? { actionsPerMessage: 25, actionDataLength: 100 } : {}),
      ...(capabilities.has("modals") ? { modalMetadataLength: 100, modalFields: 5 } : {}),
      ...(capabilities.has("commands") ? { followUpAge: Duration.minutes(15) } : {}),
      ...options.limits
    }
  }
  const streams = new Map<string, StoredStream>()
  const threads = new Map<string, StoredThread>()
  const messages = new Map<string, StoredMessage>()
  const order: Array<string> = []
  const threadUnder = new Map<string, ChatThread.ChatThread>()
  const users = new Map<string, { readonly isBot: boolean }>([[selfId, { isBot: true }]])
  const calls: Array<Call> = []
  /** Deferrals `interact` returned, by the command's raw id, with when they were made. */
  const deferrals = new Map<string, { readonly at: number; used: boolean }>()
  let refusedFiles = 0
  const faults = new Map<string, Array<Fault>>()
  let counter = 0
  const nextId = (prefix: string) => prefix + String(++counter)

  const chatError = (op: string, reason: ChatErrorReason) => new ChatError({ platform, op, reason })
  const fail = (op: string, reason: ChatErrorReason) => Effect.fail(chatError(op, reason))

  const toMessage = (message: StoredMessage): ChatMessage.ChatMessage => ({
    id: message.id,
    thread: message.thread,
    author: {
      id: message.authorId,
      name: message.isSelf ? "test-bot" : message.authorId,
      isBot: message.isBot,
      isSelf: message.isSelf
    },
    text: message.text,
    mentions: message.mentions,
    ...(message.replyTo === undefined ? {} : {
      replyTo: message.replyTo.authorId === undefined
        ? message.replyTo
        : { ...message.replyTo, isSelf: message.replyTo.authorId === selfId }
    }),
    attachments: message.attachments.map((stored) => stored.attachment),
    timestamp: message.timestamp,
    raw: {
      type: "message",
      id: message.id,
      channel: message.thread.id,
      user: message.authorId,
      text: message.text
    }
  })

  const findThread = (op: string, thread: ChatThread.ChatThread) =>
    Effect.suspend(() => {
      const stored = threads.get(thread.id)
      return stored === undefined ? fail(op, new NotFound({ detail: "thread_not_found" })) : Effect.succeed(stored)
    })

  const listMessages = (stored: StoredThread): Array<StoredMessage> => {
    const list: Array<StoredMessage> = []
    if (stored.openerId !== undefined) {
      const opener = messages.get(stored.openerId)
      if (opener !== undefined) list.push(opener)
    }
    for (const id of order) {
      const message = messages.get(id)
      if (message !== undefined && ChatThread.equals(message.thread, stored.thread)) list.push(message)
    }
    return list
  }

  const findMessage = (op: string, thread: ChatThread.ChatThread, messageId: string) =>
    Effect.flatMap(findThread(op, thread), (stored) => {
      const message = listMessages(stored).find((message) => message.id === messageId)
      return message === undefined
        ? fail(op, new NotFound({ detail: "message_not_found" }))
        : Effect.succeed(message)
    })

  const store = (message: Omit<StoredMessage, "id" | "timestamp">) =>
    Effect.map(DateTime.now, (timestamp) => {
      const stored: StoredMessage = { ...message, id: nextId("m"), timestamp }
      messages.set(stored.id, stored)
      order.push(stored.id)
      return stored
    })

  const storeFiles = (files: ReadonlyArray<File> | undefined) =>
    (files ?? []).map((file) => ({
      attachment: {
        id: nextId("f"),
        name: file.name,
        contentType: file.contentType,
        size: file.content.length
      },
      content: file.content
    }))

  /** Stores a message from the bot. The author `replyTo` names is read from the stored target. */
  const postOwn = Effect.fnUntraced(function*(op: string, thread: ChatThread.ChatThread, message: {
    readonly text: string
    readonly replyTo: ReplyTo | undefined
    readonly attachments: StoredMessage["attachments"]
    readonly actions: ReadonlyArray<ChatUi.Action>
  }) {
    const target = message.replyTo === undefined
      ? undefined
      : yield* findMessage(op, thread, message.replyTo.messageId)
    const stored = yield* store({
      ...message,
      thread,
      authorId: selfId,
      isBot: true,
      isSelf: true,
      mentions: [],
      replyTo: target === undefined ? undefined : { messageId: target.id, authorId: target.authorId }
    })
    return { id: stored.id, thread, timestamp: stored.timestamp } satisfies Posted
  })

  const createThread = (
    op: string,
    thread: ChatThread.ChatThread,
    messageId: string,
    name: string | undefined
  ) =>
    Effect.flatMap(findMessage(op, thread, messageId), (message) => {
      const existing = threadUnder.get(message.id)
      if (existing !== undefined) return Effect.succeed(existing)
      const parent = threads.get(message.thread.id)!
      if (parent.kind === "thread" || !ChatThread.equals(message.thread, thread)) {
        return fail(op, new InvalidRequest({ detail: "cannot_thread_reply" }))
      }
      return Effect.map(DateTime.now, (createdAt) => {
        const created = ChatThread.make(platform, thread.id + "/" + message.id)
        threads.set(created.id, {
          thread: created,
          kind: "thread",
          name,
          parent: thread,
          openerId: message.id,
          createdAt
        })
        threadUnder.set(message.id, created)
        return created
      })
    })

  /** The capabilities a message's elements need. */
  const actionNeeds = (actions: ReadonlyArray<ChatUi.Action> | undefined): Array<Capability> => {
    const needs: Array<Capability> = []
    if (actions?.some((action) => action._tag !== "Select")) needs.push("buttons")
    if (actions?.some((action) => action._tag === "Select")) needs.push("selects")
    return needs
  }

  /** The element limits, counted in code points, as both adapters count them. */
  const checkActions = (op: string, actions: ReadonlyArray<ChatUi.Action>) =>
    Effect.suspend(() => {
      const { actionDataLength, actionsPerMessage } = descriptor.limits
      if (actionsPerMessage !== undefined && actions.length > actionsPerMessage) {
        return fail(op, new TooLarge({ detail: "too_many_actions" }))
      }
      const data = actions.flatMap((action) =>
        action._tag === "Button"
          ? [codePoints(action.id) + codePoints(action.value ?? "")]
          : action._tag === "Select"
          ? action.options.map((option) => codePoints(action.id) + codePoints(option.value))
          : []
      )
      if (actionDataLength !== undefined && data.some((length) => length > actionDataLength)) {
        return fail(op, new TooLarge({ detail: "action_data_too_long" }))
      }
      return Effect.void
    })

  /** Why a modal would not open, if it would not. */
  const modalRefusal = (modal: ChatUi.Modal): ChatError | undefined => {
    const { modalFields, modalMetadataLength } = descriptor.limits
    if (!capabilities.has("modals")) return chatError("openModal", new Unsupported({ capability: "modals" }))
    if (
      modalMetadataLength !== undefined &&
      codePoints(modal.id) + codePoints(modal.metadata ?? "") > modalMetadataLength
    ) {
      return chatError("openModal", new TooLarge({ detail: "modal_metadata_too_long" }))
    }
    if (modalFields !== undefined && modal.elements.length > modalFields) {
      return chatError("openModal", new TooLarge({ detail: "too_many_fields" }))
    }
    return undefined
  }

  /** The capabilities a command's answer needs. */
  const answerNeeds = (
    visibility: ChatInteraction.Visibility,
    actions?: ReadonlyArray<ChatUi.Action> | undefined
  ): Array<Capability> => [...(visibility === "ephemeral" ? ["ephemeral" as const] : []), ...actionNeeds(actions)]

  /** The id the fake gave a command it built, which keys its deferral. */
  const commandKey = ({ raw }: ChatInteraction.CommandInvoked): string | undefined =>
    Predicate.hasProperty(raw, "id") && typeof raw.id === "string" ? raw.id : undefined

  const takeFault = (op: string): Fault | undefined => {
    const queue = faults.get(op)
    const fault = queue?.[0]
    if (fault === undefined) return undefined
    fault.remaining--
    if (fault.remaining <= 0) queue!.shift()
    return fault
  }

  const attempt = <A>(
    call: Omit<Call, "outcome">,
    needs: ReadonlyArray<Capability>,
    body: Effect.Effect<A, ChatError>,
    retries: boolean = true
  ): Effect.Effect<A, ChatError> =>
    (retries ? retrySafe : <X>(effect: X) => effect)(Effect.suspend(() => {
      const record = (outcome: Call["outcome"]) => calls.push({ ...call, outcome })
      const missing = needs.find((capability) => !descriptor.capabilities.has(capability))
      if (missing !== undefined) {
        record("Unsupported")
        return fail(call.op, new Unsupported({ capability: missing }))
      }
      if (call.op === "post" && (call.files?.length ?? 0) > 0 && refusedFiles > 0) {
        refusedFiles--
        record("Forbidden")
        return fail(call.op, new Forbidden({ detail: fileRefused }))
      }
      const fault = takeFault(call.op)
      if (fault !== undefined) {
        record(fault.reason._tag)
        const failure = fail(call.op, fault.reason)
        return fault.landed ? Effect.flatMap(Effect.exit(body), () => failure) : failure
      }
      return body.pipe(
        Effect.tap(() => Effect.sync(() => record("ok"))),
        Effect.tapError((error) => Effect.sync(() => record(error.reason._tag)))
      )
    }))

  /** Whether a native stream is open on the message, closing it once it is past `limits.streamAge`. */
  const isOpen = (messageId: string) =>
    Effect.map(Clock.currentTimeMillis, (now) => {
      const stream = streams.get(messageId)
      if (stream === undefined || !stream.open) return false
      const age = descriptor.limits.streamAge
      if (age !== undefined && now - stream.startedAt >= Duration.toMillis(age)) stream.open = false
      return stream.open
    })

  const streamLength = () => descriptor.limits.streamLength ?? descriptor.limits.messageLength

  const nativeStream: NativeStream = {
    start: (thread, content) =>
      attempt(
        { op: "nativeStream.start", thread, markdown: content.markdown },
        content.replyTo === undefined ? ["nativeStream"] : ["nativeStream", "replyTo"],
        Effect.gen(function*() {
          yield* findThread("nativeStream.start", thread)
          yield* checkMessageLength(descriptor, "nativeStream.start", content.markdown)
          if (descriptor.measure(content.markdown) > streamLength()) {
            return yield* fail("nativeStream.start", new TooLarge({ subject: "text", detail: "msg_too_long" }))
          }
          const posted = yield* postOwn("nativeStream.start", thread, {
            text: Str.toWellFormed(content.markdown),
            replyTo: content.replyTo,
            attachments: [],
            actions: []
          })
          streams.set(posted.id, { startedAt: yield* Clock.currentTimeMillis, open: true, clicked: false })
          return posted
        })
      ),
    append: (thread, messageId, markdown, appendOptions) =>
      attempt(
        { op: "nativeStream.append", thread, messageId, markdown },
        ["nativeStream"],
        Effect.gen(function*() {
          const message = yield* findMessage("nativeStream.append", thread, messageId)
          const stream = streams.get(message.id)
          if (stream === undefined || !(yield* isOpen(message.id))) {
            return { state: stream?.clicked === true ? "stopped" as const : "closed" as const, held: 0 }
          }
          let held = 0
          const flush = appendOptions?.flush === true
          const open = markdown.lastIndexOf("<")
          if (!flush && open !== -1 && !markdown.includes(">", open)) {
            held = markdown.length - open
            if (held > heldBound) held = 0
          }
          // A trailing high surrogate waits for its other half.
          if (!flush && held === 0 && /[\ud800-\udbff]$/.test(markdown)) held = 1
          const sent = Str.toWellFormed(markdown.slice(0, markdown.length - held))
          if (descriptor.measure(message.text + sent) > streamLength()) {
            return yield* fail("nativeStream.append", new TooLarge({ subject: "text", detail: "msg_too_long" }))
          }
          message.text += sent
          return { state: "open" as const, held }
        }),
        false
      ),
    stop: (thread, messageId) =>
      attempt(
        { op: "nativeStream.stop", thread, messageId },
        ["nativeStream"],
        Effect.gen(function*() {
          const message = yield* findMessage("nativeStream.stop", thread, messageId)
          const stream = streams.get(message.id)
          if (stream === undefined || !(yield* isOpen(message.id))) return { stopped: false }
          stream.open = false
          return { stopped: stream.clicked }
        })
      )
  }

  const streamFor = (op: string, messageId: string) =>
    Effect.suspend(() => {
      const stream = streams.get(messageId)
      return stream === undefined
        ? Effect.die(new Error("ChatTest." + op + ": no native stream " + messageId))
        : Effect.succeed(stream)
    })

  const adapter: ChatAdapter = {
    descriptor,
    ...(capabilities.has("nativeStream") ? { nativeStream } : {}),
    post: (thread, content) => {
      const files = content.files ?? []
      const needs: Array<Capability> = []
      if (files.length > 0) needs.push("files")
      if (content.replyTo !== undefined) needs.push("replyTo")
      needs.push(...actionNeeds(content.actions))
      return attempt(
        { op: "post", thread, markdown: content.markdown, files: content.files },
        needs,
        Effect.gen(function*() {
          yield* findThread("post", thread)
          yield* checkMessageLength(descriptor, "post", content.markdown, content.actions)
          yield* checkActions("post", content.actions ?? [])
          if (
            files.length > descriptor.limits.filesPerMessage ||
            files.some((file) => file.content.length > descriptor.limits.uploadBytes)
          ) {
            return yield* fail("post", new TooLarge({ subject: "files", detail: fileRefused }))
          }
          return yield* postOwn("post", thread, {
            text: content.markdown,
            replyTo: content.replyTo,
            attachments: storeFiles(files),
            actions: content.actions ?? []
          })
        })
      )
    },
    edit: (thread, messageId, content) =>
      attempt(
        { op: "edit", thread, messageId, markdown: content.markdown },
        ["edit", ...actionNeeds(content.actions)],
        Effect.gen(function*() {
          const message = yield* findMessage("edit", thread, messageId)
          if (!message.isSelf) return yield* fail("edit", new Forbidden({ detail: "cant_update_message" }))
          if (yield* isOpen(message.id)) {
            return yield* fail("edit", new InvalidRequest({ detail: "streaming_state_conflict" }))
          }
          yield* checkMessageLength(descriptor, "edit", content.markdown, content.actions)
          yield* checkActions("edit", content.actions ?? [])
          message.text = content.markdown
          message.mentions = []
          message.actions = content.actions ?? []
        })
      ),
    delete: (thread, messageId) =>
      attempt(
        { op: "delete", thread, messageId },
        ["delete"],
        Effect.gen(function*() {
          const message = yield* findMessage("delete", thread, messageId)
          if (!message.isSelf) return yield* fail("delete", new Forbidden({ detail: "cant_delete_message" }))
          if (yield* isOpen(message.id)) {
            return yield* fail("delete", new InvalidRequest({ detail: "cant_delete_message" }))
          }
          messages.delete(message.id)
        })
      ),
    fetchMessage: (thread, messageId) =>
      attempt(
        { op: "fetchMessage", thread, messageId },
        ["fetchMessage"],
        Effect.map(findMessage("fetchMessage", thread, messageId), toMessage)
      ),
    history: (thread, options) =>
      Stream.unwrap(attempt(
        { op: "history", thread, messageId: options.from },
        ["history"],
        Effect.gen(function*() {
          const stored = yield* findThread("history", thread)
          const list = listMessages(stored).map(toMessage)
          if (options.direction === "backward") list.reverse()
          if (options.from === undefined) return Stream.fromIterable(list)
          const index = list.findIndex((message) => message.id === options.from)
          if (index === -1) return yield* fail("history", new NotFound({ detail: "message_not_found" }))
          return Stream.fromIterable(list.slice(index + 1))
        })
      )),
    download: (thread, attachment, options) =>
      Stream.unwrap(attempt(
        { op: "download", thread },
        ["download"],
        Effect.suspend(() => {
          let content: Uint8Array | undefined
          for (const message of messages.values()) {
            const found = message.attachments.find((stored) => stored.attachment.id === attachment.id)
            if (found !== undefined) content = found.content
          }
          if (content === undefined) return fail("download", new NotFound({ detail: "file_not_found" }))
          const chunks: Array<Uint8Array> = []
          for (let offset = 0; offset < content.length && offset < options.maxBytes; offset += downloadChunkSize) {
            const end = Math.min(offset + downloadChunkSize, content.length)
            if (end > options.maxBytes) break
            chunks.push(content.slice(offset, end))
          }
          const tooLarge = content.length > options.maxBytes
            ? Stream.fail(chatError("download", new TooLarge({ detail: "max_bytes" })))
            : Stream.empty
          return Effect.succeed(Stream.concat(Stream.fromIterable(chunks), tooLarge))
        })
      )),
    startThread: (thread, messageId, startOptions) =>
      attempt(
        { op: "startThread", thread, messageId },
        ["startThread"],
        createThread("startThread", thread, messageId, startOptions?.name)
      ),
    getThread: (thread) =>
      attempt(
        { op: "getThread", thread },
        ["getThread"],
        Effect.map(findThread("getThread", thread), (stored) => ({
          thread: stored.thread,
          kind: stored.kind,
          name: stored.name,
          parent: stored.parent,
          createdAt: stored.createdAt,
          raw: { id: stored.thread.id, kind: stored.kind }
        }))
      ),
    opener: (thread) =>
      attempt(
        { op: "opener", thread },
        ["opener"],
        Effect.map(findThread("opener", thread), (stored) => {
          const opener = stored.openerId === undefined ? undefined : messages.get(stored.openerId)
          return opener === undefined ? Option.none() : Option.some(toMessage(opener))
        })
      ),
    getUser: (id, userOptions) =>
      attempt(
        { op: "getUser", thread: userOptions?.in ?? ChatThread.make(platform, "") },
        ["getUser"],
        Effect.suspend(() => {
          const user = users.get(id)
          return user === undefined
            ? fail("getUser", new NotFound({ detail: "user_not_found" }))
            : Effect.succeed({
              id,
              name: id === selfId ? "test-bot" : id,
              isBot: user.isBot,
              isSelf: id === selfId,
              raw: { id }
            })
        })
      ),
    followUp: (deferred, content) =>
      attempt(
        { op: "followUp", thread: deferred.command.thread, markdown: content.markdown },
        ["commands", ...answerNeeds(deferred.visibility, content.actions)],
        Effect.gen(function*() {
          const key = commandKey(deferred.command)
          const stored = key === undefined ? undefined : deferrals.get(key)
          const age = descriptor.limits.followUpAge
          const now = yield* Clock.currentTimeMillis
          if (
            stored === undefined || stored.used ||
            (age !== undefined && now - stored.at >= Duration.toMillis(age))
          ) {
            return yield* fail("followUp", new NotFound({ detail: interactionExpired }))
          }
          yield* checkMessageLength(descriptor, "followUp", content.markdown, content.actions)
          yield* checkActions("followUp", content.actions ?? [])
          stored.used = true
        }),
        false
      )
  }

  const addThread = (kind: "channel" | "direct") =>
    Effect.map(DateTime.now, (createdAt) => {
      const thread = ChatThread.make(platform, nextId(kind === "channel" ? "c" : "d"))
      threads.set(thread.id, { thread, kind, createdAt })
      return thread
    })

  const userPosts: ChatTest["Service"]["userPosts"] = Effect.fnUntraced(function*(thread, message) {
    const stored = threads.get(thread.id)
    if (stored === undefined) return yield* Effect.die(new Error("ChatTest.userPosts: unknown thread"))
    const authorId = message.authorId ?? "user"
    const isBot = message.isBot ?? false
    users.set(authorId, { isBot })
    const text = message.mentionsSelf === true ? "<@" + selfId + "> " + message.text : message.text
    const replyTarget = message.replyTo === undefined ? undefined : messages.get(message.replyTo.messageId)
    const created = yield* store({
      thread,
      authorId,
      isBot,
      isSelf: false,
      text,
      mentions: parseMentions(text, selfId),
      // The author is read from the stored message, as a platform does, not from the caller.
      replyTo: message.replyTo === undefined ? undefined : {
        messageId: message.replyTo.messageId,
        ...(replyTarget === undefined ? {} : { authorId: replyTarget.authorId })
      },
      attachments: storeFiles(message.files),
      actions: []
    })
    return ChatEvent.MessageCreated.make({
      thread,
      kind: stored.kind,
      message: toMessage(created),
      raw: { type: "event_callback", event_id: nextId("e") }
    })
  })

  const service = ChatTest.of({
    platform,
    selfId,
    makeThread: (kind = "channel") => {
      if (kind !== "thread") return addThread(kind)
      return Effect.gen(function*() {
        const channel = yield* addThread("channel")
        const event = yield* userPosts(channel, { text: "thread opener" })
        const message = (event as ChatEvent.MessageCreated).message
        return yield* Effect.orDie(createThread("makeThread", channel, message.id, undefined))
      })
    },
    userPosts,
    deliver: (event) => Effect.flatMap(ChatHandler, (handler) => handler.handle(event)),
    messages: (thread) =>
      Effect.sync(() => {
        const stored = threads.get(thread.id)
        return stored === undefined ? [] : listMessages(stored).map(toMessage)
      }),
    calls: Effect.sync(() => calls.slice()),
    refuseFiles: (options) =>
      Effect.sync(() => {
        refusedFiles += options?.times ?? 1
      }),
    failNext: (op, reason, failOptions) =>
      Effect.sync(() => {
        if (failOptions?.times === 0) return
        const queue = faults.get(op) ?? []
        queue.push({ reason, remaining: failOptions?.times ?? 1, landed: failOptions?.landed ?? false })
        faults.set(op, queue)
      }),
    clickStop: (messageId) => Effect.map(streamFor("clickStop", messageId), (stream) => void (stream.clicked = true)),
    closeStream: (messageId) => Effect.map(streamFor("closeStream", messageId), (stream) => void (stream.open = false)),
    click: (messageId, id, clickOptions) =>
      Effect.suspend((): Effect.Effect<
        ChatInteraction.ButtonClicked | ChatInteraction.SelectChanged,
        NoSuchElement
      > => {
        const message = messages.get(messageId)
        const element = message?.actions.find((action) => action._tag !== "LinkButton" && action.id === id)
        if (message === undefined || element === undefined || element._tag === "LinkButton") {
          return Effect.fail(new NoSuchElement({ messageId, id }))
        }
        const origin = {
          id,
          thread: message.thread,
          messageId,
          userId: clickOptions?.userId ?? "user",
          raw: { type: "interaction", id: nextId("i"), message: messageId, element: id }
        }
        if (element._tag === "Button") {
          return Effect.succeed(ChatInteraction.ButtonClicked.make({
            ...origin,
            ...(element.value === undefined ? {} : { value: element.value })
          }))
        }
        const option = clickOptions?.option === undefined
          ? element.options[0]
          : element.options.find((option) => option.value === clickOptions.option)
        return option === undefined
          ? Effect.fail(new NoSuchElement({ messageId, id }))
          : Effect.succeed(ChatInteraction.SelectChanged.make({ ...origin, value: option.value }))
      }),
    command: (thread, id, commandOptions) =>
      Effect.sync(() => {
        const text = commandOptions?.text ?? ""
        return ChatInteraction.CommandInvoked.make({
          id,
          text,
          thread,
          userId: commandOptions?.userId ?? "user",
          raw: { type: "command", id: nextId("i"), command: id, text }
        })
      }),
    submit: (from, opened, values, submitOptions) =>
      Effect.sync(() =>
        ChatInteraction.ModalSubmitted.make({
          id: opened.modal.id,
          ...(opened.modal.metadata === undefined ? {} : { metadata: opened.modal.metadata }),
          values: Object.fromEntries(Object.entries(values).filter(([, value]) => value !== "")),
          thread: from.thread,
          ...(from._tag === "CommandInvoked" ? {} : { messageId: from.messageId }),
          userId: submitOptions?.userId ?? from.userId,
          raw: { type: "submission", id: nextId("i"), modal: opened.modal.id }
        })
      ),
    interact: ((event: ChatInteraction.Interaction) =>
      Effect.gen(function*() {
        const reply = yield* ChatInteraction.handle(event, options.interactionDeadline)
        if (event._tag === "ModalSubmitted") return reply
        let refusal: ChatError | undefined
        switch (reply._tag) {
          case "OpenModal": {
            refusal = modalRefusal(reply.modal)
            calls.push({
              op: "openModal",
              thread: event.thread,
              ...(event._tag === "CommandInvoked" ? {} : { messageId: event.messageId }),
              outcome: refusal === undefined ? "ok" : refusal.reason._tag
            })
            break
          }
          case "Respond": {
            const exit = yield* Effect.exit(attempt(
              { op: "respond", thread: event.thread, markdown: reply.markdown },
              answerNeeds(reply.visibility, reply.actions),
              Effect.andThen(
                checkMessageLength(descriptor, "respond", reply.markdown, reply.actions),
                checkActions("respond", reply.actions ?? [])
              ),
              false
            ))
            refusal = Option.getOrUndefined(Exit.findErrorOption(exit))
            break
          }
          case "Defer": {
            const missing = answerNeeds(reply.visibility).find((capability) => !capabilities.has(capability))
            if (missing !== undefined) {
              refusal = chatError("defer", new Unsupported({ capability: missing }))
              break
            }
            const key = event._tag === "CommandInvoked" ? commandKey(event) : undefined
            if (key !== undefined) deferrals.set(key, { at: yield* Clock.currentTimeMillis, used: false })
            break
          }
        }
        if (refusal !== undefined) {
          const handler = yield* ChatInteraction.Handler
          yield* handler.refused(event, refusal)
        }
        return reply
      })) as ChatTest["Service"]["interact"]
  })

  return { adapter, service }
}

/**
 * Creates a whole chat in memory: `Chat`, its registry and one fake adapter.
 *
 * **When to use**
 *
 * Use to test code that posts and reads through `Chat`, and to run the
 * conformance suite against the fake adapter.
 *
 * **Details**
 *
 * - The platform defaults to `test` and the bot's user id to `bot`.
 * - Every capability is on by default.
 * - `measure` defaults to a count of code points, and the fake checks every
 *   length with it.
 * - The default limits are 4000 per message, 10 files of up to 10 MiB, and no
 *   write interval. With `nativeStream` on, a stream takes up to
 *   `messageLength` and lasts 10 minutes.
 * - The native stream behaves the way Slack's was found to. An append past
 *   `limits.streamLength` fails with `TooLarge` and adds nothing. A stream
 *   past `limits.streamAge`, on `Clock`, is closed. An append without
 *   `flush` holds back an unclosed `<` tail of up to 100 characters, or a
 *   trailing high surrogate. Any other lone surrogate is stored as U+FFFD.
 *   An open stream refuses `edit` and `delete`.
 * - With `buttons` or `selects` on, a message takes 25 elements, and an
 *   element's id plus encoded value 100 code points. With `modals` on, a
 *   modal's id plus encoded metadata takes 100 code points, and a modal 5
 *   fields. Each limit is there only with its capability.
 * - `interact` gives a handler 3 seconds by default, on `Clock`.
 * - With `commands` on, `limits.followUpAge` is 15 minutes.
 * - Two layers merged with different platforms share one `Chat`, so routing
 *   can be tested. The `ChatTest` service in context is the last one merged.
 *
 * @stability unstable
 * @category layers
 * @since 4.1.5
 */
export const layer = (options?: {
  readonly platform?: string | undefined
  readonly selfId?: string | undefined
  readonly capabilities?: ReadonlyArray<Capability> | undefined
  readonly limits?: Partial<Descriptor["limits"]> | undefined
  readonly measure?: Descriptor["measure"] | undefined
  readonly interactionDeadline?: Duration.Duration | undefined
}): Layer.Layer<Chat.Chat | Registry | ChatTest> =>
  Layer.effect(
    ChatTest,
    Effect.gen(function*() {
      const registry = yield* Registry
      const { adapter, service } = makeFake({
        platform: options?.platform ?? "test",
        selfId: options?.selfId ?? "bot",
        capabilities: options?.capabilities ?? allCapabilities,
        limits: options?.limits ?? {},
        measure: options?.measure ?? codePoints,
        interactionDeadline: options?.interactionDeadline ?? Duration.seconds(3)
      })
      yield* registry.register(adapter)
      return service
    })
  ).pipe(Layer.provideMerge(Chat.layer))

// -----------------------------------------------------------------------------
// invariants
// -----------------------------------------------------------------------------

/**
 * Error for a conformance rule or invariant that did not hold.
 *
 * **Details**
 *
 * `rule` names what failed, and `expected` and `actual` say how. A platform
 * error behind the failure is in `cause`.
 *
 * @stability unstable
 * @category errors
 * @since 4.1.5
 */
export class ConformanceFailure extends Schema.TaggedError<ConformanceFailure>(
  "effect/chat/ChatTest/ConformanceFailure"
)("ConformanceFailure", {
  rule: Schema.String,
  expected: Schema.String,
  actual: Schema.String,
  cause: Schema.optionalKey(Schema.Defect())
}) {
  override get message(): string {
    return this.rule + ": expected " + this.expected + ", got " + this.actual
  }
}

const sameMentions = (a: ReadonlyArray<Mention>, b: ReadonlyArray<Mention>): boolean =>
  a.length === b.length &&
  a.every((mention, i) => {
    const other = b[i]
    return mention.kind === other.kind && mention.id === other.id && mention.start === other.start &&
      mention.end === other.end && mention.isSelf === other.isSelf
  })

const sameReplyTo = (a: ReplyTo | undefined, b: ReplyTo | undefined): boolean =>
  a === undefined || b === undefined
    ? a === b
    : a.messageId === b.messageId && a.authorId === b.authorId && a.isSelf === b.isSelf

/**
 * Returns whether two reads of a message are the same message.
 *
 * **Details**
 *
 * It compares `id`, `thread`, `author.id`, `author.isBot`, `author.isSelf`,
 * `text`, `mentions`, `replyTo`, `timestamp` and the attachment ids in order.
 * `raw`, `author.name` and the optional attachment fields are left out.
 *
 * @stability unstable
 * @category comparisons
 * @since 4.1.5
 */
export const sameMessage = (a: ChatMessage.ChatMessage, b: ChatMessage.ChatMessage): boolean =>
  a.id === b.id &&
  ChatThread.equals(a.thread, b.thread) &&
  a.author.id === b.author.id &&
  a.author.isBot === b.author.isBot &&
  a.author.isSelf === b.author.isSelf &&
  a.text === b.text &&
  sameMentions(a.mentions, b.mentions) &&
  sameReplyTo(a.replyTo, b.replyTo) &&
  DateTime.Equivalence(a.timestamp, b.timestamp) &&
  a.attachments.length === b.attachments.length &&
  a.attachments.every((attachment, i) => attachment.id === b.attachments[i].id)

const canonicalJson = (value: unknown): string =>
  JSON.stringify(value, (_, v) =>
    Predicate.isObject(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : v)

const failure = (rule: string, expected: string, actual: string, cause?: unknown) =>
  new ConformanceFailure({ rule, expected, actual, ...(cause === undefined ? {} : { cause }) })

const check = (rule: string, condition: boolean, expected: string, actual: () => string) =>
  condition ? Effect.void : Effect.fail(failure(rule, expected, actual()))

const MessageJson = Schema.toCodecJson(ChatMessage.ChatMessage)
const EventJson = Schema.toCodecJson(ChatEvent.ChatEvent)

const roundTrip = <S extends Schema.Codec<any, Schema.Json>>(rule: string, codec: S, value: S["Type"]) =>
  Effect.gen(function*() {
    const encoded = yield* Schema.encodeEffect(codec)(value)
    const decoded = yield* Schema.decodeEffect(codec)(encoded)
    const again = yield* Schema.encodeEffect(codec)(decoded)
    yield* check(
      rule,
      canonicalJson(encoded) === canonicalJson(again),
      "an unchanged value after encoding and decoding",
      () => canonicalJson(again)
    )
    return decoded as S["Type"]
  }).pipe(
    Effect.catchTag(
      "SchemaError",
      (error) => Effect.fail(failure(rule, "a value that encodes and decodes", "SchemaError", error))
    )
  )

const checkThread = Effect.fnUntraced(function*(rule: string, thread: ChatThread.ChatThread, platform: string) {
  yield* check(rule, thread.platform === platform, "platform " + platform, () => "platform " + thread.platform)
  const decoded = ChatThread.fromString(ChatThread.toString(thread))
  yield* check(
    rule,
    Option.isSome(decoded) && ChatThread.equals(decoded.value, thread),
    "a thread that survives its string codec",
    () => ChatThread.toString(thread)
  )
})

const checkMessageWith = Effect.fnUntraced(function*(rule: string, message: ChatMessage.ChatMessage, options: {
  readonly platform: string
  readonly parseMention: ParseMention
}) {
  yield* checkThread(rule, message.thread, options.platform)
  const mentions = [...message.mentions].sort((a, b) => a.start - b.start)
  let end = 0
  for (const mention of mentions) {
    yield* check(
      rule,
      mention.start >= end && mention.start < mention.end && mention.end <= message.text.length,
      "mentions inside text without overlap",
      () => "mention at " + mention.start + "-" + mention.end
    )
    end = mention.end
    const parsed = options.parseMention(message.text.slice(mention.start, mention.end))
    yield* check(
      rule,
      Option.isSome(parsed) && parsed.value.kind === mention.kind && parsed.value.id === mention.id,
      "a " + mention.kind + " mention token at " + mention.start + "-" + mention.end,
      () => Option.isSome(parsed) ? "a " + parsed.value.kind + " token" : "no mention token"
    )
  }
  for (const attachment of message.attachments) {
    yield* check(
      rule,
      attachment.id.length > 0 && !("url" in attachment) && !/^[a-z]+:\/\//i.test(attachment.id),
      "an attachment with an id and no URL",
      () => "attachment " + (attachment.id.length > 0 ? "with a URL" : "without an id")
    )
  }
  if (message.replyTo !== undefined) {
    const { authorId, isSelf } = message.replyTo
    yield* check(
      rule,
      (authorId === undefined) === (isSelf === undefined),
      "replyTo.isSelf set exactly when replyTo.authorId is",
      () => "authorId " + authorId + ", isSelf " + isSelf
    )
  }
  const decoded = yield* roundTrip(rule, MessageJson, message)
  yield* check(rule, sameMessage(message, decoded), "the same message after decoding", () => "a different message")
})

/**
 * Checks the invariants every message holds, for fixture tests and live runs.
 *
 * **Details**
 *
 * - Every mention sits inside `text`, mentions do not overlap, and each slice
 *   parses with `parseMention` as a token of the mention's kind and id.
 * - `thread.platform` is the platform, and the thread survives its string
 *   codec.
 * - The message encodes and decodes through its Schema unchanged, `raw`
 *   included.
 * - Every attachment has an id and no URL.
 * - `replyTo.isSelf` is set exactly when `replyTo.authorId` is.
 *
 * @stability unstable
 * @category testing
 * @since 4.1.5
 */
export const checkMessage = (message: ChatMessage.ChatMessage, options: {
  readonly platform: string
  readonly parseMention: ParseMention
}): Effect.Effect<void, ConformanceFailure> => checkMessageWith("checkMessage", message, options)

/**
 * Checks the invariants every event holds, for fixture tests and live runs.
 *
 * **Details**
 *
 * - A message event's message passes `checkMessage`, and the event's thread is
 *   the message's.
 * - `thread.platform` is the platform, and the thread survives its string
 *   codec.
 * - The event encodes and decodes through its Schema unchanged, `raw`
 *   included, and two decodes have the same `dedupeKey`.
 * - A reaction's `dedupeKey` differs between added and removed.
 *
 * @stability unstable
 * @category testing
 * @since 4.1.5
 */
export const checkEvent = (event: ChatEvent.ChatEvent, options: {
  readonly platform: string
  readonly parseMention: ParseMention
}): Effect.Effect<void, ConformanceFailure> =>
  Effect.gen(function*() {
    const rule = "checkEvent"
    yield* checkThread(rule, event.thread, options.platform)
    if (event._tag === "MessageCreated") {
      yield* checkMessageWith(rule, event.message, options)
      yield* check(
        rule,
        ChatThread.equals(event.thread, event.message.thread),
        "the event's thread equal to the message's",
        () => ChatThread.toString(event.thread)
      )
    } else if (event._tag !== "StopRequested") {
      const { _tag, ...fields } = event
      const flipped = _tag === "ReactionAdded"
        ? ChatEvent.ReactionRemoved.make(fields)
        : ChatEvent.ReactionAdded.make(fields)
      yield* check(
        rule,
        ChatEvent.dedupeKey(flipped) !== ChatEvent.dedupeKey(event),
        "different keys for an added and a removed reaction",
        () => ChatEvent.dedupeKey(event)
      )
    }
    const first = yield* roundTrip(rule, EventJson, event)
    const second = yield* roundTrip(rule, EventJson, event)
    const key = ChatEvent.dedupeKey(event)
    yield* check(
      rule,
      ChatEvent.dedupeKey(first) === key && ChatEvent.dedupeKey(second) === key,
      "the same dedupeKey for every decode",
      () => ChatEvent.dedupeKey(first) + " and " + ChatEvent.dedupeKey(second)
    )
  })

const InteractionJson = Schema.toCodecJson(ChatInteraction.Interaction)

/**
 * Checks the invariants every interaction holds, for a click, a submit or a
 * command from a fixture.
 *
 * **Details**
 *
 * - `thread.platform` is the platform, and the thread survives its string
 *   codec.
 * - The interaction encodes and decodes through its Schema unchanged, `raw`
 *   included.
 * - A `ModalSubmitted`'s `messageId` is non-empty when it is there. A modal
 *   a command opened has none.
 * - A `CommandInvoked` has a non-empty `id`.
 *
 * It takes no `parseMention` and checks no dedupe key, since an interaction
 * carries neither.
 *
 * @stability unstable
 * @category testing
 * @since 4.1.5
 */
export const checkInteraction = (interaction: ChatInteraction.Interaction, options: {
  readonly platform: string
}): Effect.Effect<void, ConformanceFailure> =>
  Effect.gen(function*() {
    const rule = "checkInteraction"
    yield* checkThread(rule, interaction.thread, options.platform)
    if (interaction._tag === "ModalSubmitted") {
      yield* check(rule, interaction.messageId !== "", "a submit with no messageId or a non-empty one", () =>
        "an empty messageId")
    }
    if (interaction._tag === "CommandInvoked") {
      yield* check(rule, interaction.id !== "", "a command with a non-empty id", () =>
        "an empty id")
    }
    yield* roundTrip(rule, InteractionJson, interaction)
  })

// -----------------------------------------------------------------------------
// conformance
// -----------------------------------------------------------------------------

/**
 * The click hook of `conformance`: a way to click, for the adapter under
 * test.
 *
 * **Details**
 *
 * - `click` clicks the element `id` on a message the suite posted, through
 *   the adapter's real entry, and fails `NoSuchElement` when the message
 *   carries no such element. `option` is as in `ChatTest.click`.
 * - `submit` submits the modal the last click or command opened, and
 *   submits it again after an `errors` reply. It does nothing when no modal
 *   is open: the rule then fails on the submit its handler never saw.
 * - `command` sends a command typed at `thread` through the adapter's real
 *   entry. The command rules exist only when it is given. It is optional, so
 *   a hook written before commands still fits.
 * - All three need `ChatInteraction.Handler` and nothing else. The suite
 *   provides its own recording handler, so the entry must take its handler
 *   at the call, not at layer build.
 *
 * @stability unstable
 * @category testing
 * @since 4.1.5
 */
export interface Interactions {
  readonly click: (messageId: string, id: string, options?: {
    readonly option?: string | undefined
  }) => Effect.Effect<void, NoSuchElement, ChatInteraction.Handler>
  readonly submit: (
    values: Readonly<Record<string, string>>
  ) => Effect.Effect<void, never, ChatInteraction.Handler>
  readonly command?:
    | ((thread: ChatThread.ChatThread, id: string, options?: {
      readonly text?: string | undefined
    }) => Effect.Effect<void, never, ChatInteraction.Handler>)
    | undefined
}

/** What the suite's own `ChatInteraction.Handler` received, and how it answers. */
class Recording {
  readonly clicks: Array<ChatInteraction.ButtonClicked | ChatInteraction.SelectChanged> = []
  readonly submits: Array<ChatInteraction.ModalSubmitted> = []
  readonly commands: Array<ChatInteraction.CommandInvoked> = []
  readonly commandReplies: Array<ChatInteraction.CommandReply> = []
  readonly refused: Array<ChatError> = []
  onClick: (event: ChatInteraction.ButtonClicked | ChatInteraction.SelectChanged) => ChatInteraction.ClickReply = () =>
    ChatInteraction.ack
  onSubmit: (event: ChatInteraction.ModalSubmitted) => ChatInteraction.SubmitReply = () => ChatInteraction.close
  onCommand: (event: ChatInteraction.CommandInvoked) => ChatInteraction.CommandReply = (event) =>
    ChatInteraction.respond({ markdown: conformanceText(event.id), visibility: "public" })
  readonly handler = ChatInteraction.Handler.of({
    click: (event) =>
      Effect.sync(() => {
        this.clicks.push(event)
        return this.onClick(event)
      }),
    submit: (event) =>
      Effect.sync(() => {
        this.submits.push(event)
        return this.onSubmit(event)
      }),
    command: (event) =>
      Effect.sync(() => {
        this.commands.push(event)
        const reply = this.onCommand(event)
        this.commandReplies.push(reply)
        return reply
      }),
    refused: (_, error) => Effect.sync(() => void this.refused.push(error))
  })
}

const conformanceButton = (rule: string): ChatUi.Button => ({ _tag: "Button", id: "conformance", label: rule })

const conformanceSelect = (rule: string): ChatUi.Select => ({
  _tag: "Select",
  id: "conformance",
  placeholder: rule,
  options: [{ label: "a", value: "a" }, { label: "b", value: "b" }]
})

const describeExit = (exit: Exit.Exit<unknown, unknown>): string => {
  if (Exit.isSuccess(exit)) return "success"
  const error = Exit.findErrorOption(exit)
  if (Option.isNone(error)) return "a defect or interruption"
  return describeError(error.value)
}

const describeError = (error: unknown): string => {
  if (!isChatError(error)) return String(error)
  return error.reason._tag === "Unsupported"
    ? "Unsupported(" + error.reason.capability + ")"
    : error.reason._tag
}

const conformanceText = (rule: string) => "conformance " + rule

class Tester {
  readonly created: Array<{ readonly thread: ChatThread.ChatThread; readonly id: string }> = []
  readonly rule: string
  readonly chat: Chat.Chat["Service"]
  readonly descriptor: Descriptor
  readonly options: ConformanceOptions
  constructor(rule: string, chat: Chat.Chat["Service"], descriptor: Descriptor, options: ConformanceOptions) {
    this.rule = rule
    this.chat = chat
    this.descriptor = descriptor
    this.options = options
  }

  get thread() {
    return this.options.thread
  }

  readonly recording = new Recording()

  /** Runs an interaction hook with the suite's recording handler. */
  recorded<A, E>(effect: Effect.Effect<A, E, ChatInteraction.Handler>): Effect.Effect<A, E> {
    return Effect.provideService(effect, ChatInteraction.Handler, this.recording.handler)
  }

  /** Clicks through the hook, with the suite's recording handler. */
  clickExit(messageId: string, id: string, options?: { readonly option?: string | undefined }) {
    return Effect.exit(this.recorded(this.options.interactions!.click(messageId, id, options)))
  }

  click(messageId: string, id: string, options?: { readonly option?: string | undefined }) {
    return Effect.flatMap(
      this.clickExit(messageId, id, options),
      (exit) =>
        Exit.isSuccess(exit) ? Effect.void : Effect.fail(failure(
          this.rule,
          "a click on element " + id + " of message " + messageId,
          describeExit(exit),
          Option.getOrUndefined(Exit.findErrorOption(exit))
        ))
    )
  }

  /** Sends a command through the hook, with the suite's recording handler. */
  command(id: string, options?: { readonly text?: string | undefined }) {
    return this.recorded(this.options.interactions!.command!(this.thread, id, options))
  }

  submit(values: Readonly<Record<string, string>>) {
    return this.recorded(this.options.interactions!.submit(values))
  }

  /** Checks a received interaction with `checkInteraction`, under this rule's name. */
  checkInteraction(interaction: ChatInteraction.Interaction) {
    return Effect.mapError(
      checkInteraction(interaction, { platform: this.options.platform }),
      (error) => failure(this.rule, error.expected, error.actual, error.cause)
    )
  }

  /** A click whose handler answers with `modal`, and what the adapter did with it. */
  openModal(modal: ChatInteraction.OpenModal) {
    return Effect.gen({ self: this }, function*() {
      // A modal opens from a click, on a select when there are no buttons.
      const element = this.has("buttons") || !this.has("selects")
        ? conformanceButton(this.rule)
        : conformanceSelect(this.rule)
      const posted = yield* this.post({ actions: [element] })
      this.recording.onClick = () => modal
      yield* this.click(posted.id, "conformance")
      return posted
    })
  }

  has(capability: Capability) {
    return this.descriptor.capabilities.has(capability)
  }

  call<A>(effect: Effect.Effect<A, ChatError>): Effect.Effect<A, ConformanceFailure> {
    return Effect.mapError(effect, (error) => {
      const listed = error.reason._tag === "Unsupported" && this.has(error.reason.capability)
      return failure(
        this.rule,
        "success",
        describeError(error) + (listed ? " for a listed capability" : ""),
        error
      )
    })
  }

  collect<A>(stream: Stream.Stream<A, ChatError>): Effect.Effect<Array<A>, ConformanceFailure> {
    return this.call(Stream.runCollect(stream))
  }

  check(condition: boolean, expected: string, actual: () => string) {
    return check(this.rule, condition, expected, actual)
  }

  /** Marks a message the rule posted in its thread for cleanup. */
  track(posted: Posted) {
    this.created.push({ thread: this.thread, id: posted.id })
  }

  post(
    content: {
      readonly markdown?: string
      readonly replyTo?: ReplyTo
      readonly files?: ReadonlyArray<File>
      readonly actions?: ReadonlyArray<ChatUi.Action>
    },
    thread = this.thread
  ) {
    return Effect.tap(
      this.call(this.chat.post(thread, { markdown: conformanceText(this.rule), ...content })),
      (posted) => Effect.sync(() => this.created.push({ thread, id: posted.id }))
    )
  }

  userPosts(thread = this.thread) {
    return Effect.flatMap(
      this.options.userPosts(thread, conformanceText(this.rule)),
      (event) =>
        event._tag === "MessageCreated"
          ? Effect.succeed(event)
          : Effect.fail(failure(this.rule, "a MessageCreated event from userPosts", event._tag))
    )
  }

  expectReason<A>(
    tag: ChatErrorReason["_tag"],
    effect: Effect.Effect<A, ChatError>,
    onSuccess?: (a: A) => void,
    refine?: { readonly expected: string; readonly test: (reason: ChatErrorReason) => boolean }
  ): Effect.Effect<void, ConformanceFailure> {
    return Effect.flatMap(Effect.exit(effect), (exit) => {
      if (Exit.isSuccess(exit)) onSuccess?.(exit.value)
      const error = Exit.findErrorOption(exit)
      const matches = Option.isSome(error) && isChatError(error.value) && error.value.reason._tag === tag &&
        (refine === undefined || refine.test(error.value.reason))
      return matches ? Effect.void : Effect.fail(failure(
        this.rule,
        refine === undefined ? tag : refine.expected,
        describeExit(exit),
        Option.getOrUndefined(error)
      ))
    })
  }

  /**
   * Calls the op behind `capability`. When the descriptor lacks it, the op
   * must fail with `Unsupported` naming it. When it is listed, the op must
   * not fail with `Unsupported` at all, whichever capability that names, so a
   * descriptor that lies in either direction fails.
   */
  probe(capability: Capability): Effect.Effect<void, ConformanceFailure, Registry> {
    const listed = this.has(capability)
    const expected = listed ? "no Unsupported for listed " + capability : "Unsupported(" + capability + ")"
    const expect = <A>(effect: Effect.Effect<A, ChatError>, onSuccess?: (a: A) => void) =>
      Effect.flatMap(Effect.exit(effect), (exit) => {
        if (Exit.isSuccess(exit)) onSuccess?.(exit.value)
        const error = Exit.findErrorOption(exit)
        const reason = Option.isSome(error) && isChatError(error.value) ? error.value.reason : undefined
        const holds = listed
          ? Exit.isSuccess(exit) || (reason !== undefined && reason._tag !== "Unsupported")
          : reason?._tag === "Unsupported" && reason.capability === capability
        return holds ? Effect.void : Effect.fail(failure(
          this.rule,
          expected,
          describeExit(exit),
          Option.getOrUndefined(error)
        ))
      })
    const track = (posted: Posted) => this.track(posted)
    /** Whether the suite's handler was refused `Unsupported` exactly when the capability is not listed. */
    const checkRefusal = Effect.suspend(() => {
      const { refused } = this.recording
      const refusal = refused.find((error) => error.reason._tag === "Unsupported")
      return this.check(
        listed
          ? refusal === undefined
          : refusal?.reason._tag === "Unsupported" && refusal.reason.capability === capability,
        listed ? "no refusal Unsupported for listed " + capability : "a refusal Unsupported(" + capability + ")",
        () => refused.length === 0 ? "no refusal" : refused.map(describeError).join(", ")
      )
    })
    const { chat, thread } = this
    const text = conformanceText(this.rule)
    switch (capability) {
      case "edit":
        return Effect.flatMap(this.post({}), (posted) => expect(chat.edit(thread, posted.id, { markdown: text })))
      case "delete":
        return Effect.flatMap(this.post({}), (posted) => expect(chat.delete(thread, posted.id)))
      case "fetchMessage":
        return Effect.flatMap(this.post({}), (posted) => expect(chat.fetchMessage(thread, posted.id)))
      case "history":
        return expect(Stream.runDrain(Stream.take(chat.history(thread, { direction: "backward" }), 1)))
      case "download":
        return expect(Stream.runDrain(chat.download(thread, { id: "conformance-missing" }, { maxBytes: 1 })))
      case "files":
        return expect(chat.post(thread, { markdown: text, files: [conformanceFile(this.rule)] }), track)
      case "replyTo":
        return Effect.flatMap(
          this.post({}),
          (target) => expect(chat.post(thread, { markdown: text, replyTo: { messageId: target.id } }), track)
        )
      case "startThread":
        return Effect.flatMap(this.post({}), (posted) => expect(chat.startThread(thread, posted.id)))
      case "getThread":
        return expect(chat.getThread(thread))
      case "opener":
        return expect(chat.opener(thread))
      case "getUser":
        return Effect.flatMap(
          this.userPosts(),
          (event) => expect(chat.getUser(this.options.platform, event.message.author.id))
        )
      case "buttons":
        return expect(chat.post(thread, { markdown: text, actions: [conformanceButton(this.rule)] }), track)
      case "selects":
        return expect(chat.post(thread, { markdown: text, actions: [conformanceSelect(this.rule)] }), track)
      case "modals":
        // Probing a modal requires the interaction hook and a clickable element.
        return this.options.interactions === undefined || !(this.has("buttons") || this.has("selects"))
          ? Effect.void
          : Effect.andThen(this.openModal(probeModal.open()), checkRefusal)
      case "modalErrors":
        // Its absence means a degraded answer, not a refusal, so it has no inverse.
        return Effect.void
      case "commands":
        // A deferral built by hand, which no adapter can follow up: it must fail, and not with Unsupported when listed.
        return expect(chat.followUp(
          ChatInteraction.defer(
            ChatInteraction.CommandInvoked.make({
              id: "conformance",
              text: "",
              thread,
              userId: "conformance",
              raw: {}
            }),
            { visibility: "public" }
          ),
          { markdown: text }
        ))
      case "ephemeral":
        // Probing a private answer requires the command hook.
        return this.options.interactions?.command === undefined
          ? Effect.void
          : Effect.suspend(() => {
            this.recording.onCommand = () => ChatInteraction.respond({ markdown: text })
            return Effect.andThen(this.command("conformance"), checkRefusal)
          })
      case "nativeStream":
        return Effect.flatMap(
          Registry,
          (registry) =>
            Effect.flatMap(this.call(registry.get(this.options.platform)), (adapter) =>
              this.check(
                (adapter.nativeStream !== undefined) === listed,
                listed ? "a nativeStream, as the descriptor lists it" : "no nativeStream, as the descriptor lacks it",
                () => adapter.nativeStream === undefined ? "no nativeStream" : "a nativeStream"
              ))
        )
    }
  }

  get cleanup(): Effect.Effect<void> {
    return Effect.suspend(() => {
      if (!this.has("delete")) return Effect.void
      const created = this.created.splice(0).reverse()
      return Effect.forEach(created, ({ id, thread }) => Effect.ignore(this.chat.delete(thread, id)), {
        discard: true
      })
    })
  }
}

const conformanceFile = (rule: string): File => ({
  name: "conformance.txt",
  contentType: "text/plain",
  content: new TextEncoder().encode(conformanceText(rule) + " " + "x".repeat(64))
})

const findIn = (messages: ReadonlyArray<ChatMessage.ChatMessage>, id: string) =>
  messages.find((message) => message.id === id)

/** A refusal of the text must not blame the files, or `ChatMarkdown` would post again without them. */
const textTooLarge = {
  expected: "TooLarge without subject files or detail file_refused",
  test: (reason: ChatErrorReason) =>
    reason._tag === "TooLarge" && reason.subject !== "files" && reason.detail !== fileRefused
}

const mentionLike = "@everyone @here <@U0000> <!here> <!channel> <@&1> <#C0000>"

/** Text a platform takes in any quantity: no emoji, which Slack limits separately. */
const measureFitsBlock = "a < b & c > d\n\n```ts\nconst x = 1 < 2\n```\n\n\u{1D400}\u{1D401} caf\u00e9\n\n"

const measureSamples: ReadonlyArray<string> = [
  "",
  "x",
  "hello world",
  "<",
  "a < b",
  "<@U0000>",
  "&amp; > &",
  "```\ncode < 1\n```\n",
  "```",
  "\u{1D400}\u{1D401}",
  "\u{1F600}\u{1F44D}\u{1F3FD}",
  ":grinning:",
  "caf\u00e9"
]

const probeModal = ChatInteraction.modal("conformance-modal", {
  title: "Conformance",
  fields: { answer: ChatInteraction.textInput({ label: "Answer" }) }
})

/** The fixed schemas of `actions/valueRoundTrips`, each with the value posted. */
const valueCases: ReadonlyArray<{ readonly schema: ChatInteraction.ValueSchema; readonly value: unknown }> = [
  { schema: Schema.String, value: "v1.4.2" },
  { schema: Schema.Struct({ version: Schema.String, attempt: Schema.Number }), value: { version: "v1", attempt: 2 } },
  { schema: Schema.Union([Schema.String, Schema.Number]), value: 123 },
  { schema: Schema.Union([Schema.String, Schema.Number]), value: "123" },
  { schema: Schema.String, value: "a < b & \"c\" \u{1D400}" }
]

const sameValue = (a: unknown, b: unknown) => typeof a === typeof b && canonicalJson(a) === canonicalJson(b)

type ConformanceOptions = Parameters<typeof conformance>[0]

/** The largest `n` in `[0, limit]` that `fits`, for a `fits` that holds up to some `n` and fails past it. */
const largestFitting = (limit: number, fits: (n: number) => boolean): number => {
  let low = 0
  let high = limit
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    if (fits(middle)) low = middle
    else high = middle - 1
  }
  return low
}

/**
 * Creates the conformance suite, as plain Effects keyed by rule name, so any
 * test runner can run them.
 *
 * **Details**
 *
 * - Each rule needs the adapter under test registered in `Chat` and a way to
 *   make another identity's message appear in `thread`, which must be a
 *   channel the suite may write to.
 * - A rule is never skipped. When the descriptor lacks a capability a rule
 *   needs, the rule becomes its inverse: the op fails with `Unsupported`.
 *   There is an `unsupported/{capability}` rule for every capability. When
 *   the capability is listed, it calls the op and fails if the op fails with
 *   `Unsupported`, so a descriptor that lies in either direction fails.
 * - A listed capability never fails with `Unsupported`, which every rule
 *   checks as it goes.
 * - The three `retries/*` rules exist only when `failNext` is given.
 *   `post/refusedFile` exists only when `refuseFiles` is given.
 * - The rules that need a click exist only when `interactions` is given,
 *   since neither platform has an API that clicks. A live run leaves it out
 *   and runs only the outbound rules. The suite provides its own recording
 *   `ChatInteraction.Handler` to the hook, so the rules still need only
 *   `Chat` and `Registry`.
 * - `modalErrors` has no inverse rule: without it an `errors` reply is a
 *   degraded answer, not a refusal.
 * - The `command/*` rules and `unsupported/ephemeral` exist only when
 *   `interactions.command` is given. `unsupported/commands` always runs: it
 *   calls `followUp` with a deferral the suite builds by hand, which must
 *   fail `Unsupported` without `commands`, and fail some other way with it.
 * - Every rule deletes what it posted when it ends, pass or fail, when the
 *   platform can delete.
 *
 * **Gotchas**
 *
 * Rule names are stable, an existing rule is never tightened, and a new rule
 * arrives only behind a new capability or with a changeset saying third-party
 * adapters may start failing. `unsupported/buttons` and
 * `unsupported/selects` are such rules: an adapter that ignores `actions`
 * and posts anyway fails them. So is `unsupported/commands`: an adapter whose
 * `followUp` does anything but fail `Unsupported` fails it. The `retries/retrySafe` rule waits for real
 * time, so run the suite on a live `Clock`.
 *
 * @stability unstable
 * @category testing
 * @since 4.1.5
 */
export const conformance = (options: {
  readonly platform: string
  readonly thread: ChatThread.ChatThread
  readonly userPosts: (thread: ChatThread.ChatThread, text: string) => Effect.Effect<ChatEvent.ChatEvent>
  readonly parseMention: ParseMention
  readonly refuseFiles?: (() => Effect.Effect<void>) | undefined
  readonly interactions?: Interactions | undefined
  readonly failNext?:
    | ((op: string, reason: ChatErrorReason, options?: {
      readonly times?: number | undefined
      readonly landed?: boolean | undefined
    }) => Effect.Effect<void>)
    | undefined
}): Readonly<Record<string, Effect.Effect<void, ConformanceFailure, Chat.Chat | Registry>>> => {
  const rules: Record<string, Effect.Effect<void, ConformanceFailure, Chat.Chat | Registry>> = {}
  const { parseMention, platform } = options

  const rule = (
    name: string,
    needs: ReadonlyArray<Capability>,
    body: (t: Tester) => Effect.Effect<void, ConformanceFailure, Registry>
  ) => {
    rules[name] = Effect.gen(function*() {
      const chat = yield* Chat.Chat
      const descriptor = yield* Effect.mapError(
        chat.descriptor(platform),
        (error) => failure(name, "a registered adapter", describeError(error), error)
      )
      const t = new Tester(name, chat, descriptor, options)
      const missing = needs.find((capability) => !t.has(capability))
      return yield* (missing === undefined ? body(t) : t.probe(missing)).pipe(
        Effect.ensuring(t.cleanup)
      )
    })
  }

  rule("post/fetchable", ["fetchMessage"], (t) =>
    Effect.gen(function*() {
      const posted = yield* t.post({})
      const message = yield* t.call(t.chat.fetchMessage(t.thread, posted.id))
      yield* t.check(
        posted.id === message.id && ChatThread.equals(posted.thread, t.thread) &&
          ChatThread.equals(message.thread, t.thread),
        "the posted message, addressed to " + ChatThread.toString(t.thread),
        () => "message " + message.id + " in " + ChatThread.toString(message.thread)
      )
    }))

  rule("post/authorIsSelf", ["fetchMessage"], (t) =>
    Effect.gen(function*() {
      const posted = yield* t.post({})
      const message = yield* t.call(t.chat.fetchMessage(t.thread, posted.id))
      yield* t.check(
        message.author.isSelf && message.author.isBot,
        "author.isSelf and author.isBot",
        () => "isSelf " + message.author.isSelf + ", isBot " + message.author.isBot
      )
    }))

  rule("post/replyTo", ["replyTo", "fetchMessage"], (t) =>
    Effect.gen(function*() {
      const target = yield* t.post({})
      const reply = yield* t.post({ replyTo: { messageId: target.id } })
      const message = yield* t.call(t.chat.fetchMessage(t.thread, reply.id))
      yield* t.check(
        message.replyTo?.messageId === target.id,
        "replyTo " + target.id,
        () => "replyTo " + message.replyTo?.messageId
      )
    }))

  rule("post/files", ["files", "download", "fetchMessage"], (t) =>
    Effect.gen(function*() {
      const file = conformanceFile(t.rule)
      const posted = yield* t.post({ files: [file] })
      const message = yield* t.call(t.chat.fetchMessage(t.thread, posted.id))
      yield* t.check(message.attachments.length === 1, "one attachment", () => message.attachments.length + "")
      const chunks = yield* t.collect(
        t.chat.download(t.thread, message.attachments[0], { maxBytes: file.content.length })
      )
      const bytes = Bytes.concat(chunks)
      yield* t.check(
        Bytes.Equivalence(bytes, file.content),
        "the uploaded bytes",
        () => bytes.length + " different bytes"
      )
    }))

  const refuseFiles = options.refuseFiles
  if (refuseFiles !== undefined) {
    rule("post/refusedFile", ["files", "history"], (t) =>
      Effect.gen(function*() {
        const before = yield* t.collect(t.chat.history(t.thread, { direction: "forward" }))
        yield* refuseFiles()
        const exit = yield* Effect.exit(t.chat.post(t.thread, {
          markdown: conformanceText(t.rule),
          files: [conformanceFile(t.rule)]
        }))
        if (Exit.isSuccess(exit)) t.track(exit.value)
        const after = yield* t.collect(t.chat.history(t.thread, { direction: "forward" }))
        const beforeIds = new Set(before.map((message) => message.id))
        for (const message of after) {
          if (message.author.isSelf && !beforeIds.has(message.id) && !t.created.some(({ id }) => id === message.id)) {
            t.created.push({ thread: message.thread, id: message.id })
          }
        }
        const error = Exit.findErrorOption(exit)
        const reason = Option.isSome(error) ? error.value.reason : undefined
        const listed = reason?._tag === "Unsupported" && t.has(reason.capability)
        yield* t.check(
          !listed && reason?.retry === "denied" && reason.detail === fileRefused,
          "denied with detail file_refused, not Unsupported for a listed capability",
          () => describeExit(exit) + (listed ? " for a listed capability" : "")
        )
        yield* t.check(
          after.length === before.length && after.every((message, i) => message.id === before[i].id),
          "no new message",
          () => after.length + " messages after, " + before.length + " before"
        )
      }))
  }

  rule("post/tooLarge", [], (t) =>
    t.expectReason(
      "TooLarge",
      t.chat.post(t.thread, { markdown: "x".repeat(t.descriptor.limits.messageLength + 1) }),
      (posted) => t.track(posted),
      textTooLarge
    ))

  rule("descriptor/measureFits", [], (t) =>
    Effect.gen(function*() {
      const { measure } = t.descriptor
      const limit = t.descriptor.limits.messageLength
      const largest = (make: (n: number) => string) => make(largestFitting(limit, (n) => measure(make(n)) <= limit))
      const blocks = largest((n) => measureFitsBlock.repeat(n))
      const markdown = largest((n) => blocks + "x".repeat(n))
      yield* t.post({ markdown })
    }))

  rule("descriptor/measureAdds", [], (t) =>
    Effect.gen(function*() {
      const { measure } = t.descriptor
      for (const a of measureSamples) {
        for (const b of measureSamples) {
          yield* t.check(
            measure(a + b) <= measure(a) + measure(b),
            "measure(a + b) <= measure(a) + measure(b)",
            () => JSON.stringify(a) + " + " + JSON.stringify(b) + " measures " + measure(a + b)
          )
        }
      }
      const letters = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ"
      yield* t.check(measure(letters) === letters.length, "ASCII letters measured at one each", () =>
        letters.length + " letters measure " + measure(letters))
    }))

  rule("post/noMentions", ["fetchMessage"], (t) =>
    Effect.gen(function*() {
      const posted = yield* t.post({ markdown: mentionLike })
      const message = yield* t.call(t.chat.fetchMessage(t.thread, posted.id))
      yield* t.check(message.mentions.length === 0, "no mentions", () => message.mentions.length + " mentions")
    }))

  const goneId = Effect.fnUntraced(function*(t: Tester) {
    const posted = yield* t.post({})
    if (!t.has("delete")) return posted.id + "0"
    yield* t.call(t.chat.delete(t.thread, posted.id))
    return posted.id
  })

  rule("edit/keepsId", ["edit", "fetchMessage"], (t) =>
    Effect.gen(function*() {
      const posted = yield* t.post({ markdown: conformanceText(t.rule) + " before" })
      const before = yield* t.call(t.chat.fetchMessage(t.thread, posted.id))
      yield* t.call(t.chat.edit(t.thread, posted.id, { markdown: conformanceText(t.rule) + " after" }))
      const after = yield* t.call(t.chat.fetchMessage(t.thread, posted.id))
      yield* t.check(
        after.id === posted.id && after.text !== before.text,
        "the same id with new text",
        () => "id " + after.id + (after.text === before.text ? " with the old text" : "")
      )
    }))

  rule("edit/unknownId", ["edit"], (t) =>
    Effect.flatMap(
      goneId(t),
      (id) => t.expectReason("NotFound", t.chat.edit(t.thread, id, { markdown: conformanceText(t.rule) }))
    ))

  rule("edit/tooLarge", ["edit"], (t) =>
    Effect.flatMap(t.post({}), (posted) =>
      t.expectReason(
        "TooLarge",
        t.chat.edit(t.thread, posted.id, { markdown: "x".repeat(t.descriptor.limits.messageLength + 1) }),
        undefined,
        textTooLarge
      )))

  rule("delete/gone", ["delete", "fetchMessage"], (t) =>
    Effect.gen(function*() {
      const posted = yield* t.post({})
      yield* t.call(t.chat.delete(t.thread, posted.id))
      yield* t.expectReason("NotFound", t.chat.fetchMessage(t.thread, posted.id))
    }))

  rule(
    "delete/unknownId",
    ["delete"],
    (t) => Effect.flatMap(goneId(t), (id) => t.expectReason("NotFound", t.chat.delete(t.thread, id)))
  )

  rule("history/order", ["history"], (t) =>
    Effect.gen(function*() {
      const a = yield* t.post({ markdown: conformanceText(t.rule) + " a" })
      const b = yield* t.post({ markdown: conformanceText(t.rule) + " b" })
      const c = yield* t.post({ markdown: conformanceText(t.rule) + " c" })
      const backward = yield* t.collect(Stream.take(t.chat.history(t.thread, { direction: "backward" }), 3))
      const forward = yield* t.collect(
        Stream.take(t.chat.history(t.thread, { direction: "forward", from: a.id }), 2)
      )
      const ids = (messages: ReadonlyArray<ChatMessage.ChatMessage>) => messages.map((m) => m.id).join(",")
      yield* t.check(ids(backward) === [c.id, b.id, a.id].join(","), "backward " + [c.id, b.id, a.id], () =>
        "backward " + ids(backward))
      yield* t.check(ids(forward) === [b.id, c.id].join(","), "forward " + [b.id, c.id], () =>
        "forward " + ids(forward))
    }))

  rule("history/fromExclusive", ["history"], (t) =>
    Effect.gen(function*() {
      const a = yield* t.post({ markdown: conformanceText(t.rule) + " a" })
      const b = yield* t.post({ markdown: conformanceText(t.rule) + " b" })
      const before = yield* t.collect(Stream.take(t.chat.history(t.thread, { direction: "backward", from: b.id }), 1))
      const after = yield* t.collect(Stream.take(t.chat.history(t.thread, { direction: "forward", from: a.id }), 1))
      yield* t.check(
        before[0]?.id === a.id && after[0]?.id === b.id,
        "the message next to from, not from itself",
        () => "backward " + before[0]?.id + ", forward " + after[0]?.id
      )
    }))

  rule("history/sameAsInbound", ["history"], (t) =>
    Effect.gen(function*() {
      const event = yield* t.userPosts()
      const history = yield* t.collect(Stream.take(t.chat.history(t.thread, { direction: "backward" }), 20))
      const read = findIn(history, event.message.id)
      yield* t.check(
        read !== undefined && sameMessage(event.message, read),
        "the inbound message in history",
        () => read === undefined ? "no such message" : "a different message"
      )
    }))

  rule("history/startsWithOpener", ["history", "startThread"], (t) =>
    Effect.gen(function*() {
      const opener = yield* t.post({ markdown: conformanceText(t.rule) + " opener" })
      const thread = yield* t.call(t.chat.startThread(t.thread, opener.id, { name: conformanceText(t.rule) }))
      yield* t.post({ markdown: conformanceText(t.rule) + " reply" }, thread)
      const first = yield* t.collect(Stream.take(t.chat.history(thread, { direction: "forward" }), 1))
      yield* t.check(
        first[0]?.id === opener.id && ChatThread.equals(first[0].thread, t.thread),
        "the opener first, addressed to " + ChatThread.toString(t.thread),
        () =>
          first[0] === undefined
            ? "an empty history"
            : "message " + first[0].id + " in " + ChatThread.toString(first[0].thread)
      )
    }))

  rule("message/threadStable", ["fetchMessage", "history", "startThread"], (t) =>
    Effect.gen(function*() {
      const event = yield* t.userPosts()
      const id = event.message.id
      const read = Effect.gen(function*() {
        const fetched = yield* t.call(t.chat.fetchMessage(t.thread, id))
        const history = yield* t.collect(Stream.take(t.chat.history(t.thread, { direction: "backward" }), 20))
        return [fetched, findIn(history, id)] as const
      })
      const before = yield* read
      const thread = yield* t.call(t.chat.startThread(t.thread, id, { name: conformanceText(t.rule) }))
      yield* t.post({ markdown: conformanceText(t.rule) + " reply" }, thread)
      const after = yield* read
      const reads = [event.message, ...before, ...after]
      yield* t.check(
        reads.every((message) => message !== undefined && ChatThread.equals(message.thread, t.thread)),
        "every read addressed to " + ChatThread.toString(t.thread),
        () => reads.map((message) => message === undefined ? "missing" : ChatThread.toString(message.thread)).join(", ")
      )
    }))

  rule("inbound/fetchable", ["fetchMessage"], (t) =>
    Effect.gen(function*() {
      const event = yield* t.userPosts()
      const message = yield* t.call(t.chat.fetchMessage(event.thread, event.message.id))
      yield* t.check(sameMessage(event.message, message), "the inbound message", () => "a different message")
    }))

  rule("inbound/notSelf", [], (t) =>
    Effect.gen(function*() {
      const event = yield* t.userPosts()
      yield* t.check(!event.message.author.isSelf, "author.isSelf false", () => "author.isSelf true")
      yield* checkEvent(event, { platform, parseMention }).pipe(
        Effect.mapError((error) => failure(t.rule, error.expected, error.actual, error.cause))
      )
    }))

  rule("download/maxBytes", ["files", "download", "fetchMessage"], (t) =>
    Effect.gen(function*() {
      const file = conformanceFile(t.rule)
      const posted = yield* t.post({ files: [file] })
      const message = yield* t.call(t.chat.fetchMessage(t.thread, posted.id))
      yield* t.check(message.attachments.length === 1, "one attachment", () => message.attachments.length + "")
      yield* t.expectReason(
        "TooLarge",
        Stream.runDrain(t.chat.download(t.thread, message.attachments[0], { maxBytes: 8 }))
      )
    }))

  rule("startThread/idempotent", ["startThread"], (t) =>
    Effect.gen(function*() {
      const posted = yield* t.post({})
      const first = yield* t.call(t.chat.startThread(t.thread, posted.id, { name: conformanceText(t.rule) }))
      const second = yield* t.call(t.chat.startThread(t.thread, posted.id))
      yield* t.check(
        ChatThread.equals(first, second),
        ChatThread.toString(first),
        () => ChatThread.toString(second)
      )
    }))

  rule("opener/noneOutsideThread", ["opener"], (t) =>
    Effect.flatMap(
      t.call(t.chat.opener(t.thread)),
      (opener) => t.check(Option.isNone(opener), "no opener", () => "an opener")
    ))

  rule("descriptor/streamFitsMessage", ["nativeStream"], (t) => {
    const { messageLength, streamLength } = t.descriptor.limits
    return t.check(
      streamLength !== undefined && streamLength <= messageLength,
      "limits.streamLength at most " + messageLength,
      () => "limits.streamLength " + streamLength
    )
  })

  const openStream = Effect.fnUntraced(function*(t: Tester, markdown: string) {
    const registry = yield* Registry
    const adapter = yield* t.call(registry.get(platform))
    const native = adapter.nativeStream!
    const event = yield* t.userPosts()
    const posted = yield* t.call(native.start(t.thread, { markdown, recipient: event.message.author.id }))
    t.track(posted)
    return { native, posted }
  })

  rule("nativeStream/concatenates", ["nativeStream", "fetchMessage"], (t) =>
    Effect.gen(function*() {
      const first = conformanceText(t.rule) + " one"
      const { native, posted } = yield* openStream(t, first)
      const appended = yield* t.call(native.append(t.thread, posted.id, " two", { flush: true })).pipe(
        Effect.ensuring(Effect.ignore(native.stop(t.thread, posted.id, { end: "done" })))
      )
      yield* t.check(appended.state === "open" && appended.held === 0, "an open append holding nothing", () =>
        appended.state + " holding " + appended.held)
      const message = yield* t.call(t.chat.fetchMessage(t.thread, posted.id))
      yield* t.check(message.text === first + " two", JSON.stringify(first + " two"), () =>
        JSON.stringify(message.text))
    }))

  rule("nativeStream/appendAfterStop", ["nativeStream", "fetchMessage"], (t) =>
    Effect.gen(function*() {
      const first = conformanceText(t.rule)
      const { native, posted } = yield* openStream(t, first)
      yield* t.call(native.stop(t.thread, posted.id, { end: "done" }))
      const appended = yield* t.call(native.append(t.thread, posted.id, " after", { flush: true }))
      const message = yield* t.call(t.chat.fetchMessage(t.thread, posted.id))
      yield* t.check(
        appended.state === "closed" && message.text === first,
        "closed, with the text unchanged",
        () => appended.state + " with " + JSON.stringify(message.text)
      )
    }))

  // --- buttons and modals ----------------------------------------------------

  const limit = (t: Tester, name: "actionsPerMessage" | "actionDataLength" | "modalMetadataLength" | "modalFields") =>
    Effect.flatMap(
      t.check(
        t.descriptor.limits[name] !== undefined,
        "limits." + name + " on a descriptor with its capability",
        () => "no limits." + name
      ),
      () => Effect.succeed(t.descriptor.limits[name]!)
    )

  rule("actions/posts", ["buttons"], (t) =>
    Effect.gen(function*() {
      const posted = yield* t.post({ actions: [conformanceButton(t.rule)] })
      if (!t.has("fetchMessage")) return
      const message = yield* t.call(t.chat.fetchMessage(t.thread, posted.id))
      yield* t.check(message.id === posted.id, "the posted message " + posted.id, () => "message " + message.id)
    }))

  rule("actions/tooMany", ["buttons"], (t) =>
    Effect.gen(function*() {
      const most = yield* limit(t, "actionsPerMessage")
      const actions = Array.from({ length: most + 1 }, (_, i): ChatUi.Button => ({
        _tag: "Button",
        id: "c" + i,
        label: "c" + i
      }))
      yield* t.expectReason(
        "TooLarge",
        t.chat.post(t.thread, { markdown: conformanceText(t.rule), actions }),
        (posted) => t.track(posted)
      )
    }))

  rule("actions/dataTooLarge", ["buttons"], (t) =>
    Effect.gen(function*() {
      const most = yield* limit(t, "actionDataLength")
      const id = most >= "conformance".length ? "conformance" : "c".repeat(most + 1)
      const value = "x".repeat(most + 1 - id.length)
      const button: ChatUi.Button = { _tag: "Button", id, label: "c", ...(value === "" ? {} : { value }) }
      yield* t.expectReason(
        "TooLarge",
        t.chat.post(t.thread, { markdown: conformanceText(t.rule), actions: [button] }),
        (posted) => t.track(posted)
      )
    }))

  rule("descriptor/measureAddsActions", ["buttons"], (t) =>
    Effect.gen(function*() {
      const { measure } = t.descriptor
      const button = conformanceButton(t.rule)
      const sets: ReadonlyArray<ReadonlyArray<ChatUi.Action>> = [
        [button],
        [{ ...button, value: "a < b & \u{1D400}" }],
        [button, { _tag: "LinkButton", label: "Link", url: "https://example.com/?a=1&b=<2>" }],
        [conformanceSelect(t.rule)]
      ]
      for (const markdown of measureSamples) {
        yield* t.check(measure(markdown, []) === measure(markdown), "measure(md, []) equal to measure(md)", () =>
          JSON.stringify(markdown) + " measures " + measure(markdown, []) + " and " + measure(markdown))
        for (const actions of sets) {
          const both = measure(markdown, actions)
          yield* t.check(
            both <= measure(markdown) + measure("", actions) && both >= measure(markdown),
            "measure(md) <= measure(md, actions) <= measure(md) + measure(\"\", actions)",
            () =>
              JSON.stringify(markdown) + " with " + actions.map((action) =>
                action._tag
              ) + " measures " + both
          )
        }
      }
    }))

  rule("descriptor/measureFitsActions", ["buttons"], (t) =>
    Effect.gen(function*() {
      const { measure } = t.descriptor
      const most = t.descriptor.limits.messageLength
      // A short label, so a platform whose labels are short still takes the button.
      const actions = [{ ...conformanceButton(t.rule), label: "fits", value: "x" }]
      const length = largestFitting(most, (n) => measure("x".repeat(n), actions) <= most)
      yield* t.post({ markdown: "x".repeat(length), actions })
    }))

  const interactions = options.interactions
  if (interactions !== undefined) {
    rule("actions/valueRoundTrips", ["buttons"], (t) =>
      Effect.gen(function*() {
        const buttons = valueCases.map(({ schema }, i) =>
          ChatInteraction.button("v" + i, { label: "v" + i, value: schema })
        )
        const posted = yield* t.post({ actions: buttons.map((button, i) => button.of(valueCases[i].value)) })
        for (const [i, { schema, value }] of valueCases.entries()) {
          yield* t.click(posted.id, "v" + i)
          const click = t.recording.clicks[i]
          const decoded = click?._tag === "ButtonClicked" && click.value !== undefined
            ? ChatInteraction.decodeValue(schema, click.value)
            : Option.none()
          yield* t.check(
            Option.isSome(decoded) && sameValue(decoded.value, value),
            "a value that decodes to " + canonicalJson(value),
            () => click === undefined ? "no click" : "value " + JSON.stringify(click.value)
          )
        }
      }))

    rule("actions/absentValue", ["buttons"], (t) =>
      Effect.gen(function*() {
        const posted = yield* t.post({ actions: [conformanceButton(t.rule)] })
        yield* t.click(posted.id, "conformance")
        const click = t.recording.clicks[0]
        yield* t.check(
          click?._tag === "ButtonClicked" && !("value" in click),
          "a click with no value key",
          () => click === undefined ? "no click" : "value " + JSON.stringify(click.value)
        )
      }))

    rule("actions/origin", ["buttons"], (t) =>
      Effect.gen(function*() {
        const posted = yield* t.post({ actions: [conformanceButton(t.rule)] })
        yield* t.click(posted.id, "conformance")
        const click = t.recording.clicks[0]
        yield* t.check(
          click !== undefined && click.messageId === posted.id && ChatThread.equals(click.thread, posted.thread),
          "a click on " + posted.id + " in " + ChatThread.toString(posted.thread),
          () => click === undefined ? "no click" : click.messageId + " in " + ChatThread.toString(click.thread)
        )
        yield* t.checkInteraction(click)
      }))

    rule("actions/selectValue", ["selects"], (t) =>
      Effect.gen(function*() {
        const posted = yield* t.post({ actions: [conformanceSelect(t.rule)] })
        yield* t.click(posted.id, "conformance", { option: "b" })
        const event = t.recording.clicks[0]
        yield* t.check(
          event?._tag === "SelectChanged" && event.value === "b",
          "SelectChanged with value b",
          () => event === undefined ? "no click" : event._tag + " with value " + JSON.stringify(event.value)
        )
        yield* t.checkInteraction(event)
      }))

    rule("edit/removesActions", ["buttons", "edit"], (t) =>
      Effect.gen(function*() {
        const posted = yield* t.post({ actions: [conformanceButton(t.rule)] })
        yield* t.call(t.chat.edit(t.thread, posted.id, { markdown: conformanceText(t.rule) + " edited" }))
        const exit = yield* t.clickExit(posted.id, "conformance")
        const error = Exit.findErrorOption(exit)
        yield* t.check(
          Option.isSome(error) && error.value._tag === "NoSuchElement",
          "NoSuchElement",
          () => describeExit(exit)
        )
      }))

    rule("edit/addsActions", ["buttons", "edit"], (t) =>
      Effect.gen(function*() {
        const posted = yield* t.post({})
        yield* t.call(t.chat.edit(t.thread, posted.id, {
          markdown: conformanceText(t.rule) + " edited",
          actions: [conformanceButton(t.rule)]
        }))
        yield* t.click(posted.id, "conformance")
        yield* t.check(t.recording.clicks.length === 1, "one click", () => t.recording.clicks.length + " clicks")
      }))

    rule("modal/origin", ["modals"], (t) =>
      Effect.gen(function*() {
        const posted = yield* t.openModal(probeModal.open())
        yield* t.submit({ answer: "conformance" })
        const submit = t.recording.submits[0]
        yield* t.check(
          submit !== undefined && submit.messageId === posted.id && ChatThread.equals(submit.thread, posted.thread),
          "a submit from " + posted.id + " in " + ChatThread.toString(posted.thread),
          () => submit === undefined ? "no submit" : submit.messageId + " in " + ChatThread.toString(submit.thread)
        )
        yield* t.checkInteraction(submit)
      }))

    rule("modal/metadataRoundTrips", ["modals"], (t) =>
      Effect.gen(function*() {
        const Metadata = Schema.Struct({ version: Schema.String })
        const withMetadata = ChatInteraction.modal("conformance-meta", {
          title: "Conformance",
          metadata: Metadata,
          fields: { answer: ChatInteraction.textInput({ label: "Answer" }) }
        })
        const value = { version: "v1 < \u{1D400}" }
        yield* t.openModal(withMetadata.open({ metadata: value }))
        yield* t.submit({ answer: "conformance" })
        yield* t.openModal(probeModal.open())
        yield* t.submit({ answer: "conformance" })
        const [first, second] = t.recording.submits
        const decoded = first?.metadata === undefined
          ? Option.none()
          : ChatInteraction.decodeValue(Metadata, first.metadata)
        yield* t.check(
          Option.isSome(decoded) && sameValue(decoded.value, value),
          "metadata that decodes to " + canonicalJson(value),
          () => first === undefined ? "no submit" : "metadata " + JSON.stringify(first.metadata)
        )
        yield* t.check(
          second !== undefined && !("metadata" in second),
          "a submit with no metadata key",
          () => second === undefined ? "no submit" : "metadata " + JSON.stringify(second.metadata)
        )
      }))

    const refusedTooLarge = Effect.fnUntraced(function*(t: Tester) {
      yield* t.submit({})
      const refusal = t.recording.refused[0]
      yield* t.check(
        refusal?.reason._tag === "TooLarge" && t.recording.submits.length === 0,
        "a refusal TooLarge and no modal",
        () =>
          (refusal === undefined ? "no refusal" : "a refusal " + describeError(refusal)) +
          (t.recording.submits.length === 0 ? "" : " and a submit")
      )
    })

    rule("modal/metadataTooLarge", ["modals"], (t) =>
      Effect.gen(function*() {
        const most = yield* limit(t, "modalMetadataLength")
        const id = "conformance-big"
        const big = ChatInteraction.modal(id, {
          title: "Conformance",
          metadata: Schema.String,
          fields: { answer: ChatInteraction.textInput({ label: "Answer" }) }
        })
        yield* t.openModal(big.open({ metadata: "x".repeat(Math.max(0, most + 1 - id.length)) }))
        yield* refusedTooLarge(t)
      }))

    rule("modal/tooManyFields", ["modals"], (t) =>
      Effect.gen(function*() {
        const most = yield* limit(t, "modalFields")
        const fields: Record<string, ChatInteraction.TextInput> = {}
        for (let i = 0; i <= most; i++) fields["f" + i] = ChatInteraction.textInput({ label: "F" + i })
        yield* t.openModal(ChatInteraction.modal("conformance-many", { title: "Conformance", fields }).open())
        yield* refusedTooLarge(t)
      }))

    // `modalErrors` means nothing without `modals`, so the rule needs both.
    rule("modal/errorsKeepOpen", ["modals", "modalErrors"], (t) =>
      Effect.gen(function*() {
        t.recording.onSubmit = () =>
          t.recording.submits.length === 1 ? ChatInteraction.errors({ answer: "Again." }) : ChatInteraction.close
        yield* t.openModal(probeModal.open())
        yield* t.submit({ answer: "first" })
        yield* t.submit({ answer: "second" })
        const second = t.recording.submits[1]
        yield* t.check(
          second !== undefined && second.id === "conformance-modal",
          "a second submit of the same modal",
          () => t.recording.submits.length + " submits"
        )
      }))

    rule("unsupported/modals", ["buttons"], (t) => t.probe("modals"))
  }

  if (interactions?.command !== undefined) {
    const commandId = "conformance-command"

    rule("command/arrives", ["commands"], (t) =>
      Effect.gen(function*() {
        const text = "deploy v1 < \u{1D400}"
        yield* t.command(commandId, { text })
        const command = t.recording.commands[0]
        yield* t.check(
          command !== undefined && command.id === commandId && command.text === text &&
            ChatThread.equals(command.thread, t.thread),
          "command " + commandId + " with text " + JSON.stringify(text) + " in " + ChatThread.toString(t.thread),
          () =>
            command === undefined
              ? "no command"
              : "command " + command.id + " with text " + JSON.stringify(command.text) + " in " +
                ChatThread.toString(command.thread)
        )
        yield* t.checkInteraction(command)
      }))

    rule("command/emptyText", ["commands"], (t) =>
      Effect.gen(function*() {
        yield* t.command(commandId)
        const command = t.recording.commands[0]
        yield* t.check(
          command !== undefined && command.text === "",
          "a command with text \"\"",
          () => command === undefined ? "no command" : "text " + JSON.stringify(command.text)
        )
      }))

    const noRefusal = (t: Tester) =>
      t.check(
        t.recording.commands.length === 1 && t.recording.refused.length === 0,
        "one command and no refusal",
        () =>
          t.recording.commands.length + " commands and refusals " +
          (t.recording.refused.length === 0 ? "none" : t.recording.refused.map(describeError).join(", "))
      )

    rule("command/responds", ["commands"], (t) =>
      Effect.gen(function*() {
        t.recording.onCommand = () =>
          ChatInteraction.respond({ markdown: conformanceText(t.rule), visibility: "public" })
        yield* t.command(commandId)
        yield* noRefusal(t)
      }))

    rule("command/respondsPrivately", ["commands", "ephemeral"], (t) =>
      Effect.gen(function*() {
        t.recording.onCommand = () => ChatInteraction.respond({ markdown: conformanceText(t.rule) })
        yield* t.command(commandId)
        yield* noRefusal(t)
      }))

    rule("command/respondTooLarge", ["commands"], (t) =>
      Effect.gen(function*() {
        const markdown = "x".repeat(t.descriptor.limits.messageLength + 1)
        t.recording.onCommand = () => ChatInteraction.respond({ markdown, visibility: "public" })
        yield* t.command(commandId)
        const refusal = t.recording.refused[0]
        yield* t.check(
          refusal !== undefined && textTooLarge.test(refusal.reason),
          "a refusal " + textTooLarge.expected,
          () => refusal === undefined ? "no refusal" : "a refusal " + describeError(refusal)
        )
      }))

    rule("command/followUp", ["commands"], (t) =>
      Effect.gen(function*() {
        t.recording.onCommand = (command) => ChatInteraction.defer(command, { visibility: "public" })
        yield* t.command(commandId)
        const deferred = t.recording.commandReplies[0]
        if (deferred?._tag !== "Defer") {
          return yield* Effect.fail(
            failure(t.rule, "a Defer reply", deferred === undefined ? "no command" : deferred._tag)
          )
        }
        yield* noRefusal(t)
        yield* t.call(t.chat.followUp(deferred, { markdown: conformanceText(t.rule) }))
      }))

    rule("command/modalOrigin", ["commands", "modals"], (t) =>
      Effect.gen(function*() {
        t.recording.onCommand = () => probeModal.open()
        yield* t.command(commandId)
        yield* t.submit({ answer: "conformance" })
        const submit = t.recording.submits[0]
        yield* t.check(
          submit !== undefined && submit.messageId === undefined && ChatThread.equals(submit.thread, t.thread),
          "a submit in " + ChatThread.toString(t.thread) + " with no messageId",
          () =>
            submit === undefined
              ? "no submit"
              : "a submit in " + ChatThread.toString(submit.thread) + " with messageId " + submit.messageId
        )
        yield* t.checkInteraction(submit)
      }))

    rule("unsupported/ephemeral", ["commands"], (t) => t.probe("ephemeral"))
  }

  for (const capability of allCapabilities) {
    if (capability === "modals" || capability === "modalErrors" || capability === "ephemeral") continue
    rule("unsupported/" + capability, [], (t) => t.probe(capability))
  }

  const failNext = options.failNext
  if (failNext !== undefined) {
    rule("retries/noneWithoutRetries", [], (t) =>
      Effect.gen(function*() {
        yield* failNext("post", new RateLimited({}))
        yield* t.expectReason(
          "RateLimited",
          Chat.withoutRetries(t.chat.post(t.thread, { markdown: conformanceText(t.rule) })),
          (posted) => t.track(posted)
        )
      }))

    rule("retries/retrySafe", [], (t) =>
      Effect.gen(function*() {
        const retryAfter = Duration.millis(100)
        yield* failNext("post", new RateLimited({ retryAfter }))
        const start = yield* DateTime.now
        yield* t.post({})
        const elapsed = DateTime.distance(start, yield* DateTime.now)
        yield* t.check(
          // One millisecond of slack: a timer and the clock round to whole milliseconds apart.
          Duration.toMillis(elapsed) + 1 >= Duration.toMillis(retryAfter),
          "a retry after " + Duration.format(retryAfter),
          () => "a retry after " + Duration.format(elapsed)
        )
      }))

    rule("retries/neverUncertain", [], (t) =>
      Effect.gen(function*() {
        yield* failNext("post", new Transport({ retry: "uncertain" }))
        yield* t.expectReason(
          "Transport",
          t.chat.post(t.thread, { markdown: conformanceText(t.rule) }),
          (posted) => t.track(posted)
        )
      }))
  }

  return rules
}
