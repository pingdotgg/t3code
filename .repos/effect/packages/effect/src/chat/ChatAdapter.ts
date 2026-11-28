/**
 * What a chat platform adapter implements.
 *
 * An adapter is a set of `Ops` plus a static `Descriptor` of what the
 * platform supports. Adapters register in the `Registry`, which `Chat`
 * routes through by `thread.platform`.
 *
 * **Details**
 *
 * - Every op exists on every platform. Where the platform has no equivalent
 *   the op fails with `Unsupported`, naming the capability.
 * - A post notifies nobody unless asked: mentions in Markdown do not notify by
 *   default.
 * - Length is checked before the call, with `checkMessageLength`, in the
 *   unit the descriptor's `measure` counts.
 * - Adapters retry `retry` failures with `retrySafe` and never retry
 *   `uncertain` ones.
 *
 * @stability unstable
 * @since 4.1.5
 */
import * as Context from "../Context.ts"
import type * as DateTime from "../DateTime.ts"
import * as Duration from "../Duration.ts"
import * as Effect from "../Effect.ts"
import * as Layer from "../Layer.ts"
import type * as Option from "../Option.ts"
import type * as Schema from "../Schema.ts"
import type * as Scope from "../Scope.ts"
import type * as Stream from "../Stream.ts"
import type { Capability } from "./ChatError.ts"
import { ChatError, TooLarge } from "./ChatError.ts"
import type { ThreadKind } from "./ChatEvent.ts"
import type { Defer } from "./ChatInteraction.ts"
import type { Attachment, ChatMessage, ReplyTo } from "./ChatMessage.ts"
import type { ChatThread } from "./ChatThread.ts"
import type { Action } from "./ChatUi.ts"
import { RetriesDisabled } from "./internal/retries.ts"

/**
 * Static description of a platform: its capabilities and limits, readable
 * without a call to the platform.
 *
 * **Details**
 *
 * - An op whose capability is missing from `capabilities` fails with
 *   `Unsupported`.
 * - `limits.messageLength` is the platform's own limit for one message, in
 *   the platform's own unit. Where every message also carries a fixed
 *   overhead that the text does not, such as a card's structure, it is that
 *   limit less a fixed reservation for the overhead, and the adapter's docs
 *   give both numbers.
 * - `measure` gives what a Markdown string costs against
 *   `limits.messageLength` and `limits.streamLength`. It is pure and makes
 *   no call to the platform. It is an upper bound, never less than what the
 *   adapter sends for the text, and it adds up:
 *   `measure(a + b) <= measure(a) + measure(b)`. It measures ASCII letters
 *   at one each.
 * - `measure` takes the `actions` a message carries as an optional second
 *   argument. Where text and elements share one budget (Slack) they add to
 *   the cost, and elsewhere the argument is ignored. With it,
 *   `measure(md, actions) <= measure(md) + measure("", actions)`, so a caller
 *   can set room aside for the elements before it cuts the text,
 *   `measure(md, actions) >= measure(md)`, and `measure(md, [])` is
 *   `measure(md)`. A `measure` with one parameter fits the type.
 * - `limits.minWriteInterval` is the default floor between two writes to one
 *   thread, for streamed and multi-part posts.
 * - `limits.streamLength` and `limits.streamAge` apply to native streams
 *   only. `streamLength` is never more than `messageLength`, so a stream's
 *   text always fits an `edit`.
 * - `limits.actionsPerMessage`, `limits.actionDataLength`,
 *   `limits.modalMetadataLength` and `limits.modalFields` are there exactly
 *   when the matching capability is (`buttons` for the first two, `modals`
 *   for the last two). Each is the platform's number in the platform's unit,
 *   as `messageLength` is. Where the platform publishes none, it is the
 *   adapter's own cap, documented as the adapter's, and set so that a
 *   message holding every element at its cap still fits `messageLength`.
 *   The adapter checks them exactly and fails
 *   `TooLarge`: before the call for a message's elements, and before it
 *   opens a modal.
 * - `limits.followUpAge` is there exactly when `commands` is: how long after
 *   a command its `followUp` still works.
 *
 * **Gotchas**
 *
 * Title and label limits of a modal are not on the descriptor. The adapter
 * checks them the same way, and its docs list them.
 *
 * @stability unstable
 * @category models
 * @since 4.1.5
 */
export interface Descriptor {
  readonly platform: string
  readonly capabilities: ReadonlySet<Capability>
  readonly measure: (markdown: string, actions?: ReadonlyArray<Action>) => number
  readonly limits: {
    readonly messageLength: number
    readonly filesPerMessage: number
    readonly uploadBytes: number
    readonly minWriteInterval: Duration.Duration
    readonly streamLength?: number | undefined
    readonly streamAge?: Duration.Duration | undefined
    /** How many elements one message's `actions` may hold. */
    readonly actionsPerMessage?: number | undefined
    /** The most an element's id and encoded value may take together. */
    readonly actionDataLength?: number | undefined
    /** The most a modal's id and its encoded metadata may take together, after what the adapter adds. */
    readonly modalMetadataLength?: number | undefined
    /** How many inputs and texts one modal may hold. */
    readonly modalFields?: number | undefined
    /** How long after a command its `followUp` still works. */
    readonly followUpAge?: Duration.Duration | undefined
  }
}

/**
 * A file to upload with a post.
 *
 * @stability unstable
 * @category models
 * @since 4.1.5
 */
export interface File {
  readonly name: string
  readonly contentType: string
  readonly content: Uint8Array
}

/**
 * The message a successful post created.
 *
 * @stability unstable
 * @category models
 * @since 4.1.5
 */
export interface Posted {
  readonly id: string
  readonly thread: ChatThread
  readonly timestamp: DateTime.Utc
}

/**
 * What the platform says about an address.
 *
 * @stability unstable
 * @category models
 * @since 4.1.5
 */
export interface ThreadInfo {
  readonly thread: ChatThread
  readonly kind: ThreadKind
  readonly name?: string | undefined
  readonly topic?: string | undefined
  readonly parent?: ChatThread | undefined
  readonly createdAt?: DateTime.Utc | undefined
  readonly raw: Schema.Json
}

/**
 * A user as the platform reports them.
 *
 * **Details**
 *
 * - `name` is the guild nick when `in` was given and the platform has one.
 * - `raw` is the platform's own record of the user. What the model has no
 *   field for, such as a Slack user's team or a Discord member's roles, is
 *   read from there. Each adapter documents what its `raw` holds.
 *
 * @stability unstable
 * @category models
 * @since 4.1.5
 */
export interface User {
  readonly id: string
  readonly name: string
  readonly isBot: boolean
  readonly isSelf: boolean
  readonly raw: Schema.Json
}

/**
 * The operations of one platform. `Chat` has the same ops, routed by
 * `thread.platform`.
 *
 * **Details**
 *
 * - `post` takes standard Markdown that must fit `limits.messageLength`. It
 *   never splits or truncates: the adapter checks the length itself and fails
 *   with `TooLarge` without calling the platform. Mentions in it notify nobody.
 * - A `post` shows no link preview unless requested through the adapter's
 *   scoped `withPostOptions`. This rule does not cover edits or native streams.
 * - `fetchMessage` fails with `NotFound` for a message that is gone.
 * - `history` pages lazily. `backward` runs newest to oldest, `forward`
 *   oldest to newest, and `from` is exclusive. A thread's oldest message is its
 *   opener, whose `thread` is the thread's parent: the one message in a
 *   thread's history that is not addressed to that thread. Without an opener,
 *   history starts at the first reply, whether the opener was deleted or the
 *   platform's thread root is not a message. A `backward` read that stops
 *   early has not reached the opener: `opener` reads it by itself.
 * - `download` fails with `TooLarge` as soon as more than `maxBytes` arrive.
 *   It streams, so a file is never held whole unless the caller asks:
 *   `Stream.mkUint8Array` collects the stream into one array.
 * - `startThread` returns the thread under `messageId`, created when there is
 *   none. It is get-or-create, and the only way from an opener to its thread.
 * - `opener` is the message a thread hangs off: `None` for a channel or
 *   direct address, or when it was deleted.
 * - `actions` is a flat list of elements beside the Markdown, and the
 *   adapter lays out the rows. A platform without an element fails
 *   `Unsupported` before the call, naming `buttons` or `selects`. An
 *   `edit` replaces the whole message, so an edit without `actions`
 *   removes them.
 * - `followUp` sends the answer a command's `Defer` promised, to whoever
 *   its `visibility` names. It is routed by `deferred.command.thread` and
 *   never retried. It takes no files, and `withPostOptions` does not reach
 *   it. The contract is one call per deferral: a second posts another
 *   message on Slack and replaces the first on Discord. An adapter does not
 *   stop it, and `ChatTest`'s fake fails it. It fails
 *   `NotFound` with detail `interaction_expired` past `limits.followUpAge`,
 *   and `Unsupported` without `commands`.
 *
 * @stability unstable
 * @category models
 * @since 4.1.5
 */
export interface Ops {
  readonly post: (thread: ChatThread, content: {
    readonly markdown: string
    readonly replyTo?: ReplyTo | undefined
    readonly files?: ReadonlyArray<File> | undefined
    readonly actions?: ReadonlyArray<Action> | undefined
  }) => Effect.Effect<Posted, ChatError>
  readonly edit: (
    thread: ChatThread,
    messageId: string,
    content: {
      readonly markdown: string
      readonly actions?: ReadonlyArray<Action> | undefined
    }
  ) => Effect.Effect<void, ChatError>
  readonly delete: (thread: ChatThread, messageId: string) => Effect.Effect<void, ChatError>
  readonly fetchMessage: (thread: ChatThread, messageId: string) => Effect.Effect<ChatMessage, ChatError>
  readonly history: (thread: ChatThread, options: {
    readonly direction: "backward" | "forward"
    readonly from?: string | undefined
  }) => Stream.Stream<ChatMessage, ChatError>
  readonly download: (
    thread: ChatThread,
    attachment: Attachment,
    options: { readonly maxBytes: number }
  ) => Stream.Stream<Uint8Array, ChatError>
  readonly startThread: (
    thread: ChatThread,
    messageId: string,
    options?: { readonly name?: string | undefined }
  ) => Effect.Effect<ChatThread, ChatError>
  readonly getThread: (thread: ChatThread) => Effect.Effect<ThreadInfo, ChatError>
  readonly opener: (thread: ChatThread) => Effect.Effect<Option.Option<ChatMessage>, ChatError>
  readonly getUser: (
    id: string,
    options?: { readonly in?: ChatThread | undefined }
  ) => Effect.Effect<User, ChatError>
  readonly followUp: (deferred: Defer, content: {
    readonly markdown: string
    readonly actions?: ReadonlyArray<Action> | undefined
  }) => Effect.Effect<void, ChatError>
}

/**
 * A platform's native streaming of one message, used by `ChatMarkdown.stream`
 * when present. It is adapter-facing and not on `Chat`.
 *
 * **Details**
 *
 * - `start` fails with `Unsupported` when the platform refuses the feature
 *   for this thread or recipient, and the caller falls back to post-then-edit.
 *   It holds nothing back: all of `markdown` is sent. Do not end `markdown`
 *   inside a surrogate pair: a lone surrogate is sent as U+FFFD.
 * - `append` is never retried by the adapter. `open` means the text was
 *   added apart from its last `held` UTF-16 code units, `stopped` means
 *   nothing was added because a user stopped the stream, and `closed` means
 *   nothing was added because the stream is closed or expired.
 * - `held` counts the trailing code units the adapter could not send yet,
 *   such as an unclosed `<` or a high surrogate whose other half has not
 *   arrived. The caller keeps `markdown.slice(markdown.length - held)` and
 *   sends it again at the front of the next append. `flush` holds nothing
 *   back and sends a lone surrogate as U+FFFD. A `TooLarge` failure means
 *   nothing was added and the stream is still open.
 * - `stop` closes the stream. `stopped` says whether a user had clicked stop
 *   on it. It succeeds with `stopped: false` on a stream that is already
 *   closed.
 * - `continues` on `start` is the message id of the reply's previous part,
 *   absent for a reply's first message. It tells the adapter which reply the
 *   stream belongs to, so state kept per reply, such as a rate limit's
 *   backoff, carries over a rotation and never passes to another reply.
 *
 * @stability unstable
 * @category models
 * @since 4.1.5
 */
export interface NativeStream {
  readonly start: (thread: ChatThread, options: {
    readonly markdown: string
    readonly replyTo?: ReplyTo | undefined
    readonly recipient?: string | undefined
    readonly continues?: string | undefined
  }) => Effect.Effect<Posted, ChatError>
  readonly append: (
    thread: ChatThread,
    messageId: string,
    markdown: string,
    options?: { readonly flush?: boolean | undefined }
  ) => Effect.Effect<
    { readonly state: "open" | "stopped" | "closed"; readonly held: number },
    ChatError
  >
  readonly stop: (
    thread: ChatThread,
    messageId: string,
    options: { readonly end: "done" | "rotating" }
  ) => Effect.Effect<{ readonly stopped: boolean }, ChatError>
}

/**
 * What an adapter package builds: the platform's ops, its descriptor and,
 * when the platform has one, its native stream.
 *
 * @stability unstable
 * @category models
 * @since 4.1.5
 */
export interface ChatAdapter extends Ops {
  readonly descriptor: Descriptor
  readonly nativeStream?: NativeStream | undefined
}

/**
 * Service that holds the adapters by platform. `Chat.layer` provides it.
 *
 * **Details**
 *
 * `get` fails with `NoAdapter` for a platform with no adapter registered.
 * Registering a second adapter for a platform replaces the first.
 *
 * @stability unstable
 * @category services
 * @since 4.1.5
 */
export class Registry extends Context.Service<Registry, {
  readonly register: (adapter: ChatAdapter) => Effect.Effect<void>
  readonly get: (platform: string) => Effect.Effect<ChatAdapter, ChatError>
  readonly descriptors: Effect.Effect<ReadonlyArray<Descriptor>>
}>()("effect/chat/ChatAdapter/Registry") {}

/**
 * Creates the layer that registers an adapter in the `Registry`.
 *
 * **When to use**
 *
 * Use when building an adapter package's layer. A platform that is off is a
 * layer left out.
 *
 * @stability unstable
 * @category layers
 * @since 4.1.5
 */
export const layer = <E, R>(
  adapter: Effect.Effect<ChatAdapter, E, R>
): Layer.Layer<never, E, Exclude<R, Scope.Scope> | Registry> =>
  Layer.effectDiscard(Effect.gen(function*() {
    const registry = yield* Registry
    yield* registry.register(yield* adapter)
  }))

/**
 * Fails with `TooLarge` when Markdown does not fit the descriptor's
 * `limits.messageLength`, measured with the descriptor's `measure`.
 *
 * **When to use**
 *
 * Use when implementing `post`, `edit` and `NativeStream.start` in an adapter,
 * so a message that is too long fails without a call to the platform.
 *
 * **Details**
 *
 * Pass the string the adapter is about to send, after escaping. For a
 * `measure` that counts what escaping adds, measuring the escaped string
 * gives the exact cost, so a post is neither refused when the platform would
 * take it nor passed when the platform would refuse it on length. Pass the
 * message's `actions` too, so they are measured with it.
 *
 * @stability unstable
 * @category validation
 * @since 4.1.5
 */
export const checkMessageLength = (
  descriptor: Descriptor,
  op: string,
  markdown: string,
  actions?: ReadonlyArray<Action> | undefined
): Effect.Effect<void, ChatError> =>
  descriptor.measure(markdown, actions ?? []) <= descriptor.limits.messageLength ? Effect.void : Effect.fail(
    new ChatError({
      platform: descriptor.platform,
      op,
      reason: new TooLarge({ subject: "text", detail: "message_too_long" })
    })
  )

const maxRetries = 3
const baseDelay = Duration.millis(500)

/**
 * Retries an adapter request with the policy adapters share.
 *
 * **Details**
 *
 * - Only failures whose retry value is `retry` are retried, up to three
 *   times. `uncertain` and `denied` failures are returned at once.
 * - The wait is the error's `retryAfter` when it has one, otherwise an
 *   exponential backoff from 500 milliseconds.
 * - Inside `Chat.withoutRetries` the request runs once.
 *
 * @stability unstable
 * @category error handling
 * @since 4.1.5
 */
export const retrySafe = <A, R>(effect: Effect.Effect<A, ChatError, R>): Effect.Effect<A, ChatError, R> =>
  Effect.flatMap(RetriesDisabled, (disabled) => {
    if (disabled) {
      return effect
    }
    const loop = (attempt: number): Effect.Effect<A, ChatError, R> =>
      Effect.catchIf(
        effect,
        (error) => error.retry === "retry" && attempt < maxRetries,
        (error) =>
          Effect.flatMap(
            Effect.sleep(error.retryAfter ?? Duration.times(baseDelay, 2 ** attempt)),
            () => loop(attempt + 1)
          )
      )
    return loop(0)
  })
