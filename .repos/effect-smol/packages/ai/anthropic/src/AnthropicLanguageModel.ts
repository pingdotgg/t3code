/**
 * The `AnthropicLanguageModel` module provides the Anthropic implementation of
 * Effect AI's `LanguageModel` service. It turns Effect AI prompts, tools, files,
 * reasoning parts, and provider options into Anthropic Messages API requests,
 * and converts Anthropic responses and streams back into Effect AI response
 * parts with Anthropic-specific metadata.
 *
 * **When to use**
 *
 * Use when create an Anthropic-backed model with {@link model}
 * - Build or provide a `LanguageModel.LanguageModel` layer with {@link layer}
 *   or {@link make}
 * - Supply default request options through {@link Config}
 * - Override configuration for a scoped operation with {@link withConfigOverride}
 * - Attach Anthropic provider options for prompt caching, document citations,
 *   reasoning signatures, MCP metadata, and server-side tools
 *
 * **Gotchas**
 *
 * - Prompt files are translated to Anthropic image or document blocks; only the
 *   supported media types can be sent to the provider.
 * - Structured output support depends on the selected Claude model, so this
 *   module may use Anthropic's native structured output or fall back to a JSON
 *   response tool.
 * - Some features require Anthropic beta headers, which are added
 *   automatically from the selected tools, files, and model capabilities.
 *
 * @since 4.0.0
 */
/** @effect-diagnostics preferSchemaOverJson:skip-file */
import * as Arr from "effect/Array"
import * as Context from "effect/Context"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as Encoding from "effect/Encoding"
import { dual } from "effect/Function"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Predicate from "effect/Predicate"
import * as Redactable from "effect/Redactable"
import * as Schema from "effect/Schema"
import * as SchemaAST from "effect/SchemaAST"
import * as Stream from "effect/Stream"
import type { Span } from "effect/Tracer"
import type { Mutable, Simplify } from "effect/Types"
import * as AiError from "effect/unstable/ai/AiError"
import { toCodecAnthropic } from "effect/unstable/ai/AnthropicStructuredOutput"
import * as IdGenerator from "effect/unstable/ai/IdGenerator"
import * as LanguageModel from "effect/unstable/ai/LanguageModel"
import * as AiModel from "effect/unstable/ai/Model"
import type * as Prompt from "effect/unstable/ai/Prompt"
import type * as Response from "effect/unstable/ai/Response"
import * as Tool from "effect/unstable/ai/Tool"
import type * as HttpClientRequest from "effect/unstable/http/HttpClientRequest"
import type * as HttpClientResponse from "effect/unstable/http/HttpClientResponse"
import { AnthropicClient, type MessageStreamEvent } from "./AnthropicClient.ts"
import { addGenAIAnnotations } from "./AnthropicTelemetry.ts"
import type { AnthropicTool } from "./AnthropicTool.ts"
import type * as Generated from "./Generated.ts"
import * as InternalUtilities from "./internal/utilities.ts"

/**
 * Known Anthropic Claude model identifiers exposed by the generated Anthropic schema.
 *
 * **Details**
 *
 * The Anthropic language model constructors accept `Model` values and custom
 * string model ids, so this type is best used for autocomplete and type checking
 * of known Claude ids.
 *
 * @category models
 * @since 4.0.0
 */
export type Model = typeof Generated.Model.Type

// =============================================================================
// Configuration
// =============================================================================

/**
 * Context service for Anthropic language model configuration.
 *
 * **When to use**
 *
 * Use when you need to provide or override Anthropic model configuration on a
 * per-request basis via `Context.Service`.
 *
 * **Details**
 *
 * This service can be used to provide default configuration values or to
 * override configuration on a per-request basis.
 *
 * @category configuration
 * @since 4.0.0
 */
export class Config extends Context.Service<
  Config,
  Simplify<
    & Partial<
      Omit<
        typeof Generated.BetaCreateMessageParams.Encoded,
        "messages" | "output_config" | "tools" | "tool_choice" | "stream"
      >
    >
    & {
      readonly output_config?: {
        readonly effort?: "low" | "medium" | "high" | null
      }
      /**
       * Disables Claude's ability to use multiple tools to respond to a query.
       */
      readonly disableParallelToolCalls?: boolean | undefined
      /**
       * Whether to use strict JSON schema validation for tool calls.
       *
       * **Details**
       *
       * Only applies to models that support structured outputs. Defaults to
       * `true` when structured outputs are supported.
       */
      readonly strictJsonSchema?: boolean | undefined
    }
  >
>()("@effect/ai-anthropic/AnthropicLanguageModel/Config") {}

// =============================================================================
// Provider Options / Metadata
// =============================================================================

declare module "effect/unstable/ai/Prompt" {
  /**
   * Anthropic-specific options for system messages.
   *
   * **Details**
   *
   * These options are used when translating system messages into Anthropic
   * request content.
   *
   * @category request
   * @since 4.0.0
   */
  export interface SystemMessageOptions extends ProviderOptions {
    readonly anthropic?: {
      /**
       * A breakpoint which marks the end of reusable content eligible for caching.
       */
      readonly cacheControl?: typeof Generated.CacheControlEphemeral.Encoded | null
    } | null
  }

  /**
   * Anthropic-specific options for user messages.
   *
   * **Details**
   *
   * These options are used when translating user messages into Anthropic
   * request content.
   *
   * @category request
   * @since 4.0.0
   */
  export interface UserMessageOptions extends ProviderOptions {
    readonly anthropic?: {
      /**
       * A breakpoint which marks the end of reusable content eligible for caching.
       */
      readonly cacheControl?: typeof Generated.CacheControlEphemeral.Encoded | null
    } | null
  }

  /**
   * Anthropic-specific options for assistant messages.
   *
   * **Details**
   *
   * These options are used when replaying assistant messages in Anthropic
   * conversation history.
   *
   * @category request
   * @since 4.0.0
   */
  export interface AssistantMessageOptions extends ProviderOptions {
    readonly anthropic?: {
      /**
       * A breakpoint which marks the end of reusable content eligible for caching.
       */
      readonly cacheControl?: typeof Generated.CacheControlEphemeral.Encoded | null
    } | null
  }

  /**
   * Anthropic-specific options for tool messages.
   *
   * **Details**
   *
   * These options are used when converting tool results into Anthropic user
   * content blocks.
   *
   * @category request
   * @since 4.0.0
   */
  export interface ToolMessageOptions extends ProviderOptions {
    readonly anthropic?: {
      /**
       * A breakpoint which marks the end of reusable content eligible for caching.
       */
      readonly cacheControl?: typeof Generated.CacheControlEphemeral.Encoded | null
    } | null
  }

  /**
   * Anthropic-specific options for text prompt parts.
   *
   * **When to use**
   *
   * Use when you use these options to control how text blocks are sent to Anthropic.
   *
   * @category request
   * @since 4.0.0
   */
  export interface TextPartOptions extends ProviderOptions {
    readonly anthropic?: {
      /**
       * A breakpoint which marks the end of reusable content eligible for caching.
       */
      readonly cacheControl?: typeof Generated.CacheControlEphemeral.Encoded | null
    } | null
  }

  /**
   * Anthropic-specific options for reasoning prompt parts.
   *
   * **Details**
   *
   * Preserves Claude thinking metadata when reasoning content is sent back to
   * Anthropic in later turns.
   *
   * @category request
   * @since 4.0.0
   */
  export interface ReasoningPartOptions extends ProviderOptions {
    readonly anthropic?: {
      readonly info?: {
        readonly type: "thinking"
        /**
         * Thinking content as an encrypted string, which is used to verify
         * that thinking content was indeed generated by Anthropic's API.
         */
        readonly signature: typeof Generated.ResponseThinkingBlock.fields.thinking.Encoded
      } | {
        readonly type: "redacted_thinking"
        /**
         * Thinking content which was flagged by Anthropic's safety systems, and
         * was therefore encrypted.
         */
        readonly redactedData: typeof Generated.ResponseRedactedThinkingBlock.fields.data.Encoded
      } | null
      /**
       * A breakpoint which marks the end of reusable content eligible for caching.
       */
      readonly cacheControl?: typeof Generated.CacheControlEphemeral.Encoded | null
    } | null
  }

  /**
   * Anthropic-specific options for file prompt parts.
   *
   * **Details**
   *
   * Controls document metadata, citations, and prompt caching for files sent to
   * Anthropic.
   *
   * @category request
   * @since 4.0.0
   */
  export interface FilePartOptions extends ProviderOptions {
    readonly anthropic?: {
      /**
       * A breakpoint which marks the end of reusable content eligible for caching.
       */
      readonly cacheControl?: typeof Generated.CacheControlEphemeral.Encoded | null
      /**
       * Whether or not citations should be enabled for the file part.
       */
      readonly citations?: typeof Generated.RequestCitationsConfig.Encoded | null
      /**
       * A custom title to provide to the document. If omitted, the file part's
       * `fileName` property will be used.
       */
      readonly documentTitle?: string | null
      /**
       * Additional context about the document that will be forwarded to the
       * large language model, but will not be used towards cited content.
       *
       * **When to use**
       *
       * Use when storing additional document metadata as text or stringified JSON.
       */
      readonly documentContext?: string | null
    } | null
  }

  /**
   * Anthropic-specific options for tool call prompt parts.
   *
   * **Details**
   *
   * Carries Anthropic tool caller metadata, MCP metadata, and cache control for
   * tool use blocks.
   *
   * @category request
   * @since 4.0.0
   */
  export interface ToolCallPartOptions extends ProviderOptions {
    readonly anthropic?: {
      readonly caller?: {
        readonly type: string
        readonly toolId?: string | null
      } | null
      /**
       * Contains details about the MCP tool that was called.
       */
      readonly mcp_tool?: {
        /**
         * The name of the MCP server
         */
        readonly server: string
      } | null
      /**
       * A breakpoint which marks the end of reusable content eligible for caching.
       */
      readonly cacheControl?: typeof Generated.CacheControlEphemeral.Encoded | null
    } | null
  }

  /**
   * Anthropic-specific options for tool result prompt parts.
   *
   * **Details**
   *
   * Controls Anthropic prompt caching for tool result content.
   *
   * @category request
   * @since 4.0.0
   */
  export interface ToolResultPartOptions extends ProviderOptions {
    readonly anthropic?: {
      /**
       * A breakpoint which marks the end of reusable content eligible for caching.
       */
      readonly cacheControl?: typeof Generated.CacheControlEphemeral.Encoded | null
    } | null
  }

  /**
   * Anthropic-specific options for tool approval request prompt parts.
   *
   * **Details**
   *
   * Controls prompt caching for human approval requests in conversations.
   *
   * @category request
   * @since 4.0.0
   */
  export interface ToolApprovalRequestPartOptions extends ProviderOptions {
    readonly anthropic?: {
      /**
       * A breakpoint which marks the end of reusable content eligible for caching.
       */
      readonly cacheControl?: typeof Generated.CacheControlEphemeral.Encoded | null
    } | null
  }

  /**
   * Anthropic-specific options for tool approval response prompt parts.
   *
   * **Details**
   *
   * Controls prompt caching for human approval responses in conversations.
   *
   * @category request
   * @since 4.0.0
   */
  export interface ToolApprovalResponsePartOptions extends ProviderOptions {
    readonly anthropic?: {
      /**
       * A breakpoint which marks the end of reusable content eligible for caching.
       */
      readonly cacheControl?: typeof Generated.CacheControlEphemeral.Encoded | null
    } | null
  }
}

declare module "effect/unstable/ai/Response" {
  /**
   * Anthropic metadata attached when a reasoning block begins.
   *
   * **Details**
   *
   * Includes Claude thinking metadata needed to continue reasoning-aware
   * conversations.
   *
   * @category response
   * @since 4.0.0
   */
  export interface ReasoningStartPartMetadata extends ProviderMetadata {
    readonly anthropic?: {
      readonly info?: {
        readonly type: "thinking"
        /**
         * Thinking content as an encrypted string, which is used to verify
         * that thinking content was indeed generated by Anthropic's API.
         */
        readonly signature: typeof Generated.ResponseThinkingBlock.fields.thinking.Encoded
      } | {
        readonly type: "redacted_thinking"
        /**
         * Thinking content which was flagged by Anthropic's safety systems, and
         * was therefore encrypted.
         */
        readonly redactedData: typeof Generated.ResponseRedactedThinkingBlock.fields.data.Encoded
      } | null
    } | null
  }

  /**
   * Anthropic metadata attached to streaming reasoning deltas.
   *
   * **Details**
   *
   * Includes the signature for streamed Claude thinking content when available.
   *
   * @category response
   * @since 4.0.0
   */
  export interface ReasoningDeltaPartMetadata extends ProviderMetadata {
    readonly anthropic?: {
      readonly info?: {
        readonly type: "thinking"
        /**
         * Thinking content as an encrypted string, which is used to verify
         * that thinking content was indeed generated by Anthropic's API.
         */
        readonly signature: typeof Generated.ResponseThinkingBlock.fields.thinking.Encoded
      } | null
    } | null
  }

  /**
   * Anthropic metadata attached to completed reasoning parts.
   *
   * **Details**
   *
   * Preserves Claude thinking or redacted thinking information for later turns.
   *
   * @category response
   * @since 4.0.0
   */
  export interface ReasoningPartMetadata extends ProviderMetadata {
    readonly anthropic?: {
      readonly info?: {
        readonly type: "thinking"
        /**
         * Thinking content as an encrypted string, which is used to verify
         * that thinking content was indeed generated by Anthropic's API.
         */
        readonly signature: typeof Generated.ResponseThinkingBlock.fields.thinking.Encoded
      } | {
        readonly type: "redacted_thinking"
        /**
         * Thinking content which was flagged by Anthropic's safety systems, and
         * was therefore encrypted.
         */
        readonly redactedData: typeof Generated.ResponseRedactedThinkingBlock.fields.data.Encoded
      } | null
    } | null
  }

  /**
   * Anthropic metadata attached to tool call response parts.
   *
   * **Details**
   *
   * Identifies Anthropic caller details and MCP tool metadata emitted by the
   * provider.
   *
   * @category response
   * @since 4.0.0
   */
  export interface ToolCallPartMetadata extends ProviderMetadata {
    readonly anthropic?: {
      readonly caller?: {
        readonly type: string
        readonly toolId?: string | null
      } | null
      /**
       * Contains details about the MCP tool that was called.
       */
      readonly mcp_tool?: {
        /**
         * The name of the MCP server
         */
        readonly server: string
      } | null
    } | null
  }

  /**
   * Anthropic metadata attached to tool result response parts.
   *
   * **Details**
   *
   * Identifies MCP tool metadata associated with provider-executed tool
   * results.
   *
   * @category response
   * @since 4.0.0
   */
  export interface ToolResultPartMetadata extends ProviderMetadata {
    readonly anthropic?: {
      /**
       * Contains details about the MCP tool that was called.
       */
      readonly mcp_tool?: {
        /**
         * The name of the MCP server
         */
        readonly server: string
      } | null
    } | null
  }

  /**
   * Anthropic metadata for document citations in model responses.
   *
   * **Details**
   *
   * Records the cited document span by character position or page number.
   *
   * @category response
   * @since 4.0.0
   */
  export interface DocumentSourcePartMetadata extends ProviderMetadata {
    readonly anthropic?: {
      readonly source: "document"
      readonly type: "char_location"
      /**
       * The text that was cited in the response.
       */
      readonly citedText: string
      /**
       * The 0-indexed starting position of the characters that were cited.
       */
      readonly startCharIndex: number
      /**
       * The exclusive ending position of the characters that were cited.
       */
      readonly endCharIndex: number
    } | {
      readonly source: "document"
      readonly type: "page_location"
      /**
       * The text that was cited in the response.
       */
      readonly citedText: string
      /**
       * The 1-indexed starting page of pages that were cited.
       */
      readonly startPageNumber: number
      /**
       * The exclusive ending position of the pages that were cited.
       */
      readonly endPageNumber: number
    } | null
  }

  /**
   * Anthropic metadata for URL and web citations in model responses.
   *
   * **Details**
   *
   * Records cited URL text or web-search source freshness information.
   *
   * @category response
   * @since 4.0.0
   */
  export interface UrlSourcePartMetadata extends ProviderMetadata {
    readonly anthropic?: {
      readonly source: "url"
      /**
       * Up to 150 characters of the text content that was referenced from the
       * URL source material.
       */
      readonly citedText: string
      /**
       * An internal reference that must be passed back to the Anthropic API
       * during multi-turn conversations.
       */
      readonly encryptedIndex: string
    } | {
      readonly source: "web"
      readonly pageAge: string | null
    } | null
  }

  /**
   * Anthropic metadata attached to the finish part of a response.
   *
   * **Details**
   *
   * Includes container state, context management information, stop details, and
   * token usage reported by Anthropic.
   *
   * @category response
   * @since 4.0.0
   */
  export interface FinishPartMetadata extends ProviderMetadata {
    readonly anthropic?: {
      readonly container: typeof Generated.BetaContainer.Encoded | null
      readonly contextManagement: typeof Generated.BetaResponseContextManagement.Encoded | null
      readonly stopSequence: string | null
      readonly usage: typeof Generated.BetaMessage.Encoded["usage"] | null
    } | null
  }

  /**
   * Anthropic metadata attached to error response parts.
   *
   * **Details**
   *
   * Includes the provider request identifier when Anthropic returns one.
   *
   * @category response
   * @since 4.0.0
   */
  export interface ErrorPartMetadata extends ProviderMetadata {
    readonly anthropic?: {
      requestId?: string | null
    } | null
  }
}

// =============================================================================
// Language Model
// =============================================================================

/**
 * Creates an Anthropic model descriptor that can be provided with `Effect.provide`.
 *
 * **When to use**
 *
 * Use when you want an Anthropic Claude model value that carries provider and
 * model metadata and can be supplied directly to an Effect program.
 *
 * @see {@link layer} for creating a `LanguageModel.LanguageModel` layer directly
 * @see {@link make} for constructing the language model service effectfully
 *
 * @category constructors
 * @since 4.0.0
 */
export const model = (
  model: (string & {}) | Model,
  config?: Omit<typeof Config.Service, "model">
): AiModel.Model<"anthropic", LanguageModel.LanguageModel, AnthropicClient> =>
  AiModel.make("anthropic", model, layer({ model, config }))

/**
 * Creates an Anthropic `LanguageModel` service from a model identifier and optional request defaults.
 *
 * **When to use**
 *
 * Use when an Effect needs to construct a `LanguageModel.Service` value backed
 * by `AnthropicClient`.
 *
 * **Details**
 *
 * The returned effect requires `AnthropicClient`. Request defaults from the
 * `config` option are merged with any `Config` service in the context, with
 * context values taking precedence.
 *
 * @see {@link layer} for providing the service as a `Layer`
 * @see {@link model} for creating a model descriptor for `AiModel.provide`
 *
 * @category constructors
 * @since 4.0.0
 */
export const make = Effect.fnUntraced(function*({ model, config: providerConfig }: {
  readonly model: (string & {}) | Model
  readonly config?: Omit<typeof Config.Service, "model"> | undefined
}): Effect.fn.Return<LanguageModel.Service, never, AnthropicClient> {
  const client = yield* AnthropicClient

  const makeConfig: Effect.Effect<typeof Config.Service & { readonly model: string }> = Effect.gen(function*() {
    const services = yield* Effect.context<never>()
    return { model, ...providerConfig, ...services.mapUnsafe.get(Config.key) }
  })

  const makeRequest = Effect.fnUntraced(
    function*<Tools extends ReadonlyArray<Tool.Any>>({ config, options, toolNameMapper }: {
      readonly config: typeof Config.Service & { readonly model: string }
      readonly options: LanguageModel.ProviderOptions
      readonly toolNameMapper: Tool.NameMapper<Tools>
    }): Effect.fn.Return<{
      readonly params: typeof Generated.BetaMessagesPostParams.Encoded
      readonly payload: typeof Generated.BetaCreateMessageParams.Encoded
    }, AiError.AiError> {
      const betas = new Set<string>()
      const capabilities = getModelCapabilities(config.model!)
      const { messages, system } = yield* prepareMessages({ betas, options, toolNameMapper })
      const outputFormat = yield* getOutputFormat({ capabilities, options })
      const { tools, toolChoice } = yield* prepareTools({ betas, capabilities, config, options })
      const params: Mutable<typeof Generated.BetaMessagesPostParams.Encoded> = {}
      if (betas.size > 0) {
        params["anthropic-beta"] = Array.from(betas).join(",")
      }
      const { disableParallelToolCalls: _, output_config, ...requestConfig } = config
      const payload: Mutable<typeof Generated.BetaCreateMessageParams.Encoded> = {
        ...requestConfig,
        max_tokens: requestConfig.max_tokens ?? capabilities.maxOutputTokens,
        messages,
        ...(Predicate.isNotUndefined(system) ? { system } : undefined),
        ...(Predicate.isNotUndefined(tools) ? { tools } : undefined),
        ...(Predicate.isNotUndefined(toolChoice) ? { tool_choice: toolChoice } : undefined)
      }
      const outputConfig: Mutable<typeof Generated.BetaCreateMessageParams.Encoded["output_config"]> = {}
      if (Predicate.isNotUndefined(outputFormat)) {
        outputConfig.format = outputFormat
      }
      if (Predicate.isNotUndefined(output_config?.effort)) {
        outputConfig.effort = output_config.effort
      }
      if (Object.keys(outputConfig).length > 0) {
        payload.output_config = outputConfig
      }
      return { params, payload }
    }
  )

  return yield* LanguageModel.make({
    codecTransformer: toCodecAnthropic,
    generateText: Effect.fnUntraced(function*(options) {
      const config = yield* makeConfig
      const toolNameMapper = new Tool.NameMapper(options.tools)
      const request = yield* makeRequest({ config, options, toolNameMapper })
      annotateRequest(options.span, request.payload)
      const [rawResponse, response] = yield* client.createMessage(request)
      annotateResponse(options.span, rawResponse)
      return yield* makeResponse({ options, rawResponse, response, toolNameMapper })
    }),
    streamText: Effect.fnUntraced(function*(options) {
      const config = yield* makeConfig
      const toolNameMapper = new Tool.NameMapper(options.tools)
      const request = yield* makeRequest({ config, options, toolNameMapper })
      annotateRequest(options.span, request.payload)
      const [response, stream] = yield* client.createMessageStream(request)
      return yield* makeStreamResponse({ stream, response, options, toolNameMapper })
    }, (effect, options) =>
      effect.pipe(
        Stream.unwrap,
        Stream.map((response) => {
          annotateStreamResponse(options.span, response)
          return response
        })
      ))
  })
})

/**
 * Creates a layer for the Anthropic language model.
 *
 * **When to use**
 *
 * Use when composing application layers and you want Anthropic to satisfy
 * `LanguageModel.LanguageModel` while supplying `AnthropicClient` from another
 * layer.
 *
 * @see {@link make} for constructing the language model service effectfully
 * @see {@link model} for creating a model service directly
 *
 * @category layers
 * @since 4.0.0
 */
export const layer = (options: {
  readonly model: (string & {}) | Model
  readonly config?: Omit<typeof Config.Service, "model"> | undefined
}): Layer.Layer<LanguageModel.LanguageModel, never, AnthropicClient> =>
  Layer.effect(LanguageModel.LanguageModel, make(options))

/**
 * Provides config overrides for Anthropic language model operations.
 *
 * **When to use**
 *
 * Use to apply Anthropic request configuration to one effect without changing
 * the model's default configuration.
 *
 * **Details**
 *
 * The overrides are merged with any existing `Config` service for the duration
 * of the supplied effect. Fields in `overrides` take precedence over existing
 * config, and the helper supports both `effect.pipe(withConfigOverride(overrides))`
 * and `withConfigOverride(effect, overrides)`.
 *
 * @see {@link Config} for available Anthropic request configuration fields
 *
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

const prepareMessages = Effect.fnUntraced(
  function*<Tools extends ReadonlyArray<Tool.Any>>({ betas, options, toolNameMapper }: {
    readonly betas: Set<string>
    readonly options: LanguageModel.ProviderOptions
    readonly toolNameMapper: Tool.NameMapper<Tools>
  }): Effect.fn.Return<{
    readonly system: ReadonlyArray<typeof Generated.BetaRequestTextBlock.Encoded> | undefined
    readonly messages: ReadonlyArray<typeof Generated.BetaInputMessage.Encoded>
  }, AiError.AiError> {
    const groups = groupMessages(options.prompt)

    let system: Array<typeof Generated.BetaRequestTextBlock.Encoded> | undefined = undefined
    const messages: Array<typeof Generated.BetaInputMessage.Encoded> = []

    for (let i = 0; i < groups.length; i++) {
      const group = groups[i]
      const isLastGroup = i === groups.length - 1

      switch (group.type) {
        case "system": {
          system = group.messages.map((message) => ({
            type: "text",
            text: message.content,
            cache_control: getCacheControl(message)
          }))
          break
        }

        case "user": {
          const content: Array<typeof Generated.BetaInputContentBlock.Encoded> = []

          for (const message of group.messages) {
            switch (message.role) {
              case "user": {
                for (let j = 0; j < message.content.length; j++) {
                  const part = message.content[j]
                  const isLastPart = j === message.content.length - 1

                  // Attempt to get the cache control from the part first. If
                  // the part does not have cache control defined and we are
                  // evaluating the last part for this message, also check the
                  // message for cache control.
                  const cacheControl = getCacheControl(part) ?? (
                    isLastPart ? getCacheControl(message) : null
                  )

                  switch (part.type) {
                    case "text": {
                      content.push({
                        type: "text",
                        text: part.text,
                        cache_control: cacheControl
                      })
                      break
                    }

                    case "file": {
                      if (part.mediaType.startsWith("image/")) {
                        const mediaType: typeof Generated.Base64ImageSource.Type["media_type"] =
                          (part.mediaType === "image/*" ? "image/jpeg" : part.mediaType) as any

                        const source = isUrlData(part.data)
                          ? { type: "url", url: getUrlString(part.data) } as const
                          : { type: "base64", media_type: mediaType, data: Encoding.encodeBase64(part.data) } as const

                        content.push({ type: "image", source, cache_control: cacheControl })
                      } else if (part.mediaType === "application/pdf" || part.mediaType === "text/plain") {
                        betas.add("pdfs-2024-09-25")

                        const enableCitations = areCitationsEnabled(part)
                        const documentOptions = getDocumentMetadata(part)

                        const source = isUrlData(part.data)
                          ? {
                            type: "url",
                            url: getUrlString(part.data)
                          } as const
                          : part.mediaType === "application/pdf"
                          ? {
                            type: "base64",
                            media_type: "application/pdf",
                            data: typeof part.data === "string" ? part.data : Encoding.encodeBase64(part.data)
                          } as const
                          : {
                            type: "text",
                            media_type: "text/plain",
                            data: typeof part.data === "string" ? part.data : Encoding.encodeBase64(part.data)
                          } as const

                        content.push({
                          type: "document",
                          source,
                          title: documentOptions?.title ?? part.fileName ?? null,
                          cache_control: cacheControl,
                          ...(documentOptions?.context ? { context: documentOptions.context } : undefined),
                          ...(enableCitations ? { citations: { enabled: true } } : undefined)
                        })
                      } else {
                        return yield* new AiError.AiError({
                          module: "AnthropicLanguageModel",
                          method: "prepareMessages",
                          reason: new AiError.InvalidUserInputError({
                            description: `Detected unsupported media type for file: '${part.mediaType}'`
                          })
                        })
                      }

                      break
                    }
                  }
                }
                break
              }

              case "tool": {
                for (let j = 0; j < message.content.length; j++) {
                  const part = message.content[j]

                  // Skip evaluation of tool approval parts
                  if (part.type === "tool-approval-response") {
                    continue
                  }

                  const isLastPart = j === message.content.length - 1

                  // Attempt to get the cache control from the part first. If
                  // the part does not have cache control defined and we are
                  // evaluating the last part for this message, also check the
                  // message for cache control.
                  const cacheControl = getCacheControl(part) ?? (
                    isLastPart ? getCacheControl(message) : null
                  )

                  content.push({
                    type: "tool_result",
                    tool_use_id: part.id,
                    content: JSON.stringify(part.result),
                    is_error: part.isFailure,
                    cache_control: cacheControl
                  })
                }
              }
            }
          }

          messages.push({ role: "user", content })

          break
        }

        case "assistant": {
          const content: Array<typeof Generated.BetaContentBlock.Encoded> = []
          const mcpToolIds = new Set<string>()

          for (let j = 0; j < group.messages.length; j++) {
            const message = group.messages[j]
            const isLastMessage = j === group.messages.length - 1

            for (let k = 0; k < message.content.length; k++) {
              const part = message.content[k]

              if (part.type === "file" || part.type === "tool-approval-request") {
                continue
              }

              const isLastPart = k === message.content.length - 1

              // Attempt to get the cache control from the part first. If
              // the part does not have cache control defined and we are
              // evaluating the last part for this message, also check the
              // message for cache control.
              const cacheControl = getCacheControl(part) ?? (
                isLastPart ? getCacheControl(message) : undefined
              )

              // TODO: use cache_control in content blocks
              void cacheControl

              switch (part.type) {
                case "text": {
                  content.push({
                    type: "text",
                    // Anthropic does not allow trailing whitespace in assistant
                    // content blocks
                    text: isLastGroup && isLastMessage && isLastPart
                      ? part.text.trim()
                      : part.text
                  })
                  break
                }
                case "reasoning": {
                  // TODO: make sending reasoning configurable
                  const info = part.options.anthropic?.info
                  if (Predicate.isNotNullish(info)) {
                    if (info.type === "thinking") {
                      content.push({
                        type: "thinking",
                        thinking: part.text,
                        signature: info.signature
                      })
                    } else {
                      content.push({
                        type: "redacted_thinking",
                        data: info.redactedData
                      })
                    }
                  }
                  break
                }

                case "tool-call": {
                  if (part.providerExecuted) {
                    const toolName = toolNameMapper.getProviderName(part.name)

                    const isMcpTool = Predicate.isNotNullish(part.options.anthropic?.mcp_tool)

                    if (isMcpTool) {
                      const { server } = part.options.anthropic.mcp_tool

                      mcpToolIds.add(part.id)

                      content.push({
                        type: "mcp_tool_use",
                        id: part.id,
                        name: part.name,
                        input: part.params as any,
                        server_name: server
                      })
                    } else if (
                      toolName === "code_execution" &&
                      Predicate.hasProperty(part.params, "type") &&
                      (
                        part.params.type === "bash_code_execution" ||
                        part.params.type === "text_editor_code_execution"
                      )
                    ) {
                      content.push({
                        type: "server_tool_use",
                        id: part.id,
                        name: part.params.type,
                        input: part.params as any
                      })
                    } else if (
                      // code execution 20250825 programmatic tool calling:
                      // Strip the fake 'programmatic-tool-call' type before sending to Anthropic
                      toolName === "code_execution" &&
                      Predicate.hasProperty(part.params, "type") &&
                      part.params.type === "programmatic-tool-call"
                    ) {
                      const { type, ...params } = part.params
                      content.push({
                        type: "server_tool_use",
                        id: part.id,
                        name: toolName,
                        input: params as any
                      })
                    } else {
                      if (
                        // code execution 20250522
                        toolName === "code_execution" ||
                        toolName === "tool_search_tool_regex" ||
                        toolName === "tool_search_tool_bm25" ||
                        toolName === "web_fetch" ||
                        toolName === "web_search"
                      ) {
                        content.push({
                          type: "server_tool_use",
                          id: part.id,
                          name: toolName,
                          input: part.params as any
                        })
                      }
                    }
                  } else {
                    // Extract caller info from provider options for programmatic tool calling
                    const options = part.options.anthropic
                    const caller = Predicate.isNotNullish(options?.caller)
                      ? (
                          options.caller.type === "code_execution_20250825" &&
                          Predicate.isNotNullish(options.caller.toolId)
                        )
                        ? {
                          type: "code_execution_20250825",
                          tool_id: options.caller.toolId
                        } as const
                        : options.caller.type === "direct"
                        ? {
                          type: "direct"
                        } as const
                        : undefined
                      : undefined

                    content.push({
                      type: "tool_use",
                      id: part.id,
                      name: part.name,
                      input: part.params as any,
                      ...(Predicate.isNotUndefined(caller) ? { caller } : undefined)
                    })
                  }

                  break
                }

                case "tool-result": {
                  const toolName = toolNameMapper.getProviderName(part.name)

                  if (mcpToolIds.has(part.id)) {
                    content.push({
                      type: "mcp_tool_result",
                      tool_use_id: part.id,
                      is_error: part.isFailure,
                      content: part.result as any
                    })
                    break
                  }

                  if (toolName === "code_execution" && Predicate.hasProperty(part.result, "type")) {
                    if (part.result.type === "code_execution_result") {
                      content.push({
                        type: "code_execution_tool_result",
                        tool_use_id: part.id,
                        content: part.result as any
                      })
                    } else if (
                      part.result.type === "bash_code_execution_result" ||
                      part.result.type === "bash_code_execution_tool_result_error"
                    ) {
                      content.push({
                        type: "bash_code_execution_tool_result",
                        tool_use_id: part.id,
                        content: part.result as any
                      })
                    } else if (
                      part.result.type === "text_editor_code_execution_tool_result" ||
                      part.result.type === "text_editor_code_execution_tool_result_error"
                    ) {
                      content.push({
                        type: "text_editor_code_execution_tool_result",
                        tool_use_id: part.id,
                        content: part.result as any
                      })
                    }
                    break
                  }

                  if (toolName === "web_fetch") {
                    content.push({
                      type: "web_fetch_tool_result",
                      tool_use_id: part.id,
                      content: part.result as any
                    })
                    break
                  }

                  if (toolName === "web_search") {
                    content.push({
                      type: "web_search_tool_result",
                      tool_use_id: part.id,
                      content: part.result as any
                    })
                    break
                  }

                  if (
                    toolName === "tool_search_tool_regex" ||
                    toolName === "tool_search_tool_bm25"
                  ) {
                    content.push({
                      type: "tool_search_tool_result",
                      tool_use_id: part.id,
                      content: part.result as any
                    })
                    break
                  }

                  break
                }
              }
            }
          }

          messages.push({ role: "assistant", content })

          break
        }
      }
    }

    return {
      system,
      messages
    }
  }
)

// =============================================================================
// Tool Conversion
// =============================================================================

/**
 * Encoded Anthropic custom tool definition that can be sent in a Messages API request.
 *
 * **When to use**
 *
 * Use when you need to type or inspect the provider-specific request payload for
 * a custom Anthropic tool.
 *
 * **Details**
 *
 * This type aliases the encoded `Generated.BetaTool` schema used for Effect
 * user-defined and dynamic tools after conversion. It contains the tool `name`,
 * optional `description`, and `input_schema`, plus Anthropic-specific fields
 * such as `strict` and `cache_control`.
 *
 * @see {@link AnthropicProviderDefinedTool} for the request shape used by Anthropic built-in provider tools
 *
 * @category tools
 * @since 4.0.0
 */
export type AnthropicUserDefinedTool = typeof Generated.BetaTool.Encoded

/**
 * Represents a provider-defined tool that can be passed to the Anthropic API.
 *
 * **Details**
 *
 * These include Anthropic's built-in tools like computer use, code execution,
 * web search, and text editing.
 *
 * @category tools
 * @since 4.0.0
 */
export type AnthropicProviderDefinedTool =
  | typeof Generated.BetaBashTool_20241022.Encoded
  | typeof Generated.BetaBashTool_20250124.Encoded
  | typeof Generated.BetaCodeExecutionTool_20250522.Encoded
  | typeof Generated.BetaCodeExecutionTool_20250825.Encoded
  | typeof Generated.BetaComputerUseTool_20241022.Encoded
  | typeof Generated.BetaComputerUseTool_20250124.Encoded
  | typeof Generated.BetaComputerUseTool_20251124.Encoded
  | typeof Generated.BetaMemoryTool_20250818.Encoded
  | typeof Generated.BetaTextEditor_20241022.Encoded
  | typeof Generated.BetaTextEditor_20250124.Encoded
  | typeof Generated.BetaTextEditor_20250429.Encoded
  | typeof Generated.BetaTextEditor_20250728.Encoded
  | typeof Generated.BetaToolSearchToolBM25_20251119.Encoded
  | typeof Generated.BetaToolSearchToolRegex_20251119.Encoded
  | typeof Generated.BetaWebFetchTool_20250910.Encoded
  | typeof Generated.BetaWebSearchTool_20250305.Encoded

const prepareTools = Effect.fnUntraced(
  function*({ betas, capabilities, config, options }: {
    readonly betas: Set<string>
    readonly capabilities: ModelCapabilities
    readonly config: typeof Config.Service
    readonly options: LanguageModel.ProviderOptions
  }): Effect.fn.Return<{
    readonly tools: ReadonlyArray<AnthropicUserDefinedTool | AnthropicProviderDefinedTool> | undefined
    readonly toolChoice: typeof Generated.BetaToolChoice.Encoded | undefined
  }, AiError.AiError> {
    if (options.tools.length === 0 || options.toolChoice === "none") {
      return { tools: undefined, toolChoice: undefined }
    }

    // Return a JSON response tool when using non-native structured outputs
    if (options.responseFormat.type === "json" && !capabilities.supportsStructuredOutput) {
      const input_schema = yield* tryJsonSchema(options.responseFormat.schema, "prepareTools")
      const userDescription = SchemaAST.resolveDescription(options.responseFormat.schema.ast)
      const description = Predicate.isNotUndefined(userDescription) ? `${userDescription} - ` : ""
      return {
        tools: [{
          name: options.responseFormat.objectName,
          description: `${description}You MUST respond with a JSON object.`,
          input_schema: input_schema as any
        }],
        toolChoice: {
          type: "tool",
          name: options.responseFormat.objectName,
          disable_parallel_tool_use: true
        }
      }
    }

    const userTools: Array<AnthropicUserDefinedTool> = []
    const providerTools: Array<AnthropicProviderDefinedTool> = []

    for (const tool of options.tools) {
      if (Tool.isUserDefined(tool) || Tool.isDynamic(tool)) {
        const description = Tool.getDescription(tool)
        const input_schema = yield* tryToolJsonSchema(tool, "prepareTools")
        const toolStrict = Tool.getStrictMode(tool)
        const strict = capabilities.supportsStructuredOutput
          ? (toolStrict ?? config.strictJsonSchema ?? true)
          : undefined

        userTools.push({
          name: tool.name,
          input_schema: input_schema as any,
          ...(Predicate.isNotUndefined(description) ? { description } : undefined),
          ...(Predicate.isNotUndefined(strict) ? { strict } : undefined)
        })

        if (capabilities.supportsStructuredOutput === true) {
          betas.add("structured-outputs-2025-11-13")
        }
      }

      if (Tool.isProviderDefined(tool)) {
        const providerTool = tool as AnthropicTool
        switch (providerTool.id) {
          case "anthropic.bash_20241022": {
            betas.add("computer-use-2024-10-22")
            providerTools.push({ name: "bash", type: "bash_20241022" })
            break
          }

          case "anthropic.bash_20250124": {
            betas.add("computer-use-2025-01-24")
            providerTools.push({ name: "bash", type: "bash_20250124" })
            break
          }

          case "anthropic.code_execution_20250522": {
            betas.add("code-execution-2025-05-22")
            providerTools.push({ name: "code_execution", type: "code_execution_20250522" })
            break
          }

          case "anthropic.code_execution_20250825": {
            betas.add("code-execution-2025-08-25")
            providerTools.push({ name: "code_execution", type: "code_execution_20250825" })
            break
          }

          case "anthropic.computer_use_20241022": {
            betas.add("computer-use-2024-10-22")
            providerTools.push({
              name: "computer",
              type: "computer_20241022",
              display_height_px: providerTool.args.displayHeightPx,
              display_width_px: providerTool.args.displayWidthPx,
              display_number: providerTool.args.displayNumber ?? null
            })
            break
          }

          case "anthropic.computer_20250124": {
            betas.add("computer-use-2025-01-24")
            providerTools.push({
              name: "computer",
              type: "computer_20250124",
              display_height_px: providerTool.args.displayHeightPx,
              display_width_px: providerTool.args.displayWidthPx,
              display_number: providerTool.args.displayNumber ?? null
            })
            break
          }

          case "anthropic.computer_20251124": {
            betas.add("computer-use-2025-11-24")
            providerTools.push({
              name: "computer",
              type: "computer_20251124",
              display_height_px: providerTool.args.displayHeightPx,
              display_width_px: providerTool.args.displayWidthPx,
              display_number: providerTool.args.displayNumber ?? null,
              enable_zoom: providerTool.args.enableZoom ?? false
            })
            break
          }

          case "anthropic.memory_20250818": {
            betas.add("context-management-2025-06-27")
            providerTools.push({ name: "memory", type: "memory_20250818" })
            break
          }

          case "anthropic.text_editor_20241022": {
            betas.add("computer-use-2024-10-22")
            providerTools.push({ name: "str_replace_editor", type: "text_editor_20241022" })
            break
          }

          case "anthropic.text_editor_20250124": {
            betas.add("computer-use-2025-01-24")
            providerTools.push({ name: "str_replace_editor", type: "text_editor_20250124" })
            break
          }

          case "anthropic.text_editor_20250429": {
            betas.add("computer-use-2025-01-24")
            providerTools.push({ name: "str_replace_based_edit_tool", type: "text_editor_20250429" })
            break
          }

          case "anthropic.text_editor_20250728": {
            providerTools.push({
              name: "str_replace_based_edit_tool",
              type: "text_editor_20250728",
              max_characters: providerTool.args.max_characters ?? null
            })
            break
          }

          case "anthropic.tool_search_tool_bm25_20251119": {
            betas.add("advanced-tool-use-2025-11-20")
            providerTools.push({ name: "tool_search_tool_bm25", type: "tool_search_tool_bm25_20251119" })
            break
          }

          case "anthropic.tool_search_tool_regex_20251119": {
            providerTools.push({ name: "tool_search_tool_regex", type: "tool_search_tool_regex_20251119" })
            break
          }

          case "anthropic.web_search_20250305": {
            providerTools.push({
              name: "web_search",
              type: "web_search_20250305",
              max_uses: providerTool.args.maxUses ?? null,
              allowed_domains: providerTool.args.allowedDomains ?? null,
              blocked_domains: providerTool.args.blockedDomains ?? null,
              user_location: Predicate.isNotUndefined(providerTool.args.userLocation)
                ? {
                  type: providerTool.args.userLocation.type,
                  region: providerTool.args.userLocation.region ?? null,
                  city: providerTool.args.userLocation.city ?? null,
                  country: providerTool.args.userLocation.country ?? null,
                  timezone: providerTool.args.userLocation.timezone ?? null
                }
                : null
            })
            break
          }

          case "anthropic.web_fetch_20250910": {
            betas.add("web-fetch-2025-09-10")
            providerTools.push({
              name: "web_fetch",
              type: "web_fetch_20250910",
              max_uses: providerTool.args.maxUses ?? null,
              allowed_domains: providerTool.args.allowedDomains ?? null,
              blocked_domains: providerTool.args.blockedDomains ?? null,
              citations: providerTool.args.citations ?? null,
              max_content_tokens: providerTool.args.maxContentTokens ?? null
            })
            break
          }

          default: {
            return yield* AiError.make({
              module: "AnthropicLanguageModel",
              method: "prepareTools",
              reason: new AiError.InvalidUserInputError({
                description: `Received request to call unknown provider-defined tool '${tool.name}'`
              })
            })
          }
        }
      }
    }

    let tools = [...userTools, ...providerTools]
    let toolChoice: Mutable<typeof Generated.BetaToolChoice.Encoded> | undefined = undefined

    if (options.toolChoice === "auto") {
      toolChoice = { type: "auto" }
    } else if (options.toolChoice === "required") {
      toolChoice = { type: "any" }
    } else if ("tool" in options.toolChoice) {
      toolChoice = { type: "tool", name: options.toolChoice.tool }
    } else {
      const allowedTools = new Set(options.toolChoice.oneOf)
      tools = tools.filter((tool) => allowedTools.has(tool.name))
      toolChoice = { type: options.toolChoice.mode === "required" ? "any" : "auto" }
    }

    if (
      Predicate.isNotUndefined(config.disableParallelToolCalls) &&
      Predicate.isNotUndefined(toolChoice) &&
      toolChoice.type !== "none"
    ) {
      toolChoice.disable_parallel_tool_use = config.disableParallelToolCalls
    }

    return {
      tools,
      toolChoice
    }
  }
)

// =============================================================================
// HTTP Details
// =============================================================================

const buildHttpRequestDetails = (
  request: HttpClientRequest.HttpClientRequest
): typeof Response.HttpRequestDetails.Type => ({
  method: request.method,
  url: request.url,
  urlParams: Array.from(request.urlParams),
  hash: Option.getOrUndefined(request.hash),
  headers: Redactable.redact(request.headers) as Record<string, string>
})

const buildHttpResponseDetails = (
  response: HttpClientResponse.HttpClientResponse
): typeof Response.HttpResponseDetails.Type => ({
  status: response.status,
  headers: Redactable.redact(response.headers) as Record<string, string>
})

// =============================================================================
// Response Conversion
// =============================================================================

const makeResponse = Effect.fnUntraced(
  function*<Tools extends ReadonlyArray<Tool.Any>>({
    options,
    rawResponse,
    response,
    toolNameMapper
  }: {
    readonly options: LanguageModel.ProviderOptions
    readonly rawResponse: Generated.BetaMessage
    readonly response: HttpClientResponse.HttpClientResponse
    readonly toolNameMapper: Tool.NameMapper<Tools>
  }): Effect.fn.Return<
    Array<Response.PartEncoded>,
    AiError.AiError,
    IdGenerator.IdGenerator
  > {
    const parts: Array<Response.PartEncoded> = []
    const mcpToolCalls: Map<string, Response.ToolCallPartEncoded> = new Map()
    const serverToolCalls: Map<string, string> = new Map()
    const citableDocuments = extractCitableDocuments(options.prompt)

    parts.push({
      type: "response-metadata",
      id: rawResponse.id,
      modelId: rawResponse.model,
      timestamp: DateTime.formatIso(yield* DateTime.now),
      request: buildHttpRequestDetails(response.request)
    })

    for (const part of rawResponse.content) {
      switch (part.type) {
        case "text": {
          // Text parts are added for both text and json response formats.
          // For native structured output (json_schema), the JSON comes directly
          // in a text content block. For tool-based structured output, text may
          // also be present alongside the tool_use.
          parts.push({
            type: "text",
            text: part.text
          })

          if (Predicate.isNotNullish(part.citations)) {
            for (const citation of part.citations) {
              const source = yield* processCitation(citation, citableDocuments)
              if (Predicate.isNotUndefined(source)) {
                parts.push(source)
              }
            }
          }

          break
        }

        case "thinking": {
          const metadata = {
            info: { type: "thinking", signature: part.signature }
          } as const

          parts.push({
            type: "reasoning",
            text: part.thinking,
            metadata: { anthropic: metadata }
          })
          break
        }

        case "redacted_thinking": {
          const metadata = {
            info: { type: "redacted_thinking", redactedData: part.data }
          } as const

          parts.push({
            type: "reasoning",
            text: "",
            metadata: { anthropic: metadata }
          })
          break
        }

        case "tool_use": {
          // When the `"json"` response format is requested, the JSON we need
          // is returned by a tool call injected into the request
          if (options.responseFormat.type === "json") {
            parts.push({
              type: "text",
              text: JSON.stringify(part.input)
            })
          } else {
            // Extract caller info if present
            const caller = (part as any).caller
            const callerInfo = Predicate.isNotNullish(caller)
              ? {
                type: caller.type,
                toolId: "tool_id" in caller ? caller.tool_id : undefined
              }
              : undefined

            const params = yield* transformToolCallParams(options.tools, part.name, part.input)

            parts.push({
              type: "tool-call",
              id: part.id,
              name: part.name,
              params,
              ...(Predicate.isNotUndefined(callerInfo)
                ? { metadata: { anthropic: { caller: callerInfo } } }
                : undefined)
            })
          }

          break
        }

        case "server_tool_use": {
          const toolName = toolNameMapper.getCustomName(part.name)

          if (
            part.name === "bash_code_execution" ||
            part.name === "text_editor_code_execution"
          ) {
            parts.push({
              type: "tool-call",
              id: part.id,
              name: toolName,
              params: { type: part.name, ...part.input },
              providerExecuted: true
            })
          } else if (
            part.name === "code_execution" ||
            part.name === "web_fetch" ||
            part.name === "web_search"
          ) {
            const toolParams: Record<string, unknown> = { ...part.input }

            // Inject `type: "programmatic-tool-call"` when the input parameters
            // has the format `{ code: ... }`
            if (
              part.name === "code_execution" &&
              Predicate.hasProperty(part.input, "code") &&
              !Predicate.hasProperty(part.input, "type")
            ) {
              toolParams.type = "programmatic-tool-call"
            }

            parts.push({
              type: "tool-call",
              id: part.id,
              name: toolName,
              params: toolParams,
              providerExecuted: true
            })
          } else if (
            part.name === "tool_search_tool_bm25" ||
            part.name === "tool_search_tool_regex"
          ) {
            serverToolCalls.set(part.id, part.name)
            parts.push({
              type: "tool-call",
              id: part.id,
              name: toolName,
              params: part.input,
              providerExecuted: true
            })
          }

          break
        }

        case "mcp_tool_use": {
          const toolCall: Response.ToolCallPartEncoded = {
            type: "tool-call",
            id: part.id,
            name: part.name,
            params: part.input,
            providerExecuted: true,
            metadata: { anthropic: { mcp_tool: { server: part.server_name } } }
          }

          mcpToolCalls.set(part.id, toolCall)

          parts.push(toolCall)

          break
        }

        case "mcp_tool_result": {
          const toolCall = mcpToolCalls.get(part.tool_use_id)
          const mcpMetadata = toolCall?.metadata?.anthropic?.mcp_tool

          if (Predicate.isNotUndefined(toolCall)) {
            parts.push({
              type: "tool-result",
              id: part.tool_use_id,
              name: toolCall.name,
              isFailure: part.is_error,
              result: part.content,
              metadata: {
                anthropic: {
                  ...(Predicate.isNotNullish(mcpMetadata)
                    ? { mcp_tool: mcpMetadata } :
                    undefined)
                }
              }
            })
          }

          break
        }

        // Code Execution 20250522
        case "code_execution_tool_result": {
          const toolName = toolNameMapper.getCustomName("code_execution")

          if (part.content.type === "code_execution_result") {
            parts.push({
              type: "tool-result",
              id: part.tool_use_id,
              name: toolName,
              isFailure: false,
              result: part.content
            })
          } else {
            parts.push({
              type: "tool-result",
              id: part.tool_use_id,
              name: toolName,
              isFailure: true,
              result: part.content
            })
          }

          break
        }

        // Code Execution 20250825
        case "bash_code_execution_tool_result":
        case "text_editor_code_execution_tool_result": {
          const toolName = toolNameMapper.getCustomName("code_execution")

          if (
            part.content.type === "bash_code_execution_tool_result_error" ||
            part.content.type === "text_editor_code_execution_tool_result_error"
          ) {
            parts.push({
              type: "tool-result",
              id: part.tool_use_id,
              name: toolName,
              isFailure: true,
              result: part.content
            })
          } else {
            parts.push({
              type: "tool-result",
              id: part.tool_use_id,
              name: toolName,
              isFailure: false,
              result: part.content
            })
          }

          break
        }

        case "tool_search_tool_result": {
          let providerName = serverToolCalls.get(part.tool_use_id)

          if (Predicate.isUndefined(providerName)) {
            const bm25Name = toolNameMapper.getCustomName("tool_search_tool_bm25")
            const regexName = toolNameMapper.getCustomName("tool_search_tool_regex")

            if (bm25Name !== "tool_search_tool_bm25") {
              providerName = "tool_search_tool_bm25"
            } else if (regexName !== "tool_search_tool_regex") {
              providerName = "tool_search_tool_regex"
            }
          }

          const toolName = toolNameMapper.getCustomName(providerName!)

          if (part.content.type === "tool_search_tool_search_result") {
            parts.push({
              type: "tool-result",
              id: part.tool_use_id,
              name: toolName,
              isFailure: false,
              result: part.content.tool_references
            })
          } else {
            parts.push({
              type: "tool-result",
              id: part.tool_use_id,
              name: toolName,
              isFailure: true,
              result: part.content
            })
          }

          break
        }

        case "web_fetch_tool_result": {
          const toolName = toolNameMapper.getCustomName("web_fetch")

          if (part.content.type === "web_fetch_result") {
            citableDocuments.push({
              title: part.content.content.title ?? part.content.url,
              mediaType: part.content.content.source.media_type
            })

            parts.push({
              type: "tool-result",
              id: part.tool_use_id,
              name: toolName,
              isFailure: false,
              result: part.content
            })
          } else {
            parts.push({
              type: "tool-result",
              id: part.tool_use_id,
              name: toolName,
              isFailure: true,
              result: part.content
            })
          }

          break
        }

        case "web_search_tool_result": {
          const toolName = toolNameMapper.getCustomName("web_search")

          if (Predicate.hasProperty(part.content, "type")) {
            parts.push({
              type: "tool-result",
              id: part.tool_use_id,
              name: toolName,
              isFailure: true,
              result: part.content
            })
          } else {
            const idGenerator = yield* IdGenerator.IdGenerator

            parts.push({
              type: "tool-result",
              id: part.tool_use_id,
              name: toolName,
              isFailure: false,
              result: part.content
            })

            const content = part.content as ReadonlyArray<Generated.BetaResponseWebSearchResultBlock>

            for (const result of content) {
              const id = yield* idGenerator.generateId()

              parts.push({
                type: "source",
                sourceType: "url",
                id,
                url: result.url,
                title: result.title,
                metadata: { anthropic: { source: "web", pageAge: result.page_age } }
              })
            }
          }

          break
        }
      }
    }

    // Anthropic always returns a non-null `stop_reason` for non-streaming responses
    const finishReason = InternalUtilities.resolveFinishReason(
      rawResponse.stop_reason!,
      options.responseFormat.type === "json"
    )

    const inputTokens = rawResponse.usage.input_tokens
    const outputTokens = rawResponse.usage.output_tokens
    const cacheWriteTokens = rawResponse.usage.cache_creation_input_tokens ?? 0
    const cacheReadTokens = rawResponse.usage.cache_read_input_tokens ?? 0

    parts.push({
      type: "finish",
      reason: finishReason,
      usage: {
        inputTokens: {
          uncached: inputTokens,
          total: inputTokens + cacheWriteTokens + cacheReadTokens,
          cacheRead: cacheReadTokens,
          cacheWrite: cacheWriteTokens
        },
        outputTokens: {
          total: outputTokens,
          text: undefined,
          reasoning: undefined
        }
      },
      response: buildHttpResponseDetails(response),
      metadata: {
        anthropic: {
          container: rawResponse.container ?? null,
          contextManagement: rawResponse.context_management ?? null,
          usage: rawResponse.usage,
          stopSequence: rawResponse.stop_sequence
        }
      }
    })

    return parts
  }
)

const makeStreamResponse = Effect.fnUntraced(
  function*<Tools extends ReadonlyArray<Tool.Any>>({
    stream,
    response,
    options,
    toolNameMapper
  }: {
    readonly stream: Stream.Stream<MessageStreamEvent, AiError.AiError>
    readonly response: HttpClientResponse.HttpClientResponse
    readonly options: LanguageModel.ProviderOptions
    readonly toolNameMapper: Tool.NameMapper<Tools>
  }): Effect.fn.Return<
    Stream.Stream<Response.StreamPartEncoded, AiError.AiError, IdGenerator.IdGenerator>,
    AiError.AiError
  > {
    const citableDocuments = extractCitableDocuments(options.prompt)

    let container: typeof Generated.BetaContainer.Encoded | null = null
    let contextManagement: typeof Generated.BetaResponseContextManagement.Encoded | null = null
    let finishReason: Response.FinishReason = "unknown"
    let stopSequence: string | null = null
    let rawUsage: typeof Generated.BetaMessage.Encoded["usage"] | null = null
    const mcpToolCalls: Map<string, Response.ToolCallPartEncoded> = new Map()
    const serverToolCalls: Map<string, string> = new Map()
    const contentBlocks: Map<
      number,
      | {
        readonly type: "text"
      }
      | {
        readonly type: "reasoning"
      }
      | {
        readonly type: "tool-call"
        readonly id: string
        readonly name: string
        params: string
        firstDelta: boolean
        readonly providerName?: string | undefined
        readonly providerExecuted?: boolean | undefined
        readonly caller?: { type: string; toolId: string | null } | undefined
      }
    > = new Map()
    const usage: Mutable<{
      inputTokens: number
      outputTokens: number
      cacheReadInputTokens: number
      cacheWriteInputTokens: number
    }> = {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadInputTokens: 0,
      cacheWriteInputTokens: 0
    }

    let blockType: typeof Generated.BetaContentBlockStartEvent.Encoded["content_block"]["type"] | undefined = undefined

    return stream.pipe(
      Stream.mapEffect(Effect.fnUntraced(function*(event) {
        const parts: Array<Response.StreamPartEncoded> = []

        switch (event.type) {
          case "message_start": {
            rawUsage = { ...event.message.usage }
            usage.inputTokens = event.message.usage.input_tokens
            usage.cacheReadInputTokens = event.message.usage.cache_read_input_tokens ?? 0
            usage.cacheWriteInputTokens = event.message.usage.cache_creation_input_tokens ?? 0

            if (Predicate.isNotNullish(event.message.container)) {
              container = event.message.container
            }

            if (Predicate.isNotNull(event.message.stop_sequence)) {
              stopSequence = event.message.stop_sequence
            }

            if (Predicate.isNotNull(event.message.stop_reason)) {
              finishReason = InternalUtilities.resolveFinishReason(event.message.stop_reason)
            }

            parts.push({
              type: "response-metadata",
              id: event.message.id,
              modelId: event.message.model,
              timestamp: DateTime.formatIso(yield* DateTime.now),
              request: buildHttpRequestDetails(response.request)
            })

            // Process pre-populated content blocks
            if (Predicate.isNotNullish(event.message.content) && event.message.content.length > 0) {
              for (let i = 0; i < event.message.content.length; i++) {
                const part = event.message.content[i]

                if (part.type === "tool_use") {
                  const callerInfo = Predicate.isNotUndefined(part.caller)
                    ? {
                      type: part.caller.type,
                      toolId: "tool_id" in part.caller ? part.caller.tool_id : null
                    }
                    : undefined

                  parts.push({
                    type: "tool-params-start",
                    id: part.id,
                    name: part.name
                  })

                  parts.push({
                    type: "tool-params-delta",
                    id: part.id,
                    delta: JSON.stringify(part.input ?? {})
                  })

                  parts.push({
                    type: "tool-params-end",
                    id: part.id
                  })

                  const params = yield* transformToolCallParams(options.tools, part.name, part.input)

                  parts.push({
                    type: "tool-call",
                    id: part.id,
                    name: part.name,
                    params,
                    ...(Predicate.isNotUndefined(callerInfo)
                      ? { metadata: { anthropic: { caller: callerInfo } } }
                      : undefined)
                  })
                }
              }
            }

            break
          }

          case "message_delta": {
            rawUsage = { ...rawUsage, ...event.usage } as any

            if (
              Predicate.isNotNull(event.usage.input_tokens) &&
              usage.inputTokens !== event.usage.input_tokens
            ) {
              usage.inputTokens = event.usage.input_tokens
            }
            usage.outputTokens = event.usage.output_tokens

            if (
              Predicate.isNotNull(event.usage.cache_read_input_tokens) &&
              usage.cacheReadInputTokens !== event.usage.cache_read_input_tokens
            ) {
              usage.cacheReadInputTokens = event.usage.cache_read_input_tokens
            }
            if (
              Predicate.isNotNull(event.usage.cache_creation_input_tokens) &&
              usage.cacheWriteInputTokens !== event.usage.cache_creation_input_tokens
            ) {
              usage.cacheWriteInputTokens = event.usage.cache_creation_input_tokens
            }

            if (Predicate.isNotNullish(event.delta.container)) {
              container = event.delta.container
            }

            if (Predicate.isNotNullish(event.context_management)) {
              contextManagement = event.context_management
            }

            if (Predicate.isNotNull(event.delta.stop_reason)) {
              finishReason = InternalUtilities.resolveFinishReason(event.delta.stop_reason)
            }

            if (Predicate.isNotNull(event.delta.stop_sequence)) {
              stopSequence = event.delta.stop_sequence
            }

            break
          }

          case "message_stop": {
            const metadata: Response.FinishPartMetadata = {
              anthropic: {
                container,
                contextManagement,
                stopSequence,
                usage: rawUsage
              }
            }

            parts.push({
              type: "finish",
              reason: finishReason,
              usage: {
                inputTokens: {
                  uncached: usage.inputTokens,
                  total: usage.inputTokens + usage.cacheWriteInputTokens + usage.cacheReadInputTokens,
                  cacheRead: usage.cacheReadInputTokens,
                  cacheWrite: usage.cacheWriteInputTokens
                },
                outputTokens: {
                  total: usage.outputTokens,
                  text: undefined,
                  reasoning: undefined
                }
              },
              response: buildHttpResponseDetails(response),
              metadata
            })

            break
          }

          case "content_block_start": {
            blockType = event.content_block.type

            switch (event.content_block.type) {
              case "text": {
                contentBlocks.set(event.index, { type: "text" })

                parts.push({
                  type: "text-start",
                  id: event.index.toString()
                })

                break
              }

              case "thinking": {
                contentBlocks.set(event.index, { type: "reasoning" })

                parts.push({
                  type: "reasoning-start",
                  id: event.index.toString()
                })

                break
              }

              case "redacted_thinking": {
                contentBlocks.set(event.index, { type: "reasoning" })

                const metadata: Response.ReasoningStartPartMetadata = {
                  anthropic: {
                    info: {
                      type: "redacted_thinking",
                      redactedData: event.content_block.data
                    }
                  }
                }

                parts.push({
                  type: "reasoning-start",
                  id: event.index.toString(),
                  metadata
                })

                break
              }

              case "tool_use": {
                const part = event.content_block

                const caller = Predicate.isNotUndefined(part.caller)
                  ? {
                    type: part.caller.type,
                    toolId: "tool_id" in part.caller ? part.caller.tool_id : null
                  }
                  : undefined

                const hasParams = Object.keys(part.input).length > 0
                const initialParams = hasParams ? JSON.stringify(part.input) : ""
                contentBlocks.set(event.index, {
                  type: "tool-call",
                  id: part.id,
                  name: part.name,
                  params: initialParams,
                  firstDelta: initialParams.length > 0,
                  ...(Predicate.isNotUndefined(caller) ? { caller } : undefined)
                })

                parts.push({
                  type: "tool-params-start",
                  id: part.id,
                  name: part.name
                })

                break
              }

              case "server_tool_use": {
                const part = event.content_block

                if (
                  part.name === "code_execution" ||
                  part.name === "bash_code_execution" ||
                  part.name === "text_editor_code_execution" ||
                  part.name === "web_fetch" ||
                  part.name === "web_search"
                ) {
                  const toolName = toolNameMapper.getCustomName(
                    part.name === "bash_code_execution" || part.name === "text_editor_code_execution"
                      ? "code_execution"
                      : part.name
                  )

                  contentBlocks.set(event.index, {
                    type: "tool-call",
                    id: part.id,
                    name: toolName,
                    params: "",
                    firstDelta: true,
                    providerName: part.name,
                    providerExecuted: true
                  })

                  parts.push({
                    type: "tool-params-start",
                    id: part.id,
                    name: toolName,
                    providerExecuted: true
                  })
                } else if (
                  part.name === "tool_search_tool_bm25" ||
                  part.name === "tool_search_tool_regex"
                ) {
                  serverToolCalls.set(part.id, part.name)

                  const toolName = toolNameMapper.getCustomName(part.name)

                  contentBlocks.set(event.index, {
                    type: "tool-call",
                    id: part.id,
                    name: toolName,
                    params: "",
                    firstDelta: true,
                    providerName: part.name,
                    providerExecuted: true
                  })

                  parts.push({
                    type: "tool-params-start",
                    id: part.id,
                    name: toolName,
                    providerExecuted: true
                  })
                }

                break
              }

              case "web_fetch_tool_result": {
                const part = event.content_block
                const toolName = toolNameMapper.getCustomName("web_fetch")

                if (part.content.type === "web_fetch_result") {
                  citableDocuments.push({
                    title: part.content.content.title ?? part.content.url,
                    mediaType: part.content.content.source.media_type
                  })

                  parts.push({
                    type: "tool-result",
                    id: part.tool_use_id,
                    name: toolName,
                    isFailure: false,
                    result: part.content
                  })
                } else {
                  parts.push({
                    type: "tool-result",
                    id: part.tool_use_id,
                    name: toolName,
                    isFailure: true,
                    result: part.content
                  })
                }

                break
              }

              case "web_search_tool_result": {
                const part = event.content_block
                const toolName = toolNameMapper.getCustomName("web_search")

                if (Predicate.hasProperty(part.content, "type")) {
                  parts.push({
                    type: "tool-result",
                    id: part.tool_use_id,
                    name: toolName,
                    isFailure: true,
                    result: part.content
                  })
                } else {
                  const idGenerator = yield* IdGenerator.IdGenerator

                  parts.push({
                    type: "tool-result",
                    id: part.tool_use_id,
                    name: toolName,
                    isFailure: false,
                    result: part.content
                  })

                  const content = part.content as ReadonlyArray<Generated.BetaResponseWebSearchResultBlock>

                  for (const result of content) {
                    const id = yield* idGenerator.generateId()

                    parts.push({
                      type: "source",
                      sourceType: "url",
                      id,
                      url: result.url,
                      title: result.title,
                      metadata: { anthropic: { source: "web", pageAge: result.page_age } }
                    })
                  }
                }
                break
              }

              case "code_execution_tool_result": {
                const part = event.content_block
                const toolName = toolNameMapper.getCustomName("code_execution")

                if (part.content.type === "code_execution_result") {
                  parts.push({
                    type: "tool-result",
                    id: part.tool_use_id,
                    name: toolName,
                    isFailure: false,
                    result: part.content
                  })
                } else {
                  parts.push({
                    type: "tool-result",
                    id: part.tool_use_id,
                    name: toolName,
                    isFailure: true,
                    result: part.content
                  })
                }
                break
              }

              case "bash_code_execution_tool_result":
              case "text_editor_code_execution_tool_result": {
                const part = event.content_block
                const toolName = toolNameMapper.getCustomName("code_execution")

                if (
                  part.content.type === "bash_code_execution_tool_result_error" ||
                  part.content.type === "text_editor_code_execution_tool_result_error"
                ) {
                  parts.push({
                    type: "tool-result",
                    id: part.tool_use_id,
                    name: toolName,
                    isFailure: true,
                    result: part.content
                  })
                } else {
                  parts.push({
                    type: "tool-result",
                    id: part.tool_use_id,
                    name: toolName,
                    isFailure: false,
                    result: part.content
                  })
                }
                break
              }

              case "tool_search_tool_result": {
                const part = event.content_block
                let providerName = serverToolCalls.get(part.tool_use_id)

                if (Predicate.isUndefined(providerName)) {
                  const bm25Name = toolNameMapper.getCustomName("tool_search_tool_bm25")
                  const regexName = toolNameMapper.getCustomName("tool_search_tool_regex")

                  if (bm25Name !== "tool_search_tool_bm25") {
                    providerName = "tool_search_tool_bm25"
                  } else if (regexName !== "tool_search_tool_regex") {
                    providerName = "tool_search_tool_regex"
                  }
                }

                const toolName = toolNameMapper.getCustomName(providerName!)

                if (part.content.type === "tool_search_tool_search_result") {
                  parts.push({
                    type: "tool-result",
                    id: part.tool_use_id,
                    name: toolName,
                    isFailure: false,
                    result: part.content.tool_references
                  })
                } else {
                  parts.push({
                    type: "tool-result",
                    id: part.tool_use_id,
                    name: toolName,
                    isFailure: true,
                    result: part.content
                  })
                }
                break
              }

              case "mcp_tool_use": {
                const part = event.content_block

                const toolCall: Response.ToolCallPartEncoded = {
                  type: "tool-call",
                  id: part.id,
                  name: part.name,
                  params: part.input,
                  providerExecuted: true,
                  metadata: { anthropic: { mcp_tool: { server: part.server_name } } }
                }

                mcpToolCalls.set(part.id, toolCall)

                parts.push(toolCall)

                break
              }

              case "mcp_tool_result": {
                const part = event.content_block
                const toolCall = mcpToolCalls.get(part.tool_use_id)
                const mcpMetadata = toolCall?.metadata?.anthropic?.mcp_tool

                if (Predicate.isNotUndefined(toolCall)) {
                  parts.push({
                    type: "tool-result",
                    id: part.tool_use_id,
                    name: toolCall.name,
                    isFailure: part.is_error,
                    result: part.content,
                    metadata: {
                      anthropic: {
                        ...(Predicate.isNotNullish(mcpMetadata)
                          ? { mcp_tool: mcpMetadata } :
                          undefined)
                      }
                    }
                  })
                }

                break
              }
            }

            break
          }

          case "content_block_delta": {
            const part = event.delta

            switch (part.type) {
              case "text_delta": {
                parts.push({
                  type: "text-delta",
                  id: event.index.toString(),
                  delta: part.text
                })

                break
              }

              case "thinking_delta": {
                parts.push({
                  type: "reasoning-delta",
                  id: event.index.toString(),
                  delta: part.thinking
                })

                break
              }

              case "signature_delta": {
                if (blockType === "thinking") {
                  parts.push({
                    type: "reasoning-delta",
                    id: event.index.toString(),
                    delta: "",
                    metadata: {
                      anthropic: {
                        info: {
                          type: "thinking",
                          signature: part.signature
                        }
                      }
                    }
                  })
                }

                break
              }

              case "input_json_delta": {
                let delta = part.partial_json

                // Skip empty deltas
                if (delta.length === 0) {
                  break
                }

                const contentBlock = contentBlocks.get(event.index)

                // Skip invalid deltas
                if (Predicate.isUndefined(contentBlock)) {
                  break
                }

                // Skip non-tool-call deltas
                if (contentBlock.type !== "tool-call") {
                  break
                }

                if (
                  contentBlock.firstDelta &&
                  (contentBlock.providerName === "bash_code_execution" ||
                    contentBlock.providerName === "text_editor_code_execution")
                ) {
                  delta = `{"type":${contentBlock.providerName},${delta.substring(1)}}`
                }

                parts.push({
                  type: "tool-params-delta",
                  id: contentBlock.id,
                  delta
                })

                contentBlock.params += delta
                contentBlock.firstDelta = false

                break
              }

              case "citations_delta": {
                const source = yield* processCitation(part.citation, citableDocuments)

                if (Predicate.isNotUndefined(source)) {
                  parts.push(source)
                }

                break
              }
            }

            break
          }

          case "content_block_stop": {
            const contentBlock = contentBlocks.get(event.index)

            if (Predicate.isNotUndefined(contentBlock)) {
              switch (contentBlock.type) {
                case "text": {
                  parts.push({
                    type: "text-end",
                    id: event.index.toString()
                  })

                  break
                }

                case "reasoning": {
                  parts.push({
                    type: "reasoning-end",
                    id: event.index.toString()
                  })

                  break
                }

                case "tool-call": {
                  parts.push({
                    type: "tool-params-end",
                    id: contentBlock.id
                  })

                  // For code execution, inject the `programmatic-tool-call` type
                  // when the input format is `{ code }`
                  let finalParams = contentBlock.params.length === 0 ? "{}" : contentBlock.params

                  if (contentBlock.providerName === "code_execution") {
                    // @effect-diagnostics-next-line tryCatchInEffectGen:off
                    try {
                      const params = Tool.unsafeSecureJsonParse(finalParams)
                      if (Predicate.hasProperty(params, "code") && !Predicate.hasProperty(params, "type")) {
                        finalParams = JSON.stringify({ type: "programmatic-tool-call", ...params })
                      }
                    } catch {
                      // Ignore errors and use original tool call parameters
                    }
                  }

                  const params = contentBlock.providerExecuted === true
                    ? finalParams
                    : yield* transformToolCallParams(
                      options.tools,
                      contentBlock.name,
                      Tool.unsafeSecureJsonParse(finalParams)
                    )

                  parts.push({
                    type: "tool-call",
                    id: contentBlock.id,
                    name: contentBlock.name,
                    params,
                    ...(Predicate.isNotUndefined(contentBlock.providerExecuted)
                      ? { providerExecuted: contentBlock.providerExecuted }
                      : undefined),
                    ...(Predicate.isNotUndefined(contentBlock.caller)
                      ? { metadata: { anthropic: { caller: contentBlock.caller } } }
                      : undefined)
                  })
                }
              }

              contentBlocks.delete(event.index)
            }

            blockType = undefined

            break
          }

          case "error": {
            parts.push({
              type: "error",
              error: event.error,
              metadata: { anthropic: { requestId: event.request_id } }
            })

            break
          }
        }

        return parts
      })),
      Stream.flattenIterable
    )
  }
)

// =============================================================================
// Telemetry
// =============================================================================

const annotateRequest = (
  span: Span,
  request: typeof Generated.BetaCreateMessageParams.Encoded
): void => {
  addGenAIAnnotations(span, {
    system: "anthropic",
    operation: { name: "chat" },
    request: {
      model: request.model,
      temperature: request.temperature,
      topK: request.top_k,
      topP: request.top_p,
      maxTokens: request.max_tokens,
      stopSequences: Arr.ensure(request.stop_sequences).filter(
        Predicate.isNotNullish
      )
    }
  })
}

const annotateResponse = (span: Span, response: Generated.BetaMessage): void => {
  addGenAIAnnotations(span, {
    response: {
      id: response.id,
      model: response.model,
      finishReasons: response.stop_reason ? [response.stop_reason] : undefined
    },
    usage: {
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens
    }
  })
}

const annotateStreamResponse = (span: Span, part: Response.StreamPartEncoded) => {
  if (part.type === "response-metadata") {
    addGenAIAnnotations(span, {
      response: {
        id: part.id,
        model: part.modelId
      }
    })
  }
  if (part.type === "finish") {
    addGenAIAnnotations(span, {
      response: {
        finishReasons: [part.reason]
      },
      usage: {
        inputTokens: part.usage.inputTokens.uncached,
        outputTokens: part.usage.outputTokens.total
      }
    })
  }
}

// =============================================================================
// Internal Utilities
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

/**
 * Checks whether data is a URL (either a URL object or a URL string).
 */
const isUrlData = (
  data: typeof Prompt.FilePart.Type["data"]
): data is URL => data instanceof URL || isUrlString(data)

const isUrlString = (data: typeof Prompt.FilePart.Type["data"]): boolean =>
  typeof data === "string" && /^https?:\/\//i.test(data)

const getUrlString = (data: string | URL): string => data instanceof URL ? data.toString() : data

const getCacheControl = (
  part:
    | Prompt.SystemMessage
    | Prompt.UserMessage
    | Prompt.AssistantMessage
    | Prompt.ToolMessage
    | Prompt.UserMessagePart
    | Prompt.AssistantMessagePart
    | Prompt.ToolMessagePart
): typeof Generated.CacheControlEphemeral.Encoded | null => part.options.anthropic?.cacheControl ?? null

const getDocumentMetadata = (part: Prompt.FilePart): {
  readonly title: string | null
  readonly context: string | null
} | null => {
  const options = part.options.anthropic
  if (Predicate.isNotUndefined(options)) {
    return {
      title: options?.documentTitle ?? null,
      context: options?.documentContext ?? null
    }
  }
  return null
}

const areCitationsEnabled = (part: Prompt.FilePart): boolean => part.options.anthropic?.citations?.enabled ?? false

const isCitationPart = (part: Prompt.UserMessagePart): part is Prompt.FilePart =>
  part.type === "file" && (part.mediaType === "application/pdf" || part.mediaType === "text/plain")
    ? areCitationsEnabled(part)
    : false

interface CitableDocument {
  readonly title: string
  readonly fileName?: string | undefined
  readonly mediaType: string
}

const extractCitableDocuments = (prompt: Prompt.Prompt): Array<CitableDocument> => {
  const citableDocuments: Array<CitableDocument> = []

  for (const message of prompt.content) {
    if (message.role === "user") {
      for (const part of message.content) {
        if (isCitationPart(part)) {
          citableDocuments.push({
            title: part.fileName ?? "Untitled Document",
            fileName: part.fileName,
            mediaType: part.mediaType
          })
        }
      }
    }
  }

  return citableDocuments
}

const processCitation = Effect.fnUntraced(
  function*(
    citation:
      | Generated.ResponseCharLocationCitation
      | Generated.ResponsePageLocationCitation
      | Generated.ResponseContentBlockLocationCitation
      | Generated.ResponseWebSearchResultLocationCitation
      | Generated.ResponseSearchResultLocationCitation,
    citableDocuments: ReadonlyArray<CitableDocument>
  ): Effect.fn.Return<
    Response.DocumentSourcePartEncoded | Response.UrlSourcePartEncoded | undefined,
    never,
    IdGenerator.IdGenerator
  > {
    const idGenerator = yield* IdGenerator.IdGenerator

    if (citation.type === "page_location" || citation.type === "char_location") {
      const citedDocument = citableDocuments[citation.document_index]
      if (Predicate.isNotUndefined(citedDocument)) {
        const id = yield* idGenerator.generateId()
        const metadata = citation.type === "char_location"
          ? {
            source: "document",
            type: citation.type,
            citedText: citation.cited_text,
            startCharIndex: citation.start_char_index,
            endCharIndex: citation.end_char_index
          } as const
          : {
            source: "document",
            type: citation.type,
            citedText: citation.cited_text,
            startPageNumber: citation.start_page_number,
            endPageNumber: citation.end_page_number
          } as const

        return {
          type: "source",
          sourceType: "document",
          id,
          mediaType: citedDocument.mediaType,
          title: citation.document_title ?? citedDocument.title,
          ...(Predicate.isNotUndefined(citedDocument.fileName)
            ? { fileName: citedDocument.fileName }
            : undefined),
          metadata: { anthropic: metadata }
        }
      }
    }

    if (citation.type === "web_search_result_location") {
      const id = yield* idGenerator.generateId()

      const metadata = {
        source: "url",
        citedText: citation.cited_text,
        encryptedIndex: citation.encrypted_index
      } as const

      return {
        type: "source",
        sourceType: "url",
        id,
        url: citation.url,
        title: citation.title ?? "Untitled",
        metadata: { anthropic: metadata }
      }
    }

    return undefined
  }
)

interface ModelCapabilities {
  readonly maxOutputTokens: number
  readonly supportsStructuredOutput: boolean
  readonly isKnownModel: boolean
}

/**
 * Returns the capabilities of a Claude model that are used for defaults and feature selection.
 *
 * @see https://docs.claude.com/en/docs/about-claude/models/overview#model-comparison-table
 * @see https://platform.claude.com/docs/en/build-with-claude/structured-outputs
 */
const getModelCapabilities = (modelId: string): ModelCapabilities => {
  if (
    modelId.includes("claude-sonnet-4-5") ||
    modelId.includes("claude-opus-4-5") ||
    modelId.includes("claude-haiku-4-5")
  ) {
    return {
      maxOutputTokens: 64000,
      supportsStructuredOutput: true,
      isKnownModel: true
    }
  } else if (modelId.includes("claude-opus-4-1")) {
    return {
      maxOutputTokens: 32000,
      supportsStructuredOutput: true,
      isKnownModel: true
    }
  } else if (
    modelId.includes("claude-sonnet-4-") ||
    modelId.includes("claude-3-7-sonnet")
  ) {
    return {
      maxOutputTokens: 64000,
      supportsStructuredOutput: false,
      isKnownModel: true
    }
  } else if (modelId.includes("claude-opus-4-")) {
    return {
      maxOutputTokens: 32000,
      supportsStructuredOutput: false,
      isKnownModel: true
    }
  } else if (modelId.includes("claude-3-5-haiku")) {
    return {
      maxOutputTokens: 8192,
      supportsStructuredOutput: false,
      isKnownModel: true
    }
  } else if (modelId.includes("claude-3-haiku")) {
    return {
      maxOutputTokens: 4096,
      supportsStructuredOutput: false,
      isKnownModel: true
    }
  } else {
    return {
      maxOutputTokens: 4096,
      supportsStructuredOutput: false,
      isKnownModel: false
    }
  }
}

const unsupportedSchemaError = (error: unknown, method: string): AiError.AiError =>
  AiError.make({
    module: "AnthropicLanguageModel",
    method,
    reason: new AiError.UnsupportedSchemaError({
      description: error instanceof Error ? error.message : String(error)
    })
  })

const tryCodecTransform = <S extends Schema.Top>(schema: S, method: string) =>
  Effect.try({
    try: () => toCodecAnthropic(schema),
    catch: (error) => unsupportedSchemaError(error, method)
  })

const tryJsonSchema = <S extends Schema.Top>(schema: S, method: string) =>
  Effect.try({
    try: () => Tool.getJsonSchemaFromSchema(schema, { transformer: toCodecAnthropic }),
    catch: (error) => unsupportedSchemaError(error, method)
  })

const tryToolJsonSchema = <T extends Tool.Any | Tool.AnyDynamic>(tool: T, method: string) =>
  Effect.try({
    try: () => Tool.getJsonSchema(tool, { transformer: toCodecAnthropic }),
    catch: (error) => unsupportedSchemaError(error, method)
  })

const getOutputFormat = Effect.fnUntraced(function*({ capabilities, options }: {
  readonly capabilities: ModelCapabilities
  readonly options: LanguageModel.ProviderOptions
}): Effect.fn.Return<typeof Generated.JsonOutputFormat.Encoded | undefined, AiError.AiError> {
  if (options.responseFormat.type === "json" && capabilities.supportsStructuredOutput) {
    const jsonSchema = yield* tryJsonSchema(options.responseFormat.schema, "getOutputFormat")
    return {
      type: "json_schema",
      schema: jsonSchema as any
    }
  }
  return undefined
})

const transformToolCallParams = Effect.fnUntraced(function*<Tools extends ReadonlyArray<Tool.Any>>(
  tools: Tools,
  toolName: string,
  toolParams: unknown
): Effect.fn.Return<unknown, AiError.AiError> {
  const tool = tools.find((tool) => tool.name === toolName)

  if (Predicate.isUndefined(tool)) {
    return yield* AiError.make({
      module: "AnthropicLanguageModel",
      method: "makeResponse",
      reason: new AiError.ToolNotFoundError({
        toolName,
        availableTools: tools.map((tool) => tool.name)
      })
    })
  }

  const { codec } = yield* tryCodecTransform(tool.parametersSchema, "makeResponse")

  const transform = Schema.decodeEffect(codec)

  return yield* (
    transform(toolParams) as Effect.Effect<unknown, Schema.SchemaError>
  ).pipe(Effect.mapError((error) =>
    AiError.make({
      module: "AnthropicLanguageModel",
      method: "makeResponse",
      reason: new AiError.ToolParameterValidationError({
        toolName,
        toolParams,
        description: error.issue.toString()
      })
    })
  ))
})
