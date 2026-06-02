/**
 * Token counting and prompt truncation for AI integrations. A tokenizer is a
 * service because tokenization depends on the target model, provider, and
 * encoding rules rather than on Effect itself.
 *
 * **Mental model**
 *
 * {@link Tokenizer} provides two operations over prompt input: `tokenize`
 * converts a prompt into provider-specific token ids, and `truncate` keeps a
 * prompt within a token budget before it is sent to a model. Implementations
 * are usually provided by an AI provider package or by wrapping the tokenizer
 * used by the model.
 *
 * **Common tasks**
 *
 * - Count prompt tokens before choosing a model or request size
 * - Drop older conversation messages before a chat completion call
 * - Provide a custom tokenizer with {@link make} for tests or unsupported
 *   providers
 *
 * **Gotchas**
 *
 * - Token ids are model-specific. Counts from one tokenizer may not match
 *   another model's tokenizer.
 * - The `truncate` implementation produced by {@link make} keeps complete
 *   messages from the end of the prompt; it does not split a message to fit the
 *   remaining budget.
 * - Programs that access {@link Tokenizer} require a tokenizer service to be
 *   provided.
 *
 * **Example** (Providing a test tokenizer)
 *
 * ```ts
 * import { Effect } from "effect"
 * import { Tokenizer } from "effect/unstable/ai"
 *
 * const tokenizer = Tokenizer.make({
 *   tokenize: (prompt) =>
 *     Effect.succeed(prompt.content.map((_, index) => index))
 * })
 *
 * const program = Effect.gen(function*() {
 *   const service = yield* Tokenizer.Tokenizer
 *   const tokens = yield* service.tokenize("Count this prompt")
 *   return tokens.length
 * }).pipe(Effect.provideService(Tokenizer.Tokenizer, tokenizer))
 * ```
 *
 * @since 4.0.0
 */
import * as Context from "../../Context.ts"
import * as Effect from "../../Effect.ts"
import * as Predicate from "../../Predicate.ts"
import type * as AiError from "./AiError.ts"
import * as Prompt from "./Prompt.ts"

/**
 * Service tag for model tokenization services.
 *
 * **When to use**
 *
 * Use to access or provide model-specific token counting and prompt truncation
 * operations.
 *
 * **Details**
 *
 * This tag provides access to tokenization functionality throughout your
 * application, enabling token counting and prompt truncation capabilities.
 *
 * **Example** (Accessing the Tokenizer service)
 *
 * ```ts
 * import { Effect } from "effect"
 * import { Tokenizer } from "effect/unstable/ai"
 *
 * const useTokenizer = Effect.gen(function*() {
 *   const tokenizer = yield* Tokenizer.Tokenizer
 *   const tokens = yield* tokenizer.tokenize("Hello, world!")
 *   return tokens.length
 * })
 * ```
 *
 * @category tags
 * @since 4.0.0
 */
export class Tokenizer extends Context.Service<Tokenizer, Service>()(
  "effect/ai/Tokenizer"
) {}

/**
 * Tokenizer service interface providing text tokenization and truncation
 * operations.
 *
 * **Details**
 *
 * This interface defines the core operations for converting text to tokens and
 * managing content length within token limits for AI model compatibility.
 *
 * **Example** (Implementing a custom tokenizer)
 *
 * ```ts
 * import { Effect } from "effect"
 * import { Prompt } from "effect/unstable/ai"
 * import type { Tokenizer } from "effect/unstable/ai"
 *
 * const customTokenizer: Tokenizer.Service = {
 *   tokenize: (input) =>
 *     Effect.succeed(input.toString().split(" ").map((_, i) => i)),
 *   truncate: (input, maxTokens) =>
 *     Effect.succeed(Prompt.make(input.toString().slice(0, maxTokens * 5)))
 * }
 * ```
 *
 * @category models
 * @since 4.0.0
 */
export interface Service {
  /**
   * Converts text input into an array of token numbers.
   */
  readonly tokenize: (
    /**
     * The text input to tokenize.
     */
    input: Prompt.RawInput
  ) => Effect.Effect<Array<number>, AiError.AiError>
  /**
   * Truncates text input to fit within the specified token limit.
   */
  readonly truncate: (
    /**
     * The text input to truncate.
     */
    input: Prompt.RawInput,
    /**
     * Maximum number of tokens to retain.
     */
    tokens: number
  ) => Effect.Effect<Prompt.Prompt, AiError.AiError>
}

/**
 * Creates a Tokenizer service implementation from tokenization options.
 *
 * **Details**
 *
 * This function constructs a complete Tokenizer service by providing a
 * tokenization function. The service handles both tokenization and
 * truncation operations using the provided tokenizer.
 *
 * **Example** (Creating a word tokenizer)
 *
 * ```ts
 * import { Effect } from "effect"
 * import { Tokenizer } from "effect/unstable/ai"
 *
 * // Simple word-based tokenizer
 * const wordTokenizer = Tokenizer.make({
 *   tokenize: (prompt) =>
 *     Effect.succeed(
 *       prompt.content
 *         .flatMap((msg) =>
 *           typeof msg.content === "string"
 *             ? msg.content.split(" ")
 *             : msg.content.flatMap((part) =>
 *               part.type === "text" ? part.text.split(" ") : []
 *             )
 *         )
 *         .map((_, index) => index)
 *     )
 * })
 * ```
 *
 * @category constructors
 * @since 4.0.0
 */
export const make = (options: {
  readonly tokenize: (content: Prompt.Prompt) => Effect.Effect<Array<number>, AiError.AiError>
}): Service =>
  Tokenizer.of({
    tokenize(input) {
      return options.tokenize(Prompt.make(input))
    },
    truncate(input, tokens) {
      return truncate(Prompt.make(input), options.tokenize, tokens)
    }
  })

const truncate = (
  self: Prompt.Prompt,
  tokenize: (input: Prompt.Prompt) => Effect.Effect<Array<number>, AiError.AiError>,
  maxTokens: number
): Effect.Effect<Prompt.Prompt, AiError.AiError> =>
  Effect.suspend(() => {
    let count = 0
    let inputMessages = self.content
    let outputMessages: Array<Prompt.Message> = []
    const loop: Effect.Effect<Prompt.Prompt, AiError.AiError> = Effect.suspend(() => {
      const message = inputMessages[inputMessages.length - 1]
      if (Predicate.isUndefined(message)) {
        return Effect.succeed(Prompt.fromMessages(outputMessages))
      }
      inputMessages = inputMessages.slice(0, inputMessages.length - 1)
      return Effect.flatMap(tokenize(Prompt.fromMessages([message])), (tokens) => {
        count += tokens.length
        if (count > maxTokens) {
          return Effect.succeed(Prompt.fromMessages(outputMessages))
        }
        outputMessages = [message, ...outputMessages]
        return loop
      })
    })
    return loop
  })
