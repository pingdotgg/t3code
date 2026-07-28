/**
 * Stateful conversation sessions on top of a language model.
 *
 * A `Chat` keeps `Prompt` history in a `Ref` and reuses it for text generation,
 * streaming, and structured output. Each generation call combines the current
 * history with the caller's new prompt, invokes the active language model, and
 * appends the response parts back into history. Constructors create fresh
 * sessions, seed sessions from prompts, restore exported history, or connect a
 * chat to persistence.
 *
 * @since 4.0.0
 */
import * as Channel from "../../Channel.ts"
import * as Chunk from "../../Chunk.ts"
import * as Context from "../../Context.ts"
import * as Duration from "../../Duration.ts"
import * as Effect from "../../Effect.ts"
import * as Layer from "../../Layer.ts"
import * as Option from "../../Option.ts"
import * as Predicate from "../../Predicate.ts"
import * as Ref from "../../Ref.ts"
import * as Schema from "../../Schema.ts"
import * as Semaphore from "../../Semaphore.ts"
import * as Stream from "../../Stream.ts"
import type { NoExcessProperties } from "../../Types.ts"
import type { PersistenceError } from "../persistence/Persistence.ts"
import { BackingPersistence } from "../persistence/Persistence.ts"
import * as AiError from "./AiError.ts"
import * as IdGenerator from "./IdGenerator.ts"
import * as LanguageModel from "./LanguageModel.ts"
import * as Prompt from "./Prompt.ts"
import type * as Response from "./Response.ts"
import type * as Tool from "./Tool.ts"

/**
 * Service tag for stateful AI conversation sessions.
 *
 * **When to use**
 *
 * Use to access or provide conversational AI sessions through the Effect
 * context.
 *
 * **Details**
 *
 * This tag provides access to chat functionality throughout your application,
 * enabling persistent conversational AI interactions with full context
 * management.
 *
 * **Example** (Accessing the Chat service)
 *
 * ```ts
 * import { Effect } from "effect"
 * import { Chat } from "effect/unstable/ai"
 *
 * const program = Effect.gen(function*() {
 *   const chat = yield* Chat.empty
 *   const response = yield* chat.generateText({
 *     prompt: "Explain quantum computing in simple terms"
 *   })
 *   return response.content
 * })
 * ```
 *
 * @category services
 * @since 4.0.0
 */
export class Chat extends Context.Service<Chat, Service>()(
  "effect/ai/Chat"
) {}

/**
 * Represents the interface that the `Chat` service provides.
 *
 * **When to use**
 *
 * Use as the service contract for code that receives or constructs a stateful
 * chat session and needs history, export, text generation, streaming, and
 * structured-output operations.
 *
 * @see {@link Chat} for the context tag that provides this service
 * @see {@link Persisted} for the persistence-backed extension
 *
 * @category models
 * @since 4.0.0
 */
export interface Service {
  /**
   * Reference to the chat history.
   *
   * **Details**
   *
   * Provides direct access to the conversation history for advanced use cases
   * like custom history manipulation or inspection.
   *
   * **Example** (Inspecting chat history)
   *
   * ```ts
   * import { Effect, Ref } from "effect"
   * import { Chat } from "effect/unstable/ai"
   *
   * const inspectHistory = Effect.gen(function*() {
   *   const chat = yield* Chat.empty
   *   const currentHistory = yield* Ref.get(chat.history)
   *   console.log("Current conversation:", currentHistory)
   *   return currentHistory
   * })
   * ```
   */
  readonly history: Ref.Ref<Prompt.Prompt>

  /**
   * Exports the chat history into a structured format.
   *
   * **Details**
   *
   * Returns the complete conversation history as a structured object
   * that can be stored, transmitted, or processed by other systems.
   *
   * **Example** (Exporting chat history)
   *
   * ```ts
   * import { Effect } from "effect"
   * import { Chat } from "effect/unstable/ai"
   *
   * const saveChat = Effect.gen(function*() {
   *   const chat = yield* Chat.empty
   *   yield* chat.generateText({ prompt: "Hello!" })
   *
   *   const exportedData = yield* chat.export
   *
   *   // Save to database or file system
   *   return exportedData
   * })
   * ```
   */
  readonly export: Effect.Effect<unknown, AiError.AiError>

  /**
   * Exports the chat history as a JSON string.
   *
   * **Details**
   *
   * Provides a convenient way to serialize the entire conversation
   * for storage or transmission in JSON format.
   *
   * **Example** (Exporting chat history as JSON)
   *
   * ```ts
   * import { Effect } from "effect"
   * import { Chat } from "effect/unstable/ai"
   *
   * const backupChat = Effect.gen(function*() {
   *   const chat = yield* Chat.empty
   *
   *   yield* chat.generateText({ prompt: "Explain photosynthesis" })
   *
   *   const jsonBackup = yield* chat.exportJson
   *
   *   yield* Effect.sync(() => localStorage.setItem("chat-backup", jsonBackup))
   *
   *   return jsonBackup
   * })
   * ```
   */
  readonly exportJson: Effect.Effect<string, AiError.AiError>

  /**
   * Generate text using a language model for the specified prompt.
   *
   * **Details**
   *
   * If a toolkit is specified, the language model will have access to tools
   * for function calling and enhanced capabilities. Both input and output
   * messages are automatically added to the chat history.
   *
   * **Example** (Generating chat responses)
   *
   * ```ts
   * import { Effect } from "effect"
   * import { Chat } from "effect/unstable/ai"
   *
   * const chatWithAI = Effect.gen(function*() {
   *   const chat = yield* Chat.empty
   *
   *   const response1 = yield* chat.generateText({
   *     prompt: "What is the capital of France?"
   *   })
   *
   *   const response2 = yield* chat.generateText({
   *     prompt: "What's the population of that city?"
   *   })
   *
   *   return [response1.content, response2.content]
   * })
   * ```
   */
  readonly generateText: {
    <Options extends NoExcessProperties<LanguageModel.GenerateTextOptions<{}>, Options>>(
      options: Options & { readonly toolkit?: undefined } & LanguageModel.GenerateTextOptions<{}>
    ): Effect.Effect<
      LanguageModel.GenerateTextResponse<{}>,
      LanguageModel.ExtractError<Options>,
      LanguageModel.LanguageModel | LanguageModel.ExtractServices<Options>
    >
    <
      Tools extends Record<string, Tool.Any>,
      Options extends NoExcessProperties<
        LanguageModel.GenerateTextOptions<Tools> & { readonly toolkit: LanguageModel.ToolkitInput<Tools> },
        Options
      >
    >(
      options: Options & LanguageModel.GenerateTextOptions<Tools> & {
        readonly toolkit: LanguageModel.ToolkitInput<Tools>
      }
    ): Effect.Effect<
      LanguageModel.GenerateTextResponse<Tools>,
      LanguageModel.ExtractError<Options>,
      LanguageModel.LanguageModel | LanguageModel.ExtractServices<Options>
    >
    <
      Options extends {
        readonly toolkit: LanguageModel.ToolkitOption<any>
      } & NoExcessProperties<LanguageModel.GenerateTextOptions<any>, Options>
    >(
      options: Options & LanguageModel.GenerateTextOptions<LanguageModel.ExtractTools<Options>> & {
        readonly toolkit: Options["toolkit"]
      }
    ): Effect.Effect<
      LanguageModel.GenerateTextResponse<LanguageModel.ExtractTools<Options>>,
      LanguageModel.ExtractError<Options>,
      LanguageModel.LanguageModel | LanguageModel.ExtractServices<Options>
    >
  }

  /**
   * Generate text using a language model with streaming output.
   *
   * **Details**
   *
   * Returns a stream of response parts that are emitted as soon as they're
   * available from the model. Supports tool calling and maintains chat history.
   *
   * **Example** (Streaming chat responses)
   *
   * ```ts
   * import { Effect, Stream } from "effect"
   * import { Chat } from "effect/unstable/ai"
   *
   * const streamingChat = Effect.gen(function*() {
   *   const chat = yield* Chat.empty
   *
   *   const stream = yield* chat.streamText({
   *     prompt: "Write a short story about space exploration"
   *   })
   *
   *   yield* Stream.runForEach(stream, (part) =>
   *     part.type === "text-delta"
   *       ? Effect.sync(() => process.stdout.write(part.delta))
   *       : Effect.void)
   * })
   * ```
   */
  readonly streamText: {
    <Options extends NoExcessProperties<LanguageModel.GenerateTextOptions<{}>, Options>>(
      options: Options & { readonly toolkit?: undefined } & LanguageModel.GenerateTextOptions<{}>
    ): Stream.Stream<
      Response.StreamPart<{}>,
      LanguageModel.ExtractError<Options>,
      LanguageModel.LanguageModel | LanguageModel.ExtractServices<Options>
    >
    <
      Tools extends Record<string, Tool.Any>,
      Options extends NoExcessProperties<
        LanguageModel.GenerateTextOptions<Tools> & { readonly toolkit: LanguageModel.ToolkitInput<Tools> },
        Options
      >
    >(
      options: Options & LanguageModel.GenerateTextOptions<Tools> & {
        readonly toolkit: LanguageModel.ToolkitInput<Tools>
      }
    ): Stream.Stream<
      Response.StreamPart<Tools>,
      LanguageModel.ExtractError<Options>,
      LanguageModel.LanguageModel | LanguageModel.ExtractServices<Options>
    >
    <
      Options extends {
        readonly toolkit: LanguageModel.ToolkitOption<any>
      } & NoExcessProperties<LanguageModel.GenerateTextOptions<any>, Options>
    >(
      options: Options & LanguageModel.GenerateTextOptions<LanguageModel.ExtractTools<Options>> & {
        readonly toolkit: Options["toolkit"]
      }
    ): Stream.Stream<
      Response.StreamPart<LanguageModel.ExtractTools<Options>>,
      LanguageModel.ExtractError<Options>,
      LanguageModel.LanguageModel | LanguageModel.ExtractServices<Options>
    >
  }

  /**
   * Generate a structured object using a language model and schema.
   *
   * **Details**
   *
   * Forces the model to return data that conforms to the specified schema,
   * enabling structured data extraction and type-safe responses. The
   * conversation history is maintained across calls.
   *
   * **Example** (Generating structured objects)
   *
   * ```ts
   * import { Effect, Schema } from "effect"
   * import { Chat } from "effect/unstable/ai"
   *
   * const ContactSchema = Schema.Struct({
   *   name: Schema.String,
   *   email: Schema.String,
   *   phone: Schema.optional(Schema.String)
   * })
   *
   * const extractContact = Effect.gen(function*() {
   *   const chat = yield* Chat.empty
   *
   *   const contact = yield* chat.generateObject({
   *     prompt: "Extract contact info: John Doe, john@example.com, 555-1234",
   *     schema: ContactSchema
   *   })
   *
   *   console.log(contact.object)
   *   // { name: "John Doe", email: "john@example.com", phone: "555-1234" }
   *
   *   return contact.object
   * })
   * ```
   */
  readonly generateObject: <
    ObjectEncoded extends Record<string, any>,
    ObjectSchema extends Schema.Encoder<ObjectEncoded, unknown>,
    Options extends NoExcessProperties<LanguageModel.GenerateObjectOptions<any, ObjectSchema>, Options>
  >(
    options: Options & LanguageModel.GenerateObjectOptions<LanguageModel.ExtractTools<Options>, ObjectSchema>
  ) => Effect.Effect<
    LanguageModel.GenerateObjectResponse<LanguageModel.ExtractTools<Options>, ObjectSchema["Type"]>,
    LanguageModel.ExtractError<Options>,
    LanguageModel.ExtractServices<Options> | ObjectSchema["DecodingServices"] | LanguageModel.LanguageModel
  >
}

const decodeHistory = Schema.decodeUnknownEffect(Prompt.Prompt)
const encodeHistory = Schema.encodeUnknownEffect(Prompt.Prompt)
const decodeHistoryJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Prompt.Prompt))
const encodeHistoryJson = Schema.encodeUnknownEffect(Schema.fromJsonString(Prompt.Prompt))

// =============================================================================
// Constructors
// =============================================================================

const makeUnsafe = (history: Ref.Ref<Prompt.Prompt>) => {
  const semaphore = Semaphore.makeUnsafe(1)

  return Chat.of({
    history,
    export: Ref.get(history).pipe(
      Effect.flatMap(encodeHistory),
      Effect.catchTag("SchemaError", (error) =>
        Effect.fail(AiError.make({
          module: "Chat",
          method: "export",
          reason: AiError.InvalidOutputError.fromSchemaError(error)
        }))),
      Effect.withSpan("Chat.export")
    ),
    exportJson: Ref.get(history).pipe(
      Effect.flatMap(encodeHistoryJson),
      Effect.catchTag("SchemaError", (error) =>
        Effect.fail(AiError.make({
          module: "Chat",
          method: "exportJson",
          reason: AiError.InvalidOutputError.fromSchemaError(error)
        }))),
      Effect.withSpan("Chat.exportJson")
    ),
    generateText: Effect.fnUntraced(
      function*(options) {
        const newPrompt = Prompt.make(options.prompt)
        const oldPrompt = yield* Ref.get(history)
        const prompt = Prompt.concat(oldPrompt, newPrompt)

        const response = yield* LanguageModel.generateText({ ...options, prompt })

        const newHistory = Prompt.concat(prompt, Prompt.fromResponseParts(response.content))
        yield* Ref.set(history, newHistory)

        return response
      },
      semaphore.withPermits(1),
      (effect) => Effect.withSpan(effect, "Chat.generateText", { captureStackTrace: false })
    ) as Service["generateText"],
    streamText: Effect.fnUntraced(
      function*(options) {
        let parts = Chunk.empty<Response.AnyPart>()
        return Stream.fromChannel(Channel.acquireUseRelease(
          semaphore.take(1).pipe(
            Effect.flatMap(() => Ref.get(history)),
            Effect.map((history) => Prompt.concat(history, Prompt.make(options.prompt)))
          ),
          (prompt) =>
            LanguageModel.streamText({ ...options, prompt }).pipe(
              Stream.mapArray((chunk) => {
                parts = Chunk.appendAll(parts, Chunk.fromArrayUnsafe(chunk))
                return chunk
              }),
              Stream.toChannel
            ),
          (prompt) =>
            Effect.andThen(
              Ref.set(
                history,
                Prompt.concat(prompt, Prompt.fromResponseParts(Array.from(parts)))
              ),
              semaphore.release(1)
            )
        )).pipe(
          Stream.withSpan("Chat.streamText", {
            captureStackTrace: false
          })
        )
      },
      Stream.unwrap
    ) as Service["streamText"],
    generateObject: Effect.fnUntraced(
      function*(options) {
        const newPrompt = Prompt.make(options.prompt)
        const oldPrompt = yield* Ref.get(history)
        const prompt = Prompt.concat(oldPrompt, newPrompt)

        const response = yield* LanguageModel.generateObject({ ...options, prompt })

        const newHistory = Prompt.concat(prompt, Prompt.fromResponseParts(response.content))
        yield* Ref.set(history, newHistory)

        return response
      },
      semaphore.withPermits(1),
      (effect, options) =>
        Effect.withSpan(effect, "Chat.generateObject", {
          attributes: {
            objectName: LanguageModel.getObjectName(options.objectName, options.schema)
          },
          captureStackTrace: false
        })
    )
  })
}

/**
 * Creates a new Chat service with empty conversation history.
 *
 * **When to use**
 *
 * Use when you need to start a fresh chat session without initial context or
 * system prompts.
 *
 * **Example** (Creating an empty chat)
 *
 * ```ts
 * import { Effect } from "effect"
 * import { Chat } from "effect/unstable/ai"
 *
 * const freshChat = Effect.gen(function*() {
 *   const chat = yield* Chat.empty
 *
 *   const response = yield* chat.generateText({
 *     prompt: "Hello! Can you introduce yourself?"
 *   })
 *
 *   console.log(response.content)
 *
 *   return chat
 * })
 * ```
 *
 * @category constructors
 * @since 4.0.0
 */
export const empty: Effect.Effect<Service> = Effect.sync(() => makeUnsafe(Ref.makeUnsafe(Prompt.empty)))

/**
 * Creates a new Chat service from an initial prompt.
 *
 * **Details**
 *
 * This is the primary constructor for creating chat instances. It initializes
 * a new conversation with the provided prompt as the starting context.
 *
 * **Example** (Creating a chat from a system prompt)
 *
 * ```ts
 * import { Effect } from "effect"
 * import { Chat } from "effect/unstable/ai"
 *
 * const chatWithSystemPrompt = Effect.gen(function*() {
 *   const chat = yield* Chat.fromPrompt([{
 *     role: "system",
 *     content: "You are a helpful assistant specialized in mathematics."
 *   }])
 *
 *   const response = yield* chat.generateText({
 *     prompt: "What is 2+2?"
 *   })
 *
 *   return response.content
 * })
 * ```
 *
 * **Example** (Restoring chat history from a prompt)
 *
 * ```ts
 * import { Effect } from "effect"
 * import { Chat } from "effect/unstable/ai"
 *
 * // Initialize with conversation history
 * const existingChat = Effect.gen(function*() {
 *   const chat = yield* Chat.fromPrompt([
 *     {
 *       role: "user",
 *       content: [{ type: "text", text: "What's the weather like?" }]
 *     },
 *     {
 *       role: "assistant",
 *       content: [{ type: "text", text: "I don't have access to weather data." }]
 *     },
 *     {
 *       role: "user",
 *       content: [{ type: "text", text: "Can you help me with coding?" }]
 *     }
 *   ])
 *
 *   const response = yield* chat.generateText({
 *     prompt: "I need help with TypeScript"
 *   })
 *
 *   return response
 * })
 * ```
 *
 * @category constructors
 * @since 4.0.0
 */
export const fromPrompt = (prompt: Prompt.RawInput) =>
  Effect.sync(() => makeUnsafe(Ref.makeUnsafe(Prompt.make(prompt))))

/**
 * Creates a Chat service from previously exported chat data.
 *
 * **Details**
 *
 * Restores a chat session from structured data that was previously exported
 * using the `export` method. Useful for persisting and restoring conversation
 * state.
 *
 * **Example** (Restoring chat data)
 *
 * ```ts
 * import { Effect, Ref } from "effect"
 * import { Chat } from "effect/unstable/ai"
 *
 * const restoreChat = Effect.gen(function*() {
 *   const originalChat = yield* Chat.fromPrompt([
 *     {
 *       role: "user",
 *       content: "Which library are we using?"
 *     },
 *     {
 *       role: "assistant",
 *       content: "The project uses Effect."
 *     }
 *   ])
 *
 *   const exported = yield* originalChat.export
 *   const restoredChat = yield* Chat.fromExport(exported)
 *   const restoredHistory = yield* Ref.get(restoredChat.history)
 *
 *   console.log(restoredHistory.content.map((message) => message.role))
 *   // ["user", "assistant"]
 *
 *   const restoredResponse = restoredHistory.content[1]
 *   if (restoredResponse?.role === "assistant") {
 *     const restoredText = restoredResponse.content[0]
 *     if (restoredText?.type === "text") {
 *       console.log(restoredText.text)
 *       // "The project uses Effect."
 *     }
 *   }
 * })
 * ```
 *
 * @category constructors
 * @since 4.0.0
 */
export const fromExport = (data: unknown): Effect.Effect<
  Service,
  Schema.SchemaError
> => Effect.flatMap(decodeHistory(data), fromPrompt)

/**
 * Creates a Chat service from previously exported JSON chat data.
 *
 * **Details**
 *
 * Restores a chat session from JSON string that was previously exported
 * using the `exportJson` method. This is the most convenient way to
 * persist and restore chat sessions to/from storage systems.
 *
 * **Example** (Restoring chat history from JSON)
 *
 * ```ts
 * import { Effect } from "effect"
 * import { Chat } from "effect/unstable/ai"
 *
 * const restoreFromJson = Effect.gen(function*() {
 *   // Load JSON from localStorage or file system
 *   const jsonData = localStorage.getItem("my-chat-backup")
 *   if (!jsonData) return yield* Chat.empty
 *
 *   const restoredChat = yield* Chat.fromJson(jsonData)
 *
 *   // Chat history is now restored
 *   const response = yield* restoredChat.generateText({
 *     prompt: "What were we talking about?"
 *   })
 *
 *   return response
 * }).pipe(
 *   Effect.catchTag("SchemaError", (error) => {
 *     console.log("Invalid JSON format:", error.message)
 *     return Chat.empty // Fallback to empty chat
 *   })
 * )
 * ```
 *
 * @category constructors
 * @since 4.0.0
 */
export const fromJson = (data: string): Effect.Effect<
  Service,
  Schema.SchemaError
> => Effect.flatMap(decodeHistoryJson(data), fromPrompt)

// =============================================================================
// Chat Persistence
// =============================================================================

/**
 * Represents an error that occurs when attempting to retrieve a persisted `Chat` that
 * does not exist in the backing persistence store.
 *
 * **When to use**
 *
 * Use to represent a missing persisted conversation when lookup by id cannot
 * find stored history.
 *
 * @category errors
 * @since 4.0.0
 */
export class ChatNotFoundError extends Schema.ErrorClass<ChatNotFoundError>(
  "effect/ai/Chat/ChatNotFoundError"
)({
  _tag: Schema.tag("ChatNotFoundError"),
  chatId: Schema.String
}) {}

/**
 * Service tag for persistence-backed AI conversation storage.
 *
 * **When to use**
 *
 * Use to provide the storage operations needed by persisted conversation
 * sessions.
 *
 * @category services
 * @since 4.0.0
 */
// @effect-diagnostics effect/leakingRequirements:off
export class Persistence extends Context.Service<Persistence, Persistence.Service>()(
  "effect/ai/Chat/Persisted"
) {}

/**
 * Namespace containing the service contract for chat persistence.
 *
 * @since 4.0.0
 */
export declare namespace Persistence {
  /**
   * Represents the backing persistence for a persisted `Chat`. Allows for
   * creating and retrieving chats that have been saved to a persistence store.
   *
   * @category models
   * @since 4.0.0
   */
  export interface Service {
    /**
     * Attempts to retrieve the persisted chat from the backing persistence
     * store with the specified chat identifer. If the chat does not exist in
     * the persistence store, a `ChatNotFoundError` will be returned.
     */
    readonly get: (chatId: string, options?: {
      readonly timeToLive?: Duration.Input | undefined
    }) => Effect.Effect<Persisted, ChatNotFoundError | PersistenceError>

    /**
     * Attempts to retrieve the persisted chat from the backing persistence
     * store with the specified chat identifer. If the chat does not exist in
     * the persistence store, an empty chat will be created, saved, and
     * returned.
     */
    readonly getOrCreate: (chatId: string, options?: {
      readonly timeToLive?: Duration.Input | undefined
    }) => Effect.Effect<Persisted, AiError.AiError | PersistenceError>
  }
}

/**
 * Represents a `Chat` that is backed by persistence.
 *
 * **Details**
 *
 * When calling a text generation method (e.g. `generateText`), the previous
 * chat history as well as the relevent response parts will be saved to the
 * backing persistence store.
 *
 * @category models
 * @since 4.0.0
 */
export interface Persisted extends Service {
  /**
   * The identifier for the chat in the backing persistence store.
   */
  readonly id: string

  /**
   * Saves the current chat history into the backing persistence store.
   */
  readonly save: Effect.Effect<void, AiError.AiError | PersistenceError>
}

/**
 * Creates a new chat persistence service.
 *
 * **When to use**
 *
 * Use when you need programmatic persisted chat creation and retrieval backed
 * by the current `BackingPersistence`.
 *
 * **Details**
 *
 * The provided store identifier will be used to indicate which "store" the
 * backing persistence should load chats from.
 *
 * @see {@link layerPersisted} for the `Layer`-based constructor
 *
 * @category constructors
 * @since 4.0.0
 */
export const makePersisted = Effect.fnUntraced(function*(options: {
  readonly storeId: string
}) {
  const persistence = yield* BackingPersistence
  const store = yield* persistence.make(options.storeId)

  const toPersisted = Effect.fnUntraced(
    function*(chatId: string, chat: Service, ttl: Duration.Input | undefined) {
      const idGenerator = yield* Effect.serviceOption(IdGenerator.IdGenerator).pipe(
        Effect.map(Option.getOrElse(() => IdGenerator.defaultIdGenerator))
      )

      const saveChat = Effect.fnUntraced(
        function*(prevHistory: Prompt.Prompt) {
          // Get the current chat history
          const history = yield* Ref.get(chat.history)
          // Get the most recent message stored in the previous chat history
          const lastMessage = prevHistory.content[prevHistory.content.length - 1]
          // Determine the correct message identifier to use:
          let messageId: string | undefined = undefined
          // If the most recent message in the chat history is an assistant message,
          // use the message identifer stored in that message
          if (Predicate.isNotUndefined(lastMessage) && lastMessage.role === "assistant") {
            messageId = (lastMessage.options[Persistence.key] as any)?.messageId
          }
          // If the chat history is empty or a message identifier did not exist on
          // the most recent message in the chat history, generate a new identifier
          if (Predicate.isUndefined(messageId)) {
            messageId = yield* idGenerator.generateId()
          }
          // Mutate the new messages to add the generated message identifier
          for (let i = prevHistory.content.length; i < history.content.length; i++) {
            const message = history.content[i]
            ;(message.options as any)[Persistence.key] = { messageId }
          }
          // Save the mutated history back to the ref
          yield* Ref.set(chat.history, history)
          // Export the chat history
          const exported = yield* Effect.orDie(chat.export)
          const timeToLive = Predicate.isNotUndefined(ttl)
            ? Option.getOrUndefined(Duration.fromInput(ttl))
            : undefined
          // Save the chat to the backing store
          yield* store.set(chatId, exported as object, timeToLive)
        }
      )

      const persisted: Persisted = {
        ...chat,
        id: chatId,
        save: Effect.flatMap(Ref.get(chat.history), saveChat),
        generateText: Effect.fnUntraced(function*(options) {
          const history = yield* Ref.get(chat.history)
          return yield* chat.generateText(options).pipe(
            Effect.ensuring(Effect.orDie(saveChat(history)))
          )
        }) as Service["generateText"],
        generateObject: Effect.fnUntraced(function*(options) {
          const history = yield* Ref.get(chat.history)
          return yield* chat.generateObject(options).pipe(
            Effect.ensuring(Effect.orDie(saveChat(history)))
          )
        }),
        streamText: Effect.fnUntraced(function*(options) {
          const history = yield* Ref.get(chat.history)
          const stream = chat.streamText(options).pipe(
            Stream.ensuring(Effect.orDie(saveChat(history)))
          )
          return stream
        }, Stream.unwrap) as Service["streamText"]
      }

      return persisted
    }
  )

  const createChat = Effect.fnUntraced(
    function*(chatId: string, ttl: Duration.Input | undefined) {
      // Create an empty chat
      const chat = yield* empty
      // Export the chat history
      const history = yield* Effect.orDie(chat.export)
      // Save the history for the newly created chat
      const timeToLive = Predicate.isNotUndefined(ttl)
        ? Option.getOrUndefined(Duration.fromInput(ttl))
        : undefined
      yield* store.set(chatId, history as object, timeToLive)
      // Convert the chat to a persisted chat
      return yield* toPersisted(chatId, chat, ttl)
    }
  )

  const getChat = Effect.fnUntraced(
    function*(chatId: string, ttl: Duration.Input | undefined) {
      // Create an empty chat
      const chat = yield* empty
      // Attempt to retrieve the previous history from the store
      const previousHistory = yield* store.get(chatId)
      // If the previous history was not found, raise an error
      if (Predicate.isUndefined(previousHistory)) {
        return yield* new ChatNotFoundError({ chatId })
      }
      // Decode the encoded previous history
      const history = yield* decodeHistory(previousHistory)
      // Hydrate the chat history
      yield* Ref.set(chat.history, history)
      // Convert the chat to a persisted chat
      return yield* toPersisted(chatId, chat, ttl)
    },
    Effect.catchTag("SchemaError", Effect.die)
  )

  const get = Effect.fnUntraced(
    function*(chatId: string, options?: {
      readonly timeToLive?: Duration.Input | undefined
    }) {
      return yield* getChat(chatId, options?.timeToLive)
    },
    (effect) =>
      Effect.withSpan(effect, "PersistedChat.get", {
        captureStackTrace: false
      })
  )

  const getOrCreate = Effect.fnUntraced(
    function*(chatId: string, options?: {
      readonly timeToLive?: Duration.Input | undefined
    }) {
      return yield* getChat(chatId, options?.timeToLive).pipe(
        Effect.catchTag("ChatNotFoundError", () => createChat(chatId, options?.timeToLive))
      )
    },
    (effect) =>
      Effect.withSpan(effect, "PersistedChat.getOrCreate", {
        captureStackTrace: false
      })
  )

  return Persistence.of({
    get,
    getOrCreate
  })
})

/**
 * Creates a `Layer` for a new chat persistence service.
 *
 * **When to use**
 *
 * Use to provide `Chat.Persistence` from a configured `BackingPersistence` when
 * your application needs persisted chat sessions backed by a named store.
 *
 * **Details**
 *
 * The provided store identifier will be used to indicate which "store" the
 * backing persistence should load chats from.
 *
 * @see {@link makePersisted} for the effect constructor when building the service directly instead of providing it as a layer
 *
 * @category constructors
 * @since 4.0.0
 */
export const layerPersisted = (options: {
  readonly storeId: string
}): Layer.Layer<Persistence, never, BackingPersistence> => Layer.effect(Persistence)(makePersisted(options))
