/**
 * The `AmazonBedrockLanguageModel` module maps the Effect AI `LanguageModel`
 * abstraction onto the Amazon Bedrock Converse API.
 *
 * **Scope**
 *
 * Text, tool calling and tool results are supported on both the streaming and
 * the non-streaming path. Structured output asks for the object through a
 * forced tool by default, and through Converse's native
 * `outputConfig.textFormat` when `Config.structuredOutputs` is `true`.
 * Reasoning blocks are surfaced on both paths and round-trip into later turns
 * with their signature. Image and document file parts become Converse `image`
 * and `document` blocks; a media type Converse has no format for fails with
 * `AiError.InvalidUserInputError`. Prompt caching is opt-in per message or
 * part via the `"amazon-bedrock"` provider options.
 *
 * @stability unstable
 * @since 4.0.0
 */
import * as AiError from "effect/ai/AiError"
import { toCodecAnthropic } from "effect/ai/AnthropicStructuredOutput"
import * as LanguageModel from "effect/ai/LanguageModel"
import * as AiModel from "effect/ai/Model"
import * as Prompt from "effect/ai/Prompt"
import type * as Response from "effect/ai/Response"
import { addGenAIAnnotations } from "effect/ai/Telemetry"
import * as Tool from "effect/ai/Tool"
import * as Bytes from "effect/Bytes"
import * as Context from "effect/Context"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as Base64 from "effect/encoding/Base64"
import { dual } from "effect/Function"
import * as Layer from "effect/Layer"
import * as Predicate from "effect/Predicate"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import * as SchemaAST from "effect/SchemaAST"
import * as Stream from "effect/Stream"
import type { Span } from "effect/Tracer"
import type { Simplify } from "effect/Types"
import { AmazonBedrockClient } from "./AmazonBedrockClient.ts"
import type {
  CachePointBlock,
  ContentBlock,
  ConverseRequest,
  ConverseResponse,
  ConverseStreamEvent,
  DocumentBlock,
  ImageBlock,
  Message,
  OutputConfig,
  SystemContentBlock,
  TokenUsage,
  Tool as BedrockTool,
  ToolChoice,
  ToolConfiguration,
  ToolResultContentBlock
} from "./AmazonBedrockSchema.ts"
import * as InternalUtilities from "./internal/utilities.ts"

/**
 * A Bedrock model identifier, cross-region inference profile id or ARN, such
 * as `us.anthropic.claude-sonnet-4-5-20250929-v1:0`.
 *
 * @stability unstable
 * @category models
 * @since 4.0.0
 */
export type Model = string

// =============================================================================
// Provider Options
// =============================================================================

/**
 * A request to cache everything preceding a message or part.
 *
 * **Details**
 *
 * Converse caches a prefix of the request rather than an individual block, so
 * this becomes a `cachePoint` block appended after the content it covers.
 * Omitting `ttl` leaves the cache lifetime to Bedrock.
 *
 * @stability unstable
 * @category models
 * @since 4.0.0
 */
export type CachePoint = typeof CachePointBlock.Encoded

/**
 * The provider options through which a cache point is requested.
 */
interface CachePointOptions {
  readonly "amazon-bedrock"?: {
    /**
     * Marks the end of the reusable prefix of the request. The cache point is
     * emitted after the content this is attached to.
     */
    readonly cachePoint?: CachePoint | null
  } | null
}

/**
 * The Bedrock-side identity of a reasoning block.
 *
 * **Details**
 *
 * Converse returns reasoning either as text plus a `signature` that proves the
 * model produced it, or as `redactedContent` (base64) when the model
 * provider's safety systems encrypted it. Either must be echoed back
 * unmodified for the block to be accepted in a later turn, so it is carried
 * on the part's provider metadata and options.
 *
 * @stability unstable
 * @category models
 * @since 4.0.0
 */
export type ReasoningInfo = {
  /** The signature verifying that the model generated the reasoning text. */
  readonly signature?: string
  /** Reasoning encrypted by the model provider, as a base64 string. */
  readonly redactedContent?: string
}

declare module "effect/ai/Prompt" {
  /**
   * Amazon Bedrock options for system messages.
   *
   * @stability unstable
   * @category models
   * @since 4.0.0
   */
  export interface SystemMessageOptions extends CachePointOptions {}

  /**
   * Amazon Bedrock options for user messages.
   *
   * @stability unstable
   * @category models
   * @since 4.0.0
   */
  export interface UserMessageOptions extends CachePointOptions {}

  /**
   * Amazon Bedrock options for assistant messages.
   *
   * @stability unstable
   * @category models
   * @since 4.0.0
   */
  export interface AssistantMessageOptions extends CachePointOptions {}

  /**
   * Amazon Bedrock options for tool messages.
   *
   * @stability unstable
   * @category models
   * @since 4.0.0
   */
  export interface ToolMessageOptions extends CachePointOptions {}

  /**
   * Amazon Bedrock options for text prompt parts.
   *
   * @stability unstable
   * @category models
   * @since 4.0.0
   */
  export interface TextPartOptions extends CachePointOptions {}

  /**
   * Amazon Bedrock options for file prompt parts.
   *
   * @stability unstable
   * @category models
   * @since 4.0.0
   */
  export interface FilePartOptions extends CachePointOptions {}

  /**
   * Amazon Bedrock options for tool call prompt parts.
   *
   * @stability unstable
   * @category models
   * @since 4.0.0
   */
  export interface ToolCallPartOptions extends CachePointOptions {}

  /**
   * Amazon Bedrock options for tool result prompt parts.
   *
   * @stability unstable
   * @category models
   * @since 4.0.0
   */
  export interface ToolResultPartOptions extends CachePointOptions {}

  /**
   * Amazon Bedrock options for reasoning prompt parts.
   *
   * **Details**
   *
   * Preserves the Bedrock reasoning payload so the block can be sent back in a
   * later turn. A reasoning part without these options is dropped rather than
   * sent, since Bedrock rejects a reasoning block it cannot verify.
   *
   * @stability unstable
   * @category models
   * @since 4.0.0
   */
  export interface ReasoningPartOptions extends ProviderOptions {
    readonly "amazon-bedrock"?: ReasoningInfo | null
  }
}

declare module "effect/ai/Response" {
  /**
   * Amazon Bedrock metadata attached to completed reasoning parts.
   *
   * @stability unstable
   * @category models
   * @since 4.0.0
   */
  export interface ReasoningPartMetadata extends ProviderMetadata {
    readonly "amazon-bedrock"?: ReasoningInfo | null
  }

  /**
   * Amazon Bedrock metadata attached to the end of a streamed reasoning
   * block. Converse streams the signature, or the redacted payload, after the
   * reasoning text, so it is attached once the block is complete.
   *
   * @stability unstable
   * @category models
   * @since 4.0.0
   */
  export interface ReasoningEndPartMetadata extends ProviderMetadata {
    readonly "amazon-bedrock"?: ReasoningInfo | null
  }

  /**
   * Amazon Bedrock metadata on the finish part.
   *
   * **Details**
   *
   * `stopReason` is the raw Converse stop reason. It tells
   * `guardrail_intervened` from `content_filtered`, which both finish with
   * `"content-filter"`, and `max_tokens` from `model_context_window_exceeded`,
   * which both finish with `"length"`. It is `null` only when a stream ended
   * without a `messageStop` event.
   *
   * @stability unstable
   * @category models
   * @since 4.0.0
   */
  export interface FinishPartMetadata extends ProviderMetadata {
    readonly "amazon-bedrock"?: {
      readonly stopReason: string | null
    } | null
  }
}

/**
 * Appends the cache point a message or part requests, if any, after the blocks
 * already emitted for it.
 */
const pushCachePoint = (
  content: Array<typeof ContentBlock.Encoded> | Array<typeof SystemContentBlock.Encoded>,
  carrier: { readonly options: CachePointOptions }
): void => {
  const cachePoint = carrier.options["amazon-bedrock"]?.cachePoint
  if (!Predicate.isNullish(cachePoint)) {
    content.push({ cachePoint })
  }
}

// =============================================================================
// Configuration
// =============================================================================

/**
 * Per-request configuration for the Amazon Bedrock language model.
 *
 * **Details**
 *
 * Derived from `ConverseRequest`, minus the fields built from the prompt and
 * the toolkit, so every other Converse request parameter is settable per
 * request. That includes `additionalModelRequestFields`, which carries
 * inference parameters specific to the target model, among them extended
 * thinking on Anthropic models. The thinking budget is drawn from the same
 * ceiling as the visible answer, so `inferenceConfig.maxTokens` must exceed
 * `budget_tokens`.
 *
 * **Example** (Enabling extended thinking for one request)
 *
 * ```ts
 * import { AmazonBedrockLanguageModel } from "@effect/ai-amazon-bedrock"
 * import { LanguageModel } from "effect/ai"
 *
 * const answer = LanguageModel.generateText({
 *   prompt: "How many r's are in strawberry?"
 * }).pipe(
 *   AmazonBedrockLanguageModel.withConfigOverride({
 *     additionalModelRequestFields: {
 *       thinking: { type: "enabled", budget_tokens: 1024 }
 *     },
 *     inferenceConfig: { maxTokens: 4096 }
 *   })
 * )
 * ```
 *
 * @stability unstable
 * @category configuration
 * @since 4.0.0
 */
export class Config extends Context.Service<
  Config,
  Simplify<
    & Partial<
      Omit<
        typeof ConverseRequest.Encoded,
        "messages" | "system" | "toolConfig" | "outputConfig"
      >
    >
    & {
      /**
       * Output configuration for the request. Only `effort` is exposed:
       * `textFormat` is derived from the response format.
       */
      readonly outputConfig?: {
        readonly effort?: string
      } | undefined
      /**
       * Whether `generateObject` uses Converse's native structured output
       * (`outputConfig.textFormat`).
       *
       * **Details**
       *
       * By default the object is asked for through a tool named after it,
       * forced with `toolChoice`, which every model that supports tool use
       * accepts. Set this to `true` on a model that supports native structured
       * output, such as recent Claude models, to send the JSON schema as
       * `outputConfig.textFormat` instead and keep the caller's own tools
       * available alongside it. Never sent to Bedrock.
       */
      readonly structuredOutputs?: boolean | undefined
    }
  >
>()("@effect/ai-amazon-bedrock/AmazonBedrockLanguageModel/Config") {}

// =============================================================================
// Language Model
// =============================================================================

/**
 * Creates an Amazon Bedrock model descriptor that can be provided with
 * `Effect.provide`.
 *
 * @stability unstable
 * @category constructors
 * @since 4.0.0
 */
export const model = (
  model: Model,
  config?: Omit<typeof Config.Service, "modelId">
): AiModel.Model<"amazon-bedrock", LanguageModel.LanguageModel, AmazonBedrockClient> =>
  AiModel.make("amazon-bedrock", model, layer({ model, config }))

/**
 * Creates an Amazon Bedrock `LanguageModel` service from a model identifier
 * and optional request defaults.
 *
 * @stability unstable
 * @category constructors
 * @since 4.0.0
 */
export const make = Effect.fnUntraced(function*({ config: providerConfig, model }: {
  readonly model: Model
  readonly config?: Omit<typeof Config.Service, "modelId"> | undefined
}): Effect.fn.Return<LanguageModel.LanguageModel, never, AmazonBedrockClient> {
  const client = yield* AmazonBedrockClient

  const makeRequest = Effect.fnUntraced(
    function*(
      options: LanguageModel.ProviderOptions
    ): Effect.fn.Return<typeof ConverseRequest.Encoded, AiError.AiError> {
      const services = yield* Effect.context<never>()
      const { outputConfig: configOutputConfig, structuredOutputs, ...config } = {
        ...providerConfig,
        ...Context.getOrUndefined(services, Config)
      }
      const modelId = config.modelId ?? model
      const { messages, system } = yield* prepareMessages(options)
      let toolConfig = yield* prepareTools(options)
      const responseFormat = options.responseFormat

      let outputConfig: typeof OutputConfig.Encoded | undefined = configOutputConfig
      if (responseFormat.type === "json") {
        const json = yield* tryJsonSchema(
          "makeRequest",
          () => Tool.getJsonSchemaFromSchema(responseFormat.schema, { transformer: toCodecAnthropic })
        )
        const description = SchemaAST.resolveDescription(responseFormat.schema.ast)
        if (structuredOutputs === true) {
          // Native structured output. The caller's own tools still go out
          // alongside it.
          outputConfig = {
            ...outputConfig,
            textFormat: {
              type: "json_schema",
              structure: {
                jsonSchema: {
                  schema: JSON.stringify(json),
                  name: responseFormat.objectName,
                  ...(Predicate.isNotUndefined(description) ? { description } : {})
                }
              }
            }
          }
        } else {
          // The object tool is the only tool, and it is forced.
          toolConfig = {
            tools: [{
              toolSpec: {
                name: responseFormat.objectName,
                description: description ?? "Respond with a JSON object",
                inputSchema: { json: json as Record<string, unknown> }
              }
            }],
            toolChoice: { tool: { name: responseFormat.objectName } }
          }
        }
      }

      const request: typeof ConverseRequest.Encoded = {
        ...config,
        modelId,
        system,
        messages,
        ...(Predicate.isNotUndefined(outputConfig) ? { outputConfig } : {}),
        ...(Predicate.isNotUndefined(toolConfig) ? { toolConfig } : {})
      }

      // Converse rejects `toolUse` and `toolResult` blocks in a request that
      // carries no `toolConfig`, and it has no tool choice that offers tools
      // while forbidding calls to them.
      const hasToolBlocks = messages.some((message) =>
        message.content.some((block) =>
          Predicate.isNotUndefined(block.toolUse) || Predicate.isNotUndefined(block.toolResult)
        )
      )
      if (hasToolBlocks && Predicate.isUndefined(request.toolConfig)) {
        return yield* invalidUserInput(
          "makeRequest",
          "The prompt contains tool calls or tool results, and Converse rejects them in a request that " +
            "carries no tools. Pass the toolkit that produced the tool calls, with a toolChoice other than \"none\"."
        )
      }
      return request
    }
  )

  return yield* LanguageModel.make({
    codecTransformer: toCodecAnthropic,
    generateText: Effect.fnUntraced(function*(options) {
      const request = yield* makeRequest(options)
      annotateRequest(options.span, request)
      const response = yield* client.converse(toConverseRequest(request))
      return yield* makeResponse(request, response, options)
    }),
    streamText: Effect.fnUntraced(function*(options) {
      const request = yield* makeRequest(options)
      annotateRequest(options.span, request)
      return makeStreamResponse(request, client.converseStream(request), options.tools, options.span)
    }, (effect, _options) => effect.pipe(Stream.unwrap))
  })
})

/**
 * Converse has no `streamProcessingMode`; only ConverseStream does.
 */
const toConverseRequest = (request: typeof ConverseRequest.Encoded): typeof ConverseRequest.Encoded => {
  if (Predicate.isUndefined(request.guardrailConfig?.streamProcessingMode)) {
    return request
  }
  const { streamProcessingMode: _, ...guardrailConfig } = request.guardrailConfig
  return { ...request, guardrailConfig }
}

/**
 * Creates a layer for the Amazon Bedrock language model.
 *
 * @stability unstable
 * @category layers
 * @since 4.0.0
 */
export const layer = (options: {
  readonly model: Model
  readonly config?: Omit<typeof Config.Service, "modelId"> | undefined
}): Layer.Layer<LanguageModel.LanguageModel, never, AmazonBedrockClient> =>
  Layer.effect(LanguageModel.LanguageModel, make(options))

/**
 * Provides config overrides for Amazon Bedrock language model operations.
 *
 * @stability unstable
 * @category configuration
 * @since 4.0.0
 */
export const withConfigOverride: {
  (overrides: typeof Config.Service): <A, E, R>(self: Effect.Effect<A, E, R>) => Effect.Effect<A, E, Exclude<R, Config>>
  <A, E, R>(self: Effect.Effect<A, E, R>, overrides: typeof Config.Service): Effect.Effect<A, E, Exclude<R, Config>>
} = dual<
  (
    overrides: typeof Config.Service
  ) => <A, E, R>(self: Effect.Effect<A, E, R>) => Effect.Effect<A, E, Exclude<R, Config>>,
  <A, E, R>(self: Effect.Effect<A, E, R>, overrides: typeof Config.Service) => Effect.Effect<A, E, Exclude<R, Config>>
>(2, (self, overrides) =>
  Effect.flatMap(
    Effect.serviceOption(Config),
    (config) =>
      Effect.provideService(self, Config, {
        ...(config._tag === "Some" ? config.value : {}),
        ...overrides
      })
  ))

// =============================================================================
// Prompt Conversion
// =============================================================================

/**
 * Converse takes a format enum rather than a media type, so only the media
 * types it has a format for can be sent. `image/*` is resolved to jpeg, which
 * mirrors the other providers.
 */
const imageFormats: Record<string, typeof ImageBlock.Encoded["format"]> = {
  "image/*": "jpeg",
  "image/jpeg": "jpeg",
  "image/png": "png",
  "image/gif": "gif",
  "image/webp": "webp"
}

const documentFormats: Record<string, typeof DocumentBlock.Encoded["format"]> = {
  "application/pdf": "pdf",
  "text/csv": "csv",
  "application/msword": "doc",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/vnd.ms-excel": "xls",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "text/html": "html",
  "text/plain": "txt",
  "text/markdown": "md"
}

/** Matches any absolute url, so one is rejected instead of being treated as base64 data. */
const urlPattern = /^[a-z][a-z0-9+.-]*:\/\//i

/** Matches the header of a `data:` url, up to the comma before its payload. */
const dataUrlPattern = /^data:[^,]*?(;base64)?,/i

const fail = (method: string, reason: AiError.AiErrorReason): AiError.AiError =>
  AiError.make({ module: "AmazonBedrockLanguageModel", method, reason })

const invalidUserInput = (method: string, description: string) =>
  fail(method, new AiError.InvalidUserInputError({ description }))

/**
 * Resolves file part data into base64 bytes.
 *
 * **Details**
 *
 * String data is already base64 per `Prompt.FilePart`, so it is passed through
 * untouched, and only the payload of a base64 `data:` url is sent. Converse
 * does not fetch remote files, so any other url fails.
 */
const fileBytes: (
  data: typeof Prompt.FilePart.Type["data"]
) => Effect.Effect<string, AiError.AiError> = Effect.fnUntraced(function*(data) {
  if (data instanceof Uint8Array) {
    return Base64.encode(data)
  }
  const string = data instanceof URL ? data.href : data
  const dataUrl = dataUrlPattern.exec(string)
  if (dataUrl !== null) {
    if (Predicate.isUndefined(dataUrl[1])) {
      return yield* invalidUserInput(
        "prepareMessages",
        `Unsupported file url '${dataUrl[0]}...' - a data url must have a base64 payload`
      )
    }
    return string.slice(dataUrl[0].length)
  }
  if (data instanceof URL || urlPattern.test(string)) {
    return yield* invalidUserInput(
      "prepareMessages",
      `Unsupported file url '${string}' - Converse does not fetch remote files, so pass the file bytes instead`
    )
  }
  return string
})

/**
 * Bedrock only accepts alphanumerics, single runs of whitespace, hyphens,
 * parentheses and square brackets in a document name, so anything else is
 * folded into a space. The file extension is dropped because the format is
 * carried separately.
 */
const documentName = (fileName: string | undefined, position: number): string => {
  if (Predicate.isNotUndefined(fileName)) {
    const name = fileName.replace(/\.[^.]*$/, "").replace(/[^a-zA-Z0-9\s\-()[\]]/g, " ").replace(/\s+/g, " ").trim()
    if (name.length > 0) {
      return name
    }
  }
  return `document ${position}`
}

const toolResultContent = (result: unknown): Array<typeof ToolResultContentBlock.Encoded> => {
  if (typeof result === "string") {
    return [{ text: result }]
  }
  if (Predicate.isUndefined(result)) {
    return [{ text: "" }]
  }
  if (Predicate.isObject(result)) {
    return [{ json: result }]
  }
  return [{ text: JSON.stringify(result) }]
}

const prepareMessages: (options: LanguageModel.ProviderOptions) => Effect.Effect<{
  readonly system: ReadonlyArray<typeof SystemContentBlock.Encoded>
  readonly messages: ReadonlyArray<typeof Message.Encoded>
}, AiError.AiError> = Effect.fnUntraced(
  function*(options) {
    const groups = groupMessages(options.prompt)

    const system: Array<typeof SystemContentBlock.Encoded> = []
    const messages: Array<typeof Message.Encoded> = []
    // Document names must be present and distinct within a request, so
    // unnamed documents are numbered across the whole conversation.
    let documentCount = 0

    for (let i = 0; i < groups.length; i++) {
      const group = groups[i]!
      const isLastGroup = i === groups.length - 1

      switch (group.type) {
        case "system": {
          if (messages.length > 0) {
            return yield* invalidUserInput(
              "prepareMessages",
              "Multiple system messages separated by user / assistant messages"
            )
          }
          for (const message of group.messages) {
            system.push({ text: message.content })
            pushCachePoint(system, message)
          }
          break
        }

        case "user": {
          const content: Array<typeof ContentBlock.Encoded> = []

          for (const message of group.messages) {
            switch (message.role) {
              case "user": {
                for (const part of message.content) {
                  switch (part.type) {
                    case "text": {
                      content.push({ text: part.text })
                      pushCachePoint(content, part)
                      break
                    }
                    case "file": {
                      const imageFormat = imageFormats[part.mediaType]
                      const documentFormat = documentFormats[part.mediaType]
                      if (Predicate.isNotUndefined(imageFormat)) {
                        content.push({
                          image: { format: imageFormat, source: { bytes: yield* fileBytes(part.data) } }
                        })
                      } else if (Predicate.isNotUndefined(documentFormat)) {
                        documentCount += 1
                        content.push({
                          document: {
                            format: documentFormat,
                            name: documentName(part.fileName, documentCount),
                            source: { bytes: yield* fileBytes(part.data) }
                          }
                        })
                      } else {
                        return yield* invalidUserInput(
                          "prepareMessages",
                          `Unsupported media type '${part.mediaType}' for file part - this provider supports the images and documents Converse has a format for`
                        )
                      }
                      pushCachePoint(content, part)
                      break
                    }
                  }
                }
                break
              }

              case "tool": {
                for (const part of message.content) {
                  // Only tool-result parts map to Converse blocks; other tool
                  // message parts (e.g. tool-approval responses) are skipped.
                  if (part.type !== "tool-result") continue
                  content.push({
                    toolResult: {
                      toolUseId: part.id,
                      content: toolResultContent(
                        Predicate.isNotUndefined(part.modelOutput)
                          ? Prompt.toolModelOutputToText(part.modelOutput)
                          : part.result
                      ),
                      ...(part.isFailure ? { status: "error" } : {})
                    }
                  })
                  pushCachePoint(content, part)
                }
                break
              }
            }
            pushCachePoint(content, message)
          }

          messages.push({ role: "user", content })
          break
        }

        case "assistant": {
          const content: Array<typeof ContentBlock.Encoded> = []

          for (let j = 0; j < group.messages.length; j++) {
            const message = group.messages[j]!
            const isLastMessage = j === group.messages.length - 1

            for (let k = 0; k < message.content.length; k++) {
              const part = message.content[k]!
              const isLastPart = k === message.content.length - 1

              switch (part.type) {
                case "text": {
                  // Skip empty text blocks
                  if (part.text.trim().length === 0) {
                    continue
                  }
                  content.push({
                    // Amazon Bedrock does not allow trailing whitespace in a
                    // pre-filled assistant response.
                    text: isLastGroup && isLastMessage && isLastPart ? part.text.trim() : part.text
                  })
                  pushCachePoint(content, part)
                  break
                }
                case "reasoning": {
                  // Bedrock verifies the payload that accompanies a reasoning
                  // block, so a reasoning part that did not come from this
                  // provider carries nothing it would accept and is dropped
                  // rather than sent and rejected.
                  const info = part.options["amazon-bedrock"]
                  if (Predicate.isNullish(info)) {
                    continue
                  }
                  if (Predicate.isNotUndefined(info.redactedContent)) {
                    content.push({ reasoningContent: { redactedContent: info.redactedContent } })
                  } else {
                    content.push({
                      reasoningContent: {
                        reasoningText: {
                          text: part.text,
                          ...(Predicate.isNotUndefined(info.signature) ? { signature: info.signature } : {})
                        }
                      }
                    })
                  }
                  break
                }
                case "tool-call": {
                  if (part.providerExecuted) {
                    continue
                  }
                  content.push({
                    toolUse: {
                      toolUseId: part.id,
                      name: part.name,
                      input: part.params
                    }
                  })
                  pushCachePoint(content, part)
                  break
                }
                default: {
                  return yield* invalidUserInput(
                    "prepareMessages",
                    `Unsupported assistant content part of type '${part.type}' - this provider supports text, reasoning, and tool calls`
                  )
                }
              }
            }
            pushCachePoint(content, message)
          }

          messages.push({ role: "assistant", content })
          break
        }
      }
    }

    return { system, messages }
  }
)

// =============================================================================
// Schema Helpers
// =============================================================================

const tryJsonSchema = <A>(method: string, evaluate: () => A): Effect.Effect<A, AiError.AiError> =>
  Effect.try({
    try: evaluate,
    catch: (error) =>
      fail(
        method,
        new AiError.UnsupportedSchemaError({ description: error instanceof Error ? error.message : String(error) })
      )
  })

// Bedrock is sent each tool's codec schema, which differs from the tool's own
// schema wherever the codec rewrites a parameter. Params that follow the codec
// are re-encoded with the tool's schema for the Toolkit to decode. Any others
// are left as they are, so that the Toolkit reports the error.
const decodeToolParams = (
  tools: ReadonlyArray<Tool.Any>,
  toolName: string,
  params: unknown
): Effect.Effect<unknown> => {
  const tool = tools.find((tool) => tool.name === toolName)
  if (Predicate.isUndefined(tool)) {
    return Effect.succeed(params)
  }
  return Effect.try(() => toCodecAnthropic(tool.parametersSchema).codec).pipe(
    Effect.flatMap((codec) => Schema.decodeUnknownEffect(codec)(params)),
    Effect.flatMap((decoded) => Schema.encodeUnknownEffect(tool.parametersSchema)(decoded)),
    Effect.orElseSucceed(() => params)
  ) as Effect.Effect<unknown>
}

// =============================================================================
// Tool Conversion
// =============================================================================

const prepareTools: (
  options: LanguageModel.ProviderOptions
) => Effect.Effect<
  typeof ToolConfiguration.Encoded | undefined,
  AiError.AiError
> = Effect.fnUntraced(function*(options) {
  // Converse rejects an empty `tools` array, and it has no tool choice that
  // forbids tool calls.
  if (options.tools.length === 0 || options.toolChoice === "none") {
    return undefined
  }

  const tools: Array<typeof BedrockTool.Encoded> = []
  for (const tool of options.tools) {
    // Provider-defined tools are rejected, and only they go by another name
    // on the wire, so no `Tool.NameMapper` is needed.
    if (!Tool.isUserDefined(tool)) {
      return yield* invalidUserInput(
        "prepareTools",
        `Unsupported tool '${(tool as { name: string }).name}' - this provider supports user-defined tools only`
      )
    }
    const description = Tool.getDescription(tool)
    const json = yield* tryJsonSchema("prepareTools", () => Tool.getJsonSchema(tool, { transformer: toCodecAnthropic }))
    tools.push({
      toolSpec: {
        name: tool.name,
        ...(Predicate.isNotUndefined(description) ? { description } : {}),
        inputSchema: { json: json as Record<string, unknown> }
      }
    })
  }

  let toolChoice: typeof ToolChoice.Encoded
  const choice = options.toolChoice
  if (choice === "auto") {
    toolChoice = { auto: {} }
  } else if (choice === "required") {
    toolChoice = { any: {} }
  } else if ("tool" in choice) {
    toolChoice = { tool: { name: choice.tool } }
  } else {
    // `LanguageModel` already filters the toolkit by `toolChoice.oneOf`
    // before a provider sees it, so this only picks the mode.
    toolChoice = choice.mode === "required" ? { any: {} } : { auto: {} }
  }

  return { tools, toolChoice }
})

// =============================================================================
// Response Conversion
// =============================================================================

const makeResponse: (
  request: typeof ConverseRequest.Encoded,
  response: ConverseResponse,
  options: LanguageModel.ProviderOptions
) => Effect.Effect<Array<Response.PartEncoded>, AiError.AiError> = Effect.fnUntraced(
  function*(request, response, options) {
    const parts: Array<Response.PartEncoded> = []
    // Without native structured output the object is asked for through a tool
    // named after it (see `makeRequest`).
    const objectToolName = options.responseFormat.type === "json" &&
        Predicate.isUndefined(request.outputConfig?.textFormat)
      ? options.responseFormat.objectName
      : undefined
    // A model can call the object tool more than once. The first call is the
    // object: joining the inputs of several calls would not be valid JSON.
    const objectToolPart = Predicate.isUndefined(objectToolName)
      ? undefined
      : response.output.message.content.find((part) => part.toolUse?.name === objectToolName)
    const hasObjectTool = Predicate.isNotUndefined(objectToolPart)

    parts.push(yield* responseMetadataPart(request.modelId))

    for (const part of response.output.message.content) {
      if (Predicate.isNotUndefined(part.text)) {
        // With native structured output the object arrives here, as JSON text
        // the LanguageModel layer decodes. When the object tool was called
        // instead, prose next to it must not be concatenated into the JSON.
        if (!hasObjectTool) {
          parts.push({ type: "text", text: part.text })
        }
      } else if (Predicate.isNotUndefined(part.toolUse)) {
        if (part.toolUse.name === objectToolName) {
          // The object tool's input is the object: re-emit it as text for the
          // LanguageModel layer to decode.
          if (part === objectToolPart) {
            parts.push({ type: "text", text: JSON.stringify(part.toolUse.input) })
          }
          continue
        }
        parts.push({
          type: "tool-call",
          id: part.toolUse.toolUseId,
          name: part.toolUse.name,
          params: yield* decodeToolParams(options.tools, part.toolUse.name, part.toolUse.input),
          providerExecuted: false
        })
      } else if (Predicate.isNotUndefined(part.reasoningContent)) {
        const { reasoningText, redactedContent } = part.reasoningContent
        if (Predicate.isNotUndefined(reasoningText)) {
          parts.push({
            type: "reasoning",
            text: reasoningText.text,
            metadata: {
              "amazon-bedrock": Predicate.isNotUndefined(reasoningText.signature)
                ? { signature: reasoningText.signature }
                : {}
            }
          })
        } else if (Predicate.isNotUndefined(redactedContent)) {
          // Redacted reasoning has no readable text; the encrypted payload
          // rides along in the metadata so the block can be sent back later.
          parts.push({
            type: "reasoning",
            text: "",
            metadata: { "amazon-bedrock": { redactedContent } }
          })
        }
      }
      // Blocks this provider does not model decode with every field undefined
      // and are ignored.
    }

    const usage = makeUsage(response.usage)
    annotateResponse(options.span, request.modelId, response.stopReason, usage)
    // Calling the object tool is how the model finishes, not a request to run
    // a tool.
    parts.push(
      finishPart(InternalUtilities.resolveFinishReason(response.stopReason, hasObjectTool), response.stopReason, usage)
    )

    return parts
  }
)

/**
 * Converse returns no response identifier, and the client service does not
 * surface the raw HTTP request.
 */
const responseMetadataPart = (modelId: string) =>
  Effect.map(DateTime.now, (now) => ({
    type: "response-metadata",
    id: undefined,
    modelId,
    timestamp: DateTime.formatIso(now),
    request: undefined
  } as const))

const finishPart = (reason: Response.FinishReason, stopReason: string | null, usage: Response.Usage) => ({
  type: "finish",
  reason,
  usage,
  response: undefined,
  metadata: { "amazon-bedrock": { stopReason } }
} as const)

const makeUsage = (usage: TokenUsage): Response.Usage => {
  const cacheRead = usage.cacheReadInputTokens
  const cacheWrite = usage.cacheWriteInputTokens
  return {
    inputTokens: {
      uncached: usage.inputTokens,
      total: usage.inputTokens + (cacheRead ?? 0) + (cacheWrite ?? 0),
      cacheRead,
      cacheWrite
    },
    outputTokens: {
      total: usage.outputTokens,
      text: undefined,
      reasoning: undefined
    }
  }
}

/**
 * A streamed reasoning block in flight. Converse streams the signature after
 * the text, and redacted reasoning as several base64 chunks of one byte
 * sequence, each encoded on its own, so the chunks are decoded and joined
 * before the block's metadata is emitted.
 */
interface ReasoningBlock {
  signature: string | undefined
  readonly redactedChunks: Array<Uint8Array>
}

const reasoningBlockInfo = (block: ReasoningBlock): ReasoningInfo => ({
  ...(Predicate.isNotUndefined(block.signature) ? { signature: block.signature } : {}),
  ...(block.redactedChunks.length > 0 ? { redactedContent: Base64.encode(Bytes.concat(block.redactedChunks)) } : {})
})

const makeStreamResponse = (
  request: typeof ConverseRequest.Encoded,
  stream: Stream.Stream<ConverseStreamEvent, AiError.AiError>,
  tools: ReadonlyArray<Tool.Any>,
  span: Span
): Stream.Stream<Response.StreamPartEncoded, AiError.AiError> => {
  // Text and reasoning blocks have no `contentBlockStart` event, so they are
  // started on their first delta.
  const textBlocks = new Set<number>()
  const reasoningBlocks = new Map<number, ReasoningBlock>()
  // Tool-use blocks in flight. Bedrock streams tool arguments as partial
  // JSON, so the fragments are accumulated here and parsed once the block
  // stops.
  const toolBlocks = new Map<number, { readonly id: string; readonly name: string; params: string }>()

  // Captured at `messageStop`; the `finish` part is emitted at `metadata`,
  // which Bedrock sends afterwards and which carries the usage.
  let stopReason: string | null = null

  return stream.pipe(
    Stream.mapEffect(Effect.fnUntraced(function*(event) {
      const parts: Array<Response.StreamPartEncoded> = []

      if ("messageStart" in event) {
        parts.push(yield* responseMetadataPart(request.modelId))
      } else if ("contentBlockStart" in event) {
        // Tool-use blocks announce themselves here.
        const start = event.contentBlockStart.start?.toolUse
        if (Predicate.isNotUndefined(start)) {
          const { name, toolUseId: id } = start
          toolBlocks.set(event.contentBlockStart.contentBlockIndex, { id, name, params: "" })
          parts.push({ type: "tool-params-start", id, name })
        }
      } else if ("contentBlockDelta" in event) {
        const index = event.contentBlockDelta.contentBlockIndex
        const id = index.toString()
        const { reasoningContent, text, toolUse } = event.contentBlockDelta.delta
        if (Predicate.isNotUndefined(toolUse)) {
          const block = toolBlocks.get(index)
          // A toolUse delta without a preceding `contentBlockStart` has no
          // call id to attribute it to, so it is dropped.
          if (Predicate.isNotUndefined(block)) {
            block.params += toolUse.input
            parts.push({ type: "tool-params-delta", id: block.id, delta: toolUse.input })
          }
        } else if (Predicate.isNotUndefined(reasoningContent)) {
          let block = reasoningBlocks.get(index)
          if (Predicate.isUndefined(block)) {
            block = { signature: undefined, redactedChunks: [] }
            reasoningBlocks.set(index, block)
            parts.push({ type: "reasoning-start", id })
          }
          if (Predicate.isNotUndefined(reasoningContent.text)) {
            parts.push({ type: "reasoning-delta", id, delta: reasoningContent.text })
          }
          if (Predicate.isNotUndefined(reasoningContent.signature)) {
            block.signature = reasoningContent.signature
          }
          if (Predicate.isNotUndefined(reasoningContent.redactedContent)) {
            const chunk = Base64.decode(reasoningContent.redactedContent)
            if (Result.isFailure(chunk)) {
              return yield* fail(
                "makeStreamResponse",
                new AiError.InvalidResponseError({
                  description: `Bedrock streamed redacted reasoning that is not base64: ${
                    truncate(reasoningContent.redactedContent, 100)
                  }`
                })
              )
            }
            block.redactedChunks.push(chunk.success)
          }
        } else if (Predicate.isNotUndefined(text)) {
          if (!textBlocks.has(index)) {
            textBlocks.add(index)
            parts.push({ type: "text-start", id })
          }
          parts.push({ type: "text-delta", id, delta: text })
        }
        // Deltas this provider does not model decode with every key undefined
        // and are skipped.
      } else if ("contentBlockStop" in event) {
        const index = event.contentBlockStop.contentBlockIndex
        const id = index.toString()
        if (textBlocks.delete(index)) {
          parts.push({ type: "text-end", id })
        }
        const reasoningBlock = reasoningBlocks.get(index)
        if (Predicate.isNotUndefined(reasoningBlock)) {
          reasoningBlocks.delete(index)
          parts.push({ type: "reasoning-end", id, metadata: { "amazon-bedrock": reasoningBlockInfo(reasoningBlock) } })
        }
        const block = toolBlocks.get(index)
        if (Predicate.isNotUndefined(block)) {
          toolBlocks.delete(index)
          const params = yield* Effect.try({
            // A tool taking no arguments streams no deltas at all.
            try: () => Tool.unsafeSecureJsonParse(block.params.length === 0 ? "{}" : block.params),
            catch: () =>
              fail(
                "makeStreamResponse",
                new AiError.InvalidOutputError({
                  description: `Bedrock streamed input for the \`${block.name}\` tool that is not valid JSON: ` +
                    truncate(block.params, 500)
                })
              )
          })
          parts.push({ type: "tool-params-end", id: block.id })
          parts.push({
            type: "tool-call",
            id: block.id,
            name: block.name,
            params: yield* decodeToolParams(tools, block.name, params),
            providerExecuted: false
          })
        }
      } else if ("messageStop" in event) {
        stopReason = event.messageStop.stopReason
      } else if ("metadata" in event) {
        const usage = makeUsage(event.metadata.usage)
        annotateResponse(span, request.modelId, stopReason, usage)
        parts.push(finishPart(
          stopReason === null ? "unknown" : InternalUtilities.resolveFinishReason(stopReason),
          stopReason,
          usage
        ))
      }
      // Events this provider does not model match none of the branches and
      // are ignored.

      return parts
    })),
    Stream.flattenIterable
  )
}

// =============================================================================
// Telemetry
// =============================================================================

const annotateRequest = (span: Span, request: typeof ConverseRequest.Encoded): void => {
  addGenAIAnnotations(span, {
    provider: { name: "aws.bedrock" },
    operation: { name: "chat" },
    request: {
      model: request.modelId,
      maxTokens: request.inferenceConfig?.maxTokens,
      temperature: request.inferenceConfig?.temperature,
      topP: request.inferenceConfig?.topP,
      stopSequences: request.inferenceConfig?.stopSequences
    }
  })
}

const annotateResponse = (span: Span, modelId: string, stopReason: string | null, usage: Response.Usage): void => {
  addGenAIAnnotations(span, {
    response: {
      model: modelId,
      finishReasons: stopReason === null ? undefined : [stopReason]
    },
    usage: {
      inputTokens: usage.inputTokens.total,
      outputTokens: usage.outputTokens.total
    }
  })
  span.attribute("gen_ai.usage.cache_read.input_tokens", usage.inputTokens.cacheRead ?? 0)
  span.attribute("gen_ai.usage.cache_write.input_tokens", usage.inputTokens.cacheWrite ?? 0)
}

// =============================================================================
// Utilities
// =============================================================================

type ContentGroup = SystemMessageGroup | AssistantMessageGroup | UserMessageGroup

interface SystemMessageGroup {
  readonly type: "system"
  readonly messages: Array<Prompt.SystemMessage>
}

interface AssistantMessageGroup {
  readonly type: "assistant"
  readonly messages: Array<Prompt.AssistantMessage>
}

interface UserMessageGroup {
  readonly type: "user"
  readonly messages: Array<Prompt.ToolMessage | Prompt.UserMessage>
}

/**
 * Converse alternates user and assistant turns, and tool results travel in a
 * user turn, so consecutive messages of one side are merged.
 */
const groupMessages = (prompt: Prompt.Prompt): Array<ContentGroup> => {
  const messages: Array<ContentGroup> = []
  let current: ContentGroup | undefined = undefined
  for (const message of prompt.content) {
    switch (message.role) {
      case "system": {
        if (current?.type !== "system") {
          current = { type: "system", messages: [] }
          messages.push(current)
        }
        current.messages.push(message)
        break
      }
      case "assistant": {
        if (current?.type !== "assistant") {
          current = { type: "assistant", messages: [] }
          messages.push(current)
        }
        current.messages.push(message)
        break
      }
      case "tool":
      case "user": {
        if (current?.type !== "user") {
          current = { type: "user", messages: [] }
          messages.push(current)
        }
        current.messages.push(message)
        break
      }
    }
  }
  return messages
}

const truncate = (text: string, maxLength: number): string =>
  text.length > maxLength ? `${text.slice(0, maxLength)}...` : text
