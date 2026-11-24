/**
 * The routed outbound chat service.
 *
 * `Chat` has the ops of every registered adapter and routes each call by the
 * address's platform. `Chat.layer` provides the router and an empty
 * `ChatAdapter.Registry`; adapter layers stack on top with
 * `Layer.provideMerge`, and a platform that is off is a layer left out.
 *
 * **Example** (Posting through the router)
 *
 * ```ts
 * import { Effect } from "effect"
 * import { Chat, ChatThread } from "effect/chat"
 *
 * const program = Effect.gen(function*() {
 *   const chat = yield* Chat.Chat
 *   const posted = yield* chat.post(ChatThread.make("slack", "T1/C1"), { markdown: "Hello" })
 *   return posted.id
 * })
 * ```
 *
 * @stability unstable
 * @since 4.1.5
 */
import * as Context from "../Context.ts"
import * as Effect from "../Effect.ts"
import * as Layer from "../Layer.ts"
import * as Stream from "../Stream.ts"
import type { ChatAdapter, Descriptor, Ops, User } from "./ChatAdapter.ts"
import { Registry } from "./ChatAdapter.ts"
import { ChatError, NoAdapter } from "./ChatError.ts"
import type { ChatThread } from "./ChatThread.ts"
import { RetriesDisabled } from "./internal/retries.ts"

/**
 * Service that routes chat operations to the adapter registered for each
 * address's platform.
 *
 * **Details**
 *
 * - Every op takes an address and goes to the adapter for
 *   `thread.platform`, failing with `NoAdapter` when there is none.
 * - `getUser` takes the platform first, because a bare user id names none.
 * - `followUp` is routed by the platform of the deferred command's thread.
 *   One call per deferral is the portable contract: the first is the
 *   answer, and a second is platform-specific, a new message on Slack (up to
 *   five) and an overwrite of the first on Discord. It is rendered as
 *   `respond` is, so it never mentions anyone: Slack shows the token as
 *   text and Discord renders it and notifies nobody.
 * - `descriptor` returns a platform's capabilities and limits.
 * - Each call runs in a `Chat.{op}` span whose attributes are the platform, the
 *   op and, on failure, the error reason and retry value.
 *
 * @stability unstable
 * @category services
 * @since 4.1.5
 */
export class Chat extends Context.Service<
  Chat,
  Omit<Ops, "getUser"> & {
    readonly getUser: (
      platform: string,
      id: string,
      options?: { readonly in?: ChatThread | undefined }
    ) => Effect.Effect<User, ChatError>
    readonly descriptor: (platform: string) => Effect.Effect<Descriptor, ChatError>
  }
>()("effect/chat/Chat") {}

const spanAttributes = (platform: string, op: string) => ({ "chat.platform": platform, "chat.op": op })

const annotateFailure = (error: ChatError) =>
  Effect.annotateCurrentSpan({ "chat.error.reason": error.reason._tag, "chat.error.retry": error.retry })

const make = Effect.sync(() => {
  const adapters = new Map<string, ChatAdapter>()

  const lookup = (platform: string, op: string): Effect.Effect<ChatAdapter, ChatError> =>
    Effect.suspend(() => {
      const adapter = adapters.get(platform)
      return adapter === undefined
        ? Effect.fail(new ChatError({ platform, op, reason: new NoAdapter({}) }))
        : Effect.succeed(adapter)
    })

  const route = <A>(
    platform: string,
    op: string,
    f: (adapter: ChatAdapter) => Effect.Effect<A, ChatError>
  ): Effect.Effect<A, ChatError> =>
    lookup(platform, op).pipe(
      Effect.flatMap(f),
      Effect.tapError(annotateFailure),
      Effect.withSpan(`Chat.${op}`, { attributes: spanAttributes(platform, op) })
    )

  const routeStream = <A>(
    platform: string,
    op: string,
    f: (adapter: ChatAdapter) => Stream.Stream<A, ChatError>
  ): Stream.Stream<A, ChatError> =>
    Stream.unwrap(Effect.map(lookup(platform, op), f)).pipe(
      Stream.tapError(annotateFailure),
      Stream.withSpan(`Chat.${op}`, { attributes: spanAttributes(platform, op) })
    )

  const registry = Registry.of({
    register: (adapter) => Effect.sync(() => void adapters.set(adapter.descriptor.platform, adapter)),
    get: (platform) => lookup(platform, "get"),
    descriptors: Effect.sync(() => Array.from(adapters.values(), (adapter) => adapter.descriptor))
  })

  const chat = Chat.of({
    post: (thread, content) => route(thread.platform, "post", (adapter) => adapter.post(thread, content)),
    edit: (thread, messageId, content) =>
      route(thread.platform, "edit", (adapter) => adapter.edit(thread, messageId, content)),
    delete: (thread, messageId) => route(thread.platform, "delete", (adapter) => adapter.delete(thread, messageId)),
    fetchMessage: (thread, messageId) =>
      route(thread.platform, "fetchMessage", (adapter) => adapter.fetchMessage(thread, messageId)),
    history: (thread, options) =>
      routeStream(thread.platform, "history", (adapter) => adapter.history(thread, options)),
    download: (thread, attachment, options) =>
      routeStream(thread.platform, "download", (adapter) => adapter.download(thread, attachment, options)),
    startThread: (thread, messageId, options) =>
      route(thread.platform, "startThread", (adapter) => adapter.startThread(thread, messageId, options)),
    getThread: (thread) => route(thread.platform, "getThread", (adapter) => adapter.getThread(thread)),
    opener: (thread) => route(thread.platform, "opener", (adapter) => adapter.opener(thread)),
    getUser: (platform, id, options) => route(platform, "getUser", (adapter) => adapter.getUser(id, options)),
    followUp: (deferred, content) =>
      route(deferred.command.thread.platform, "followUp", (adapter) => adapter.followUp(deferred, content)),
    descriptor: (platform) => route(platform, "descriptor", (adapter) => Effect.succeed(adapter.descriptor))
  })

  return Context.make(Registry, registry).pipe(Context.add(Chat, chat))
})

/**
 * Layer that provides the `Chat` router and an empty `ChatAdapter.Registry`.
 *
 * **When to use**
 *
 * Use as the base of a chat setup. Adapter layers go on top with
 * `Layer.provideMerge`.
 *
 * @stability unstable
 * @category layers
 * @since 4.1.5
 */
export const layer: Layer.Layer<Chat | Registry> = Layer.effectContext(make)

/**
 * Runs an effect with adapter retries turned off, so every adapter call inside
 * it makes one attempt.
 *
 * **Gotchas**
 *
 * The name is provisional.
 *
 * @stability unstable
 * @category combinators
 * @since 4.1.5
 */
export const withoutRetries = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
  Effect.provideService(effect, RetriesDisabled, true)
