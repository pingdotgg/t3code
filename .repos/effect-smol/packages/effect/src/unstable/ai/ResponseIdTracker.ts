/**
 * Track provider response IDs for incremental language model calls.
 *
 * Some providers can continue from a prior response by accepting a
 * `previousResponseId` plus only the messages added after that response. This
 * module exposes a small mutable service that remembers which prompt message
 * objects were included in each provider response and prepares a shorter prompt
 * when a later call extends the same conversation.
 *
 * **Mental model**
 *
 * The tracker is an optimization cache, not conversation storage. `markParts`
 * associates the exact message objects that were sent with the response ID the
 * provider returned. `prepareUnsafe` scans a future prompt, finds the latest
 * assistant-message boundary whose prefix is tracked, and returns that response
 * ID with only the messages after the boundary. If the prompt cannot be matched
 * safely, the cache is cleared and no incremental send is attempted.
 *
 * **Common tasks**
 *
 * - Provide `ResponseIdTracker` to a language model implementation that can use
 *   provider previous-response IDs
 * - Mark prompt messages after a successful provider response
 * - Prepare follow-up prompts so unchanged history is replaced by
 *   `previousResponseId`
 *
 * **Gotchas**
 *
 * - Tracking is based on object identity; equivalent message values are not
 *   recognized unless they are the same objects.
 * - The service is mutable and intentionally exposes `Unsafe` methods because
 *   callers coordinate it inside provider request/response code.
 * - A mismatch clears tracked state to avoid reusing a response ID for the
 *   wrong prompt prefix.
 *
 * @since 4.0.0
 */
import * as Context from "../../Context.ts"
import * as Effect from "../../Effect.ts"
import * as Option from "../../Option.ts"
import * as Prompt from "./Prompt.ts"

/**
 * Result returned when a tracked prompt can be sent incrementally.
 *
 * **Details**
 *
 * It contains the provider response ID to pass as `previousResponseId` and the
 * prompt fragment containing only the new messages after the latest assistant
 * turn.
 *
 * @category models
 * @since 4.0.0
 */
export interface PrepareResult {
  readonly previousResponseId: string
  readonly prompt: Prompt.Prompt
}

/**
 * Mutable service that tracks prompt message object identities by provider
 * response ID.
 *
 * **Details**
 *
 * `markParts` records the prompt messages that produced a response,
 * `prepareUnsafe` returns a `previousResponseId` plus the untracked suffix when
 * the prompt prefix is fully recognized, and `clearUnsafe` drops all tracked
 * state.
 *
 * @category models
 * @since 4.0.0
 */
export interface Service {
  clearUnsafe(): void
  markParts(parts: ReadonlyArray<object>, responseId: string): void
  prepareUnsafe(prompt: Prompt.Prompt): Option.Option<PrepareResult>
}

/**
 * Service tag for enabling provider previous-response ID reuse across language
 * model calls.
 *
 * **When to use**
 *
 * Use when when provided, language model operations can use the tracker to send only new
 * prompt messages together with the provider's prior response ID.
 *
 * @category services
 * @since 4.0.0
 */
export class ResponseIdTracker extends Context.Service<ResponseIdTracker, Service>()("effect/ai/ResponseIdTracker") {}

/**
 * Creates an in-memory `ResponseIdTracker` service.
 *
 * **Details**
 *
 * The tracker maps prompt message object identities to provider response IDs.
 * `prepareUnsafe` returns a previous response ID and the messages after the
 * latest assistant turn only when the existing prompt prefix is fully tracked;
 * otherwise it clears the tracked state and returns `Option.none()`.
 *
 * @category constructors
 * @since 4.0.0
 */
export const make: Effect.Effect<Service> = Effect.sync(() => {
  const sentParts = new Map<object, string>()

  const none = () => {
    sentParts.clear()
    return Option.none<PrepareResult>()
  }

  return {
    clearUnsafe() {
      sentParts.clear()
    },
    markParts(parts, responseId) {
      for (let i = 0; i < parts.length; i++) {
        sentParts.set(parts[i], responseId)
      }
    },
    prepareUnsafe(prompt) {
      const messages = prompt.content

      let anyTracked = false
      for (let i = 0; i < messages.length; i++) {
        if (sentParts.has(messages[i])) {
          anyTracked = true
          break
        }
      }
      if (!anyTracked) return none()

      let lastAssistantIndex = -1
      for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].role === "assistant") {
          lastAssistantIndex = i
          break
        }
      }
      if (lastAssistantIndex === -1) return none()

      let responseId: string | undefined
      for (let i = 0; i < lastAssistantIndex; i++) {
        const id = sentParts.get(messages[i])
        if (id === undefined) return none()
        responseId = id
      }
      if (responseId === undefined) return none()

      const partsAfterLastAssistant = messages.slice(lastAssistantIndex + 1)
      if (partsAfterLastAssistant.length === 0) {
        return none()
      }

      return Option.some({
        previousResponseId: responseId,
        prompt: Prompt.fromMessages(partsAfterLastAssistant)
      })
    }
  }
})
