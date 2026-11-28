/**
 * The service a consumer provides to receive chat events.
 *
 * Adapters take the `ChatHandler` service from context and call `handle` for
 * every inbound event. The contract is "accept, fast": success means the event
 * is the consumer's. The platform can still deliver it again, so drop
 * repeats with `ChatEvent.dedupeKey`.
 *
 * @stability unstable
 * @since 4.1.5
 */
import * as Context from "../Context.ts"
import * as Effect from "../Effect.ts"
import * as Layer from "../Layer.ts"
import * as Schema from "../Schema.ts"
import type * as Scope from "../Scope.ts"
import type { ChatEvent } from "./ChatEvent.ts"

/**
 * Error for an event that was not accepted.
 *
 * **Details**
 *
 * A handler fails with it to refuse an event, and an adapter's entry point
 * fails with it when it could not finish normalising one. Slack answers 503 so
 * the event is redelivered; the Discord gateway layer drops it.
 *
 * **Gotchas**
 *
 * It has no fields, so whoever raises it logs the reason first.
 *
 * @stability unstable
 * @category errors
 * @since 4.1.5
 */
export class NotAccepted extends Schema.TaggedError<NotAccepted>("effect/chat/ChatHandler/NotAccepted")(
  "NotAccepted",
  {}
) {}

/**
 * Service that receives inbound chat events, provided by the consumer.
 *
 * **Details**
 *
 * Adapters take the service and call `handle`. Success hands the event to the
 * consumer, and `NotAccepted` refuses it. Success does not stop the platform
 * from delivering the event again: delivery is at-least-once.
 *
 * **Gotchas**
 *
 * Forking the work and returning loses events on a crash. How durable an
 * accepted event is belongs to the consumer.
 *
 * @see {@link layer} for the only constructor
 *
 * @stability unstable
 * @category services
 * @since 4.1.5
 */
export class ChatHandler extends Context.Service<ChatHandler, {
  readonly handle: (event: ChatEvent) => Effect.Effect<void, NotAccepted>
}>()("effect/chat/ChatHandler") {}

/**
 * Creates the `ChatHandler` layer from a function that handles one event.
 *
 * **Details**
 *
 * - The bot's own messages are dropped before `handle` runs, unless
 *   `deliverSelf` is `true`. Other bots' messages are delivered, flagged with
 *   `author.isBot`.
 * - Every event runs in a `ChatHandler.handle` span and its own `Scope`.
 *
 * @stability unstable
 * @category layers
 * @since 4.1.5
 */
export const layer = <R>(
  handle: (event: ChatEvent) => Effect.Effect<void, NotAccepted, R>,
  options?: { readonly deliverSelf?: boolean | undefined }
): Layer.Layer<ChatHandler, never, Exclude<R, Scope.Scope>> =>
  Layer.effect(
    ChatHandler,
    Effect.contextWith((context: Context.Context<Exclude<R, Scope.Scope>>) => {
      const deliverSelf = options?.deliverSelf === true
      return Effect.succeed(ChatHandler.of({
        handle: (event) => {
          if (!deliverSelf && event._tag === "MessageCreated" && event.message.author.isSelf) {
            return Effect.void
          }
          return handle(event).pipe(
            Effect.scoped,
            Effect.provideContext(context),
            Effect.withSpan("ChatHandler.handle", {
              attributes: { "chat.platform": event.thread.platform, "chat.op": "handle" }
            })
          )
        }
      }))
    })
  )
