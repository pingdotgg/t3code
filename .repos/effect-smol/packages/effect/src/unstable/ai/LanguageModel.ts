/**
 * The `LanguageModel` module provides AI text generation capabilities with tool
 * calling support.
 *
 * This module offers a comprehensive interface for interacting with large
 * language models, supporting both streaming and non-streaming text generation,
 * structured output generation, and tool calling functionality. It provides a
 * unified API that can be implemented by different AI providers while
 * maintaining type safety and effect management.
 *
 * **Example** (Generating text)
 *
 * ```ts
 * import { Effect } from "effect"
 * import { LanguageModel } from "effect/unstable/ai"
 *
 * // Basic text generation
 * const program = Effect.gen(function*() {
 *   const response = yield* LanguageModel.generateText({
 *     prompt: "Explain quantum computing"
 *   })
 *
 *   console.log(response.text)
 *
 *   return response
 * })
 * ```
 *
 * **Example** (Generating structured output)
 *
 * ```ts
 * import { Effect, Schema } from "effect"
 * import { LanguageModel } from "effect/unstable/ai"
 *
 * // Structured output generation
 * const ContactSchema = Schema.Struct({
 *   name: Schema.String,
 *   email: Schema.String
 * })
 *
 * const extractContact = Effect.gen(function*() {
 *   const response = yield* LanguageModel.generateObject({
 *     prompt: "Extract contact: John Doe, john@example.com",
 *     schema: ContactSchema
 *   })
 *
 *   return response.value
 * })
 * ```
 *
 * @since 4.0.0
 */
import type * as Cause from "../../Cause.ts"
import * as Context from "../../Context.ts"
import * as Effect from "../../Effect.ts"
import * as FiberSet from "../../FiberSet.ts"
import { constFalse, identity, pipe } from "../../Function.ts"
import type * as JsonSchema from "../../JsonSchema.ts"
import * as Option from "../../Option.ts"
import * as Predicate from "../../Predicate.ts"
import * as Queue from "../../Queue.ts"
import { CurrentConcurrency } from "../../References.ts"
import * as Schema from "../../Schema.ts"
import * as AST from "../../SchemaAST.ts"
import * as Sink from "../../Sink.ts"
import * as Stream from "../../Stream.ts"
import type { Span } from "../../Tracer.ts"
import type { Concurrency, Mutable, NoExcessProperties } from "../../Types.ts"
import * as AiError from "./AiError.ts"
import { defaultIdGenerator, IdGenerator } from "./IdGenerator.ts"
import * as InternalCodecTransformer from "./internal/codec-transformer.ts"
import * as Prompt from "./Prompt.ts"
import * as Response from "./Response.ts"
import * as ResponseIdTracker from "./ResponseIdTracker.ts"
import type { SpanTransformer } from "./Telemetry.ts"
import { CurrentSpanTransformer } from "./Telemetry.ts"
import type * as Tool from "./Tool.ts"
import * as Toolkit from "./Toolkit.ts"

// =============================================================================
// Service Definition
// =============================================================================

/**
 * Service tag for AI model services.
 *
 * **When to use**
 *
 * Use to access or provide text generation, streaming generation, structured
 * output, and tool-calling capabilities through the Effect context.
 *
 * **Example** (Accessing the language model service)
 *
 * ```ts
 * import { Effect } from "effect"
 * import { LanguageModel } from "effect/unstable/ai"
 *
 * const program = Effect.gen(function*() {
 *   const model = yield* LanguageModel.LanguageModel
 *   const response = yield* model.generateText({
 *     prompt: "What is machine learning?"
 *   })
 *   return response.text
 * })
 * ```
 *
 * @category tags
 * @since 4.0.0
 */
export class LanguageModel extends Context.Service<LanguageModel, Service>()(
  "effect/unstable/ai/LanguageModel"
) {}

/**
 * The service interface for language model operations, defining the contract that all language model implementations must fulfill.
 *
 * @category models
 * @since 4.0.0
 */
export interface Service {
  /**
   * Generate text using the language model.
   */
  readonly generateText: {
    // No toolkit: force `{}` instead of falling back to `Record<string, Tool.Any>`.
    <Options extends NoExcessProperties<GenerateTextOptionsWithoutToolkit, Options>>(
      options: Options & GenerateTextOptionsWithoutToolkit
    ): Effect.Effect<
      GenerateTextResponse<{}>,
      ExtractError<Options>,
      ExtractServices<Options>
    >
    // Generic toolkit: preserve caller-supplied `Tools` in helpers like `<Tools>(toolkit: WithHandler<Tools>) => ...`.
    <
      Tools extends Record<string, Tool.Any>,
      Options extends NoExcessProperties<
        GenerateTextOptions<Tools> & { readonly toolkit: ToolkitInput<Tools> },
        Options
      >
    >(
      options: Options & GenerateTextOptions<Tools> & { readonly toolkit: ToolkitInput<Tools> }
    ): Effect.Effect<
      GenerateTextResponse<Tools>,
      ExtractError<Options>,
      ExtractServices<Options>
    >
    // Toolkit unions: recover distributive `ExtractTools<Options>` inference for `toolkitA | toolkitB` call sites.
    <
      Options extends {
        readonly toolkit: ToolkitOption<any>
      } & NoExcessProperties<GenerateTextOptions<any>, Options>
    >(
      options: Options & GenerateTextOptions<ExtractTools<Options>> & { readonly toolkit: Options["toolkit"] }
    ): Effect.Effect<
      GenerateTextResponse<ExtractTools<Options>>,
      ExtractError<Options>,
      ExtractServices<Options>
    >
  }

  /**
   * Generate a structured object from a schema using the language model.
   */
  readonly generateObject: <
    ObjectEncoded extends Record<string, any>,
    StructuredOutputSchema extends Schema.Encoder<ObjectEncoded, unknown>,
    Options extends NoExcessProperties<
      GenerateObjectOptions<any, StructuredOutputSchema>,
      Options
    >,
    Tools extends Record<string, Tool.Any> = {}
  >(
    options: Options & GenerateObjectOptions<Tools, StructuredOutputSchema>
  ) => Effect.Effect<
    GenerateObjectResponse<Tools, StructuredOutputSchema["Type"]>,
    ExtractError<Options>,
    ExtractServices<Options> | StructuredOutputSchema["DecodingServices"]
  >

  /**
   * Generate text using the language model with streaming output.
   */
  readonly streamText: {
    // No toolkit: force `{}` instead of falling back to `Record<string, Tool.Any>`.
    <Options extends NoExcessProperties<GenerateTextOptionsWithoutToolkit, Options>>(
      options: Options & GenerateTextOptionsWithoutToolkit
    ): Stream.Stream<
      Response.StreamPart<{}>,
      ExtractError<Options>,
      ExtractServices<Options>
    >
    // Generic toolkit: preserve caller-supplied `Tools` in helpers like `<Tools>(toolkit: WithHandler<Tools>) => ...`.
    <
      Tools extends Record<string, Tool.Any>,
      Options extends NoExcessProperties<
        GenerateTextOptions<Tools> & { readonly toolkit: ToolkitInput<Tools> },
        Options
      >
    >(
      options: Options & GenerateTextOptions<Tools> & { readonly toolkit: ToolkitInput<Tools> }
    ): Stream.Stream<
      Response.StreamPart<Tools>,
      ExtractError<Options>,
      ExtractServices<Options>
    >
    // Toolkit unions: recover distributive `ExtractTools<Options>` inference for `toolkitA | toolkitB` call sites.
    <
      Options extends {
        readonly toolkit: ToolkitOption<any>
      } & NoExcessProperties<GenerateTextOptions<any>, Options>
    >(
      options: Options & GenerateTextOptions<ExtractTools<Options>> & { readonly toolkit: Options["toolkit"] }
    ): Stream.Stream<
      Response.StreamPart<ExtractTools<Options>>,
      ExtractError<Options>,
      ExtractServices<Options>
    >
  }
}

/**
 * A function that transforms a `Schema.Codec` into a provider-compatible form for structured output generation.
 *
 * **Details**
 *
 * Different language model providers have varying constraints on the JSON
 * schemas they accept. A `CodecTransformer` rewrites a codec's encoded side to
 * satisfy those constraints while preserving the decoded type.
 *
 * @category models
 * @since 4.0.0
 */
export type CodecTransformer = <T, E, RD, RE>(schema: Schema.Codec<T, E, RD, RE>) => {
  readonly codec: Schema.Codec<T, unknown, RD, RE>
  readonly jsonSchema: JsonSchema.JsonSchema
}

/**
 * The default codec transformer that passes schemas through without
 * provider-specific rewrites.
 *
 * **When to use**
 *
 * Use as the codec transformer for provider implementations when the provider
 * accepts the JSON Schema generated from an `Effect` Schema codec without
 * provider-specific rewrites.
 *
 * **Details**
 *
 * The transformer returns the original codec, resolves a top-level `$ref`, and
 * copies schema definitions into `$defs`.
 *
 * @see {@link CodecTransformer} for the structured-output transformer contract
 * @see {@link make} for where this transformer is used as the default
 *
 * @category services
 * @since 4.0.0
 */
export const defaultCodecTransformer: CodecTransformer = InternalCodecTransformer.defaultCodecTransformer

/**
 * Configuration options for text generation.
 *
 * @category models
 * @since 4.0.0
 */
export interface GenerateTextOptions<Tools extends Record<string, Tool.Any>> {
  /**
   * The prompt input to use to generate text.
   */
  readonly prompt: Prompt.RawInput

  /**
   * A toolkit containing both the tools and the tool call handler to use to
   * augment text generation.
   */
  readonly toolkit?: ToolkitInput<Tools> | undefined

  /**
   * The tool choice mode for the language model.
   * - `auto` (default): The model can decide whether or not to call tools, as
   *   well as which tools to call.
   * - `required`: The model **must** call a tool but can decide which tool will
   *   be called.
   * - `none`: The model **must not** call a tool.
   * - `{ tool: <tool_name> }`: The model must call the specified tool.
   * - `{ mode?: "auto" (default) | "required", "oneOf": [<tool-names>] }`: The
   *   model is restricted to the subset of tools specified by `oneOf`. When
   *   `mode` is `"auto"` or omitted, the model can decide whether or not a tool
   *   from the allowed subset of tools can be called. When `mode` is
   *   `"required"`, the model **must** call one tool from the allowed subset of
   *   tools.
   */
  readonly toolChoice?:
    | ToolChoice<{ [Name in keyof Tools]: Tools[Name]["name"] }[keyof Tools]>
    | undefined

  /**
   * The concurrency level for resolving tool calls.
   */
  readonly concurrency?: Concurrency | undefined

  /**
   * When set to `true`, tool calls requested by the large language model are not auto-resolved by the framework.
   *
   * **When to use**
   *
   * Use when you want to include tool call definitions from an `AiToolkit`
   * in requests to the large language model, while controlling tool call
   * resolver execution yourself.
   */
  readonly disableToolCallResolution?: boolean | undefined
}

type GenerateTextOptionsWithoutToolkit = Omit<GenerateTextOptions<{}>, "toolkit"> & {
  readonly toolkit?: undefined
}

/**
 * Configuration options for structured object generation.
 *
 * @category models
 * @since 4.0.0
 */
export interface GenerateObjectOptions<
  Tools extends Record<string, Tool.Any>,
  StructuredOutputSchema extends Schema.Top
> extends GenerateTextOptions<Tools> {
  /**
   * The name of the structured output that should be generated. Used by some
   * large language model providers to provide additional guidance to the model.
   */
  readonly objectName?: string | undefined

  /**
   * The schema to be used to specify the structure of the object to generate.
   */
  readonly schema: StructuredOutputSchema
}

/**
 * The tool choice mode for the language model.
 * - `auto` (default): The model can decide whether or not to call tools, as
 *   well as which tools to call.
 * - `required`: The model **must** call a tool but can decide which tool will
 *   be called.
 * - `none`: The model **must not** call a tool.
 * - `{ tool: <tool_name> }`: The model must call the specified tool.
 * - `{ mode?: "auto" (default) | "required", "oneOf": [<tool-names>] }`: The
 *   model is restricted to the subset of tools specified by `oneOf`. When
 *   `mode` is `"auto"` or omitted, the model can decide whether or not a tool
 *   from the allowed subset of tools can be called. When `mode` is
 *   `"required"`, the model **must** call one tool from the allowed subset of
 *   tools.
 *
 * @category models
 * @since 4.0.0
 */
export type ToolChoice<ToolName extends string> =
  | "auto"
  | "none"
  | "required"
  | {
    readonly tool: ToolName
  }
  | {
    readonly mode?: "auto" | "required"
    readonly oneOf: ReadonlyArray<ToolName>
  }

/**
 * Response class for text generation operations, with accessors for extracting text, tool calls, usage information, and other response parts from generated content.
 *
 * **Example** (Inspecting a text response)
 *
 * ```ts
 * import { Effect } from "effect"
 * import { LanguageModel } from "effect/unstable/ai"
 *
 * const program = Effect.gen(function*() {
 *   const response = yield* LanguageModel.generateText({
 *     prompt: "Explain photosynthesis"
 *   })
 *
 *   console.log(response.text) // Generated text content
 *   console.log(response.finishReason) // "stop", "length", etc.
 *   console.log(response.usage) // Usage information
 *
 *   return response
 * })
 * ```
 *
 * @category models
 * @since 4.0.0
 */
export class GenerateTextResponse<Tools extends Record<string, Tool.Any>> {
  readonly content: Array<Response.Part<Tools>>

  constructor(content: Array<Response.Part<Tools>>) {
    this.content = content
  }

  /**
   * Extracts and concatenates all text parts from the response.
   */
  get text(): string {
    const text: Array<string> = []
    for (const part of this.content) {
      if (part.type === "text") {
        text.push(part.text)
      }
    }
    return text.join("")
  }

  /**
   * Returns all reasoning parts from the response.
   */
  get reasoning(): Array<Response.ReasoningPart> {
    return this.content.filter((part) => part.type === "reasoning")
  }

  /**
   * Extracts and concatenates all reasoning text, or undefined if none exists.
   */
  get reasoningText(): string | undefined {
    const text: Array<string> = []
    for (const part of this.content) {
      if (part.type === "reasoning") {
        text.push(part.text)
      }
    }
    return text.length === 0 ? undefined : text.join("")
  }

  /**
   * Returns all tool call parts from the response.
   */
  get toolCalls(): Array<Response.ToolCallParts<Tools>> {
    return this.content.filter((part) => part.type === "tool-call")
  }

  /**
   * Returns all tool result parts from the response.
   */
  get toolResults(): Array<Response.ToolResultParts<Tools>> {
    return this.content.filter((part) => part.type === "tool-result")
  }

  /**
   * The reason why text generation finished.
   */
  get finishReason(): Response.FinishReason {
    const finishPart = this.content.find((part) => part.type === "finish")
    return Predicate.isUndefined(finishPart) ? "unknown" : finishPart.reason
  }

  /**
   * Token usage statistics for the generation request.
   */
  get usage(): Response.Usage {
    const finishPart = this.content.find((part) => part.type === "finish")
    if (Predicate.isUndefined(finishPart)) {
      return new Response.Usage({
        inputTokens: {
          uncached: undefined,
          total: undefined,
          cacheRead: undefined,
          cacheWrite: undefined
        },
        outputTokens: {
          total: undefined,
          text: undefined,
          reasoning: undefined
        }
      })
    }
    return finishPart.usage
  }
}

/**
 * Response class for structured object generation operations.
 *
 * **Example** (Inspecting an object response)
 *
 * ```ts
 * import { Effect, Schema } from "effect"
 * import { LanguageModel } from "effect/unstable/ai"
 *
 * const UserSchema = Schema.Struct({
 *   name: Schema.String,
 *   email: Schema.String
 * })
 *
 * const program = Effect.gen(function*() {
 *   const response = yield* LanguageModel.generateObject({
 *     prompt: "Create user: John Doe, john@example.com",
 *     schema: UserSchema
 *   })
 *
 *   console.log(response.value) // { name: "John Doe", email: "john@example.com" }
 *   console.log(response.text) // Raw generated text
 *
 *   return response.value
 * })
 * ```
 *
 * @category models
 * @since 4.0.0
 */
export class GenerateObjectResponse<
  Tools extends Record<string, Tool.Any>,
  A
> extends GenerateTextResponse<Tools> {
  /**
   * The parsed structured object that conforms to the provided schema.
   */
  readonly value: A

  constructor(value: A, content: Array<Response.Part<Tools>>) {
    super(content)
    this.value = value
  }
}

// =============================================================================
// Utility Types
// =============================================================================

/**
 * The supported toolkit option shapes for language model operations.
 *
 * @category utility types
 * @since 4.0.0
 */
export type ToolkitOption<
  Tools extends Record<string, Tool.Any>,
  E = never,
  R = any
> = Tools extends any ? (
    | Toolkit.WithHandler<Tools>
    | Effect.Effect<
      Toolkit.WithHandler<Tools>,
      E,
      R
    >
  )
  : never

/**
 * The supported toolkit input shapes for language model operation options.
 *
 * **Details**
 *
 * Unlike `ToolkitOption`, this type does not distribute over unions. It is
 * intended for call-site assignability, while `ToolkitOption` remains the
 * distributive helper used for extraction and inference.
 *
 * @category utility types
 * @since 4.0.0
 */
export type ToolkitInput<
  Tools extends Record<string, Tool.Any>,
  E = never,
  R = any
> =
  | ToolkitOption<Tools, E, R>
  | Toolkit.WithHandler<Tools>
  | Effect.Effect<
    Toolkit.WithHandler<Tools>,
    E,
    R
  >

type ExtractToolsFromToolkitOption<ToolkitValue> = ToolkitValue extends Toolkit.WithHandler<infer Tools> ? Tools
  : ToolkitValue extends Effect.Effect<
    Toolkit.WithHandler<infer _Tools>,
    infer _E,
    infer _R
  > ? _Tools
  : never

/**
 * Utility type that extracts the toolset from LanguageModel options.
 *
 * @category utility types
 * @since 4.0.0
 */
export type ExtractTools<Options> = Options extends {
  readonly toolkit: infer ToolkitValue
} ? ExtractToolsFromToolkitOption<Exclude<ToolkitValue, undefined>>
  : {}

type ExtractErrorFromToolkitOption<ToolkitValue, DisableToolCallResolution extends boolean> = ToolkitValue extends
  Toolkit.WithHandler<infer Tools> ?
    | AiError.AiError
    | (DisableToolCallResolution extends true ? never : Tool.HandlerError<Tools[keyof Tools]>)
  : ToolkitValue extends Effect.Effect<
    Toolkit.WithHandler<infer _Tools>,
    infer E,
    infer _R
  > ? AiError.AiError | E | (DisableToolCallResolution extends true ? never : Tool.HandlerError<_Tools[keyof _Tools]>)
  : AiError.AiError

type ExtractServicesFromToolkitOption<ToolkitValue> = ToolkitValue extends Toolkit.WithHandler<infer Tools> ?
    | Tool.HandlerServices<Tools[keyof Tools]>
    | Tool.ResultDecodingServices<Tools[keyof Tools]>
  : ToolkitValue extends Effect.Effect<
    Toolkit.WithHandler<infer Tools>,
    infer _E,
    infer R
  > ?
      | Tool.HandlerServices<Tools[keyof Tools]>
      | Tool.ResultDecodingServices<Tools[keyof Tools]>
      | R
  : never

type ExtractToolkitResolutionError<ToolkitValue> = ToolkitValue extends Effect.Effect<
  Toolkit.WithHandler<infer _Tools>,
  infer E,
  infer _R
> ? E
  : never

type ExtractToolkitResolutionServices<ToolkitValue> = ToolkitValue extends Effect.Effect<
  Toolkit.WithHandler<infer _Tools>,
  infer _E,
  infer R
> ? R
  : never

/**
 * Utility type that extracts the error type from LanguageModel options.
 *
 * **Details**
 *
 * Automatically infers the possible error types based on toolkit configuration
 * and tool call resolution settings.
 *
 * @category utility types
 * @since 4.0.0
 */
export type ExtractError<Options> = Options extends {
  readonly disableToolCallResolution: true
  readonly toolkit: infer ToolkitValue
} ? ExtractErrorFromToolkitOption<Exclude<ToolkitValue, undefined>, true>
  : Options extends {
    readonly toolkit: infer ToolkitValue
  } ? ExtractErrorFromToolkitOption<Exclude<ToolkitValue, undefined>, false>
  : Options extends {
    readonly disableToolCallResolution: true
  } ? AiError.AiError
  : AiError.AiError

/**
 * Utility type that extracts the context requirements from LanguageModel options.
 *
 * **Details**
 *
 * Automatically infers the required services based on the toolkit configuration.
 *
 * @category utility types
 * @since 4.0.0
 */
export type ExtractServices<Options> = Options extends {
  readonly disableToolCallResolution: true
} ? never
  : Options extends {
    readonly toolkit: infer Toolkit
  } ? ExtractServicesFromToolkitOption<Exclude<Toolkit, undefined>>
  : never

// =============================================================================
// Service Constructor
// =============================================================================

/**
 * Configuration options passed along to language model provider implementations.
 *
 * **Details**
 *
 * This interface defines the normalized options that are passed to the
 * underlying provider implementation, regardless of the specific provider being
 * used.
 *
 * @category models
 * @since 4.0.0
 */
export interface ProviderOptions {
  /**
   * The prompt messages to use to generate text.
   */
  readonly prompt: Prompt.Prompt

  /**
   * The tools that the large language model will have available to provide
   * additional information which can be incorporated into its text generation.
   */
  readonly tools: ReadonlyArray<Tool.Any>

  /**
   * The format the response should be provided in.
   *
   * **Details**
   *
   * If `"text"` is specified, the large language model response is returned as
   * text. If `"json"` is specified, the large language model response is
   * provided as a JSON object that conforms to the shape of the specified schema.
   * The default is `{ type: "text" }`.
   */
  readonly responseFormat:
    | {
      readonly type: "text"
    }
    | {
      readonly type: "json"
      readonly objectName: string
      readonly schema: Schema.Top
    }

  /**
   * The tool choice mode for the language model.
   * - `auto` (default): The model can decide whether or not to call tools, as
   *   well as which tools to call.
   * - `required`: The model **must** call a tool but can decide which tool will
   *   be called.
   * - `none`: The model **must not** call a tool.
   * - `{ tool: <tool_name> }`: The model must call the specified tool.
   * - `{ mode?: "auto" (default) | "required", "oneOf": [<tool-names>] }`: The
   *   model is restricted to the subset of tools specified by `oneOf`. When
   *   `mode` is `"auto"` or omitted, the model can decide whether or not a tool
   *   from the allowed subset of tools can be called. When `mode` is
   *   `"required"`, the model **must** call one tool from the allowed subset of
   *   tools.
   */
  readonly toolChoice: ToolChoice<any>

  /**
   * The span to use to trace interactions with the large language model.
   */
  readonly span: Span

  /**
   * The previous response identifier for incremental provider calls.
   */
  readonly previousResponseId: string | undefined

  /**
   * The prompt reduced to messages not yet seen by the provider.
   */
  readonly incrementalPrompt: Prompt.Prompt | undefined
}

/**
 * Creates a LanguageModel service from provider-specific text generation and
 * streaming implementations.
 *
 * **When to use**
 *
 * Use to build a `LanguageModel.Service` from provider-specific final and
 * streaming text generation functions.
 *
 * **Details**
 *
 * The returned service implements `generateText`, `generateObject`, and
 * `streamText`. It prepares `ProviderOptions` for each request, including the
 * normalized prompt, tools, tool choice, response format, tracing span, and
 * incremental response fields, before calling the supplied provider hook.
 * Structured object generation uses the `generateText` hook and the configured
 * `codecTransformer`, or `defaultCodecTransformer` when none is supplied.
 *
 * **Gotchas**
 *
 * Provider hooks must return encoded response parts that match the toolkit and
 * response format prepared in `ProviderOptions`; invalid parts fail decoding as
 * `AiError.InvalidOutputError`.
 *
 * @see {@link Service} for the returned service contract
 * @see {@link ProviderOptions} for the normalized options passed to provider hooks
 * @see {@link defaultCodecTransformer} for the default structured-output schema transformer
 *
 * @category constructors
 * @since 4.0.0
 */
export const make: (params: {
  /**
   * A method that requests text generation from the large language model provider and returns the final result when generation finishes.
   */
  readonly generateText: (
    options: ProviderOptions
  ) => Effect.Effect<Array<Response.PartEncoded>, AiError.AiError, IdGenerator>

  /**
   * A method that requests text generation from the large language model provider and streams intermediate results.
   */
  readonly streamText: (
    options: ProviderOptions
  ) => Stream.Stream<Response.StreamPartEncoded, AiError.AiError, IdGenerator>

  /**
   * A function that transforms a `Schema.Codec` into a provider-compatible form
   * for structured output generation.
   */
  readonly codecTransformer?: CodecTransformer | undefined
}) => Effect.Effect<Service> = Effect.fnUntraced(function*(params) {
  const codecTransformer = params.codecTransformer ?? defaultCodecTransformer

  const parentSpanTransformer = yield* Effect.serviceOption(
    CurrentSpanTransformer
  )
  const getSpanTransformer = Effect.serviceOption(
    CurrentSpanTransformer
  ).pipe(Effect.map(Option.orElse(() => parentSpanTransformer)))

  const idGenerator = yield* Effect.serviceOption(IdGenerator).pipe(
    Effect.map(Option.getOrElse(() => defaultIdGenerator))
  )

  const generateText = <
    Options extends NoExcessProperties<GenerateTextOptions<any>, Options>,
    Tools extends Record<string, Tool.Any> = {}
  >(
    options: Options & GenerateTextOptions<Tools>
  ): Effect.Effect<
    GenerateTextResponse<Tools>,
    ExtractError<Options>,
    ExtractServices<Options>
  > =>
    Effect.useSpan(
      "LanguageModel.generateText",
      {
        attributes: {
          concurrency: options.concurrency,
          toolChoice: options.toolChoice
        }
      },
      Effect.fnUntraced(
        function*(span) {
          const spanTransformer = yield* getSpanTransformer

          const providerOptions: Mutable<ProviderOptions> = {
            prompt: Prompt.make(options.prompt),
            tools: [],
            toolChoice: "none",
            responseFormat: { type: "text" },
            span,
            previousResponseId: undefined,
            incrementalPrompt: undefined
          }
          const content = yield* generateContent(options, providerOptions)

          applySpanTransformer(
            spanTransformer,
            content as any,
            providerOptions
          )

          return new GenerateTextResponse(content)
        },
        Effect.catchTag("SchemaError", (error) =>
          Effect.fail(
            AiError.make({
              module: "LanguageModel",
              method: "generateText",
              reason: AiError.InvalidOutputError.fromSchemaError(error)
            })
          )),
        (effect, span) => Effect.withParentSpan(effect, span, { captureStackTrace: false }),
        Effect.provideService(IdGenerator, idGenerator)
      )
    ) as any

  const generateObject = <
    ObjectEncoded extends Record<string, any>,
    StructuredOutputSchema extends Schema.Encoder<ObjectEncoded, unknown>,
    Options extends NoExcessProperties<
      GenerateObjectOptions<any, StructuredOutputSchema>,
      Options
    >,
    Tools extends Record<string, Tool.Any> = {}
  >(
    options: Options & GenerateObjectOptions<Tools, StructuredOutputSchema>
  ): Effect.Effect<
    GenerateObjectResponse<Tools, StructuredOutputSchema["Type"]>,
    ExtractError<Options>,
    ExtractServices<Options> | StructuredOutputSchema["DecodingServices"]
  > => {
    const objectName = getObjectName(options.objectName, options.schema)
    return Effect.useSpan(
      "LanguageModel.generateObject",
      {
        attributes: {
          objectName,
          concurrency: options.concurrency,
          toolChoice: options.toolChoice
        }
      },
      Effect.fnUntraced(
        function*(span) {
          const spanTransformer = yield* getSpanTransformer

          const providerOptions: Mutable<ProviderOptions> = {
            prompt: Prompt.make(options.prompt),
            tools: [],
            toolChoice: "none",
            responseFormat: {
              type: "json",
              objectName,
              schema: options.schema
            },
            span,
            previousResponseId: undefined,
            incrementalPrompt: undefined
          }

          const content = yield* generateContent(options, providerOptions)

          applySpanTransformer(
            spanTransformer,
            content as any,
            providerOptions
          )

          const { codec } = yield* Effect.try({
            try: () => codecTransformer(options.schema),
            catch: (error) =>
              AiError.make({
                module: "LanguageModel",
                method: "generateObject",
                reason: new AiError.UnsupportedSchemaError({
                  description: error instanceof Error ? error.message : String(error)
                })
              })
          })

          const value = yield* resolveStructuredOutput(content as any, codec)

          return new GenerateObjectResponse(value, content)
        },
        Effect.catchTag("SchemaError", (error) =>
          Effect.fail(
            AiError.make({
              module: "LanguageModel",
              method: "generateObject",
              reason: AiError.InvalidOutputError.fromSchemaError(error)
            })
          )),
        (effect, span) => Effect.withParentSpan(effect, span, { captureStackTrace: false }),
        Effect.provideService(IdGenerator, idGenerator)
      )
    ) as any
  }

  const streamText: <
    Options extends NoExcessProperties<GenerateTextOptions<any>, Options>,
    Tools extends Record<string, Tool.Any> = {}
  >(
    options: Options & GenerateTextOptions<Tools>
  ) => Stream.Stream<
    Response.StreamPart<Tools>,
    ExtractError<Options>,
    ExtractServices<Options>
  > = Effect.fnUntraced(
    function*<
      Tools extends Record<string, Tool.Any>,
      Options extends NoExcessProperties<GenerateTextOptions<Tools>, Options>
    >(options: Options & GenerateTextOptions<Tools>) {
      const span = yield* Effect.makeSpanScoped("LanguageModel.streamText", {
        attributes: {
          concurrency: options.concurrency,
          toolChoice: options.toolChoice
        }
      })

      const providerOptions: Mutable<ProviderOptions> = {
        prompt: Prompt.make(options.prompt),
        tools: [],
        toolChoice: "none",
        responseFormat: { type: "text" },
        span,
        previousResponseId: undefined,
        incrementalPrompt: undefined
      }

      // Resolve the content stream for the request
      const stream = yield* streamContent(options, providerOptions)

      // Return the stream immediately if there is no span transformer
      const spanTransformer = yield* getSpanTransformer
      if (Option.isNone(spanTransformer)) {
        return stream
      }

      // Otherwise aggregate generated content and apply the span transformer
      // when the stream is finished
      const content: Array<Response.StreamPart<Tools>> = []
      return stream.pipe(
        Stream.mapArray((parts) => {
          content.push(...parts)
          return parts
        }),
        Stream.ensuring(
          Effect.sync(() => {
            spanTransformer.value({
              ...providerOptions,
              response: content as any
            })
          })
        )
      )
    },
    Stream.unwrap,
    Stream.mapError((error) =>
      Schema.isSchemaError(error)
        ? AiError.make({
          module: "LanguageModel",
          method: "streamText",
          reason: AiError.InvalidOutputError.fromSchemaError(error)
        })
        : error
    ),
    Stream.provideService(IdGenerator, idGenerator)
  ) as any

  const generateContent: <
    Options extends NoExcessProperties<GenerateTextOptions<any>, Options>,
    Tools extends Record<string, Tool.Any> = {}
  >(
    options: Options & GenerateTextOptions<Tools>,
    providerOptions: Mutable<ProviderOptions>
  ) => Effect.Effect<
    Array<Response.Part<Tools>>,
    AiError.AiError | Schema.SchemaError,
    IdGenerator
  > = Effect.fnUntraced(function*<
    Tools extends Record<string, Tool.Any>,
    Options extends NoExcessProperties<GenerateTextOptions<Tools>, Options>
  >(
    options: Options & GenerateTextOptions<Tools>,
    providerOptions: Mutable<ProviderOptions>
  ) {
    const tracker = Option.getOrUndefined(yield* Effect.serviceOption(ResponseIdTracker.ResponseIdTracker))
    const toolChoice = options.toolChoice ?? "auto"

    const generateWithNonIncrementalFallback = () => {
      const requestOptions: ProviderOptions = {
        ...providerOptions
      }
      const fallbackPrompt = requestOptions.prompt
      const fallbackOptions: ProviderOptions = {
        ...requestOptions,
        prompt: fallbackPrompt,
        incrementalPrompt: undefined,
        previousResponseId: undefined
      }
      return requestOptions.incrementalPrompt
        ? params.generateText(requestOptions).pipe(
          Effect.catchReason("AiError", "InvalidRequestError", (_) => params.generateText(fallbackOptions))
        )
        : params.generateText(requestOptions)
    }

    // Check for pending approvals that need resolution
    const { approved, denied } = collectToolApprovals(
      providerOptions.prompt.content,
      { excludeResolved: true }
    )
    const hasPendingApprovals = approved.length > 0 || denied.length > 0

    // If there is no toolkit, the generated content can be returned immediately
    if (Predicate.isUndefined(options.toolkit)) {
      // But first check if we have pending approvals that require a toolkit
      if (hasPendingApprovals) {
        return yield* AiError.make({
          module: "LanguageModel",
          method: "generateText",
          reason: new AiError.ToolkitRequiredError({
            pendingApprovals: [...approved, ...denied]
              .map((result) => result.toolCall?.name)
              .filter(Predicate.isNotUndefined)
          })
        })
      }
      if (tracker) {
        const prepared = tracker.prepareUnsafe(providerOptions.prompt)
        if (Option.isSome(prepared)) {
          providerOptions.previousResponseId = prepared.value.previousResponseId
          providerOptions.incrementalPrompt = prepared.value.prompt
        }
      }
      const ResponseSchema = Schema.mutable(
        Schema.Array(Response.Part(Toolkit.empty))
      )
      const rawContent = yield* generateWithNonIncrementalFallback()
      const content = yield* Schema.decodeEffect(ResponseSchema)(rawContent)
      if (tracker) {
        const responseMetadata = content.find((part) => part.type === "response-metadata")
        if (Predicate.isNotUndefined(responseMetadata) && Predicate.isNotUndefined(responseMetadata.id)) {
          tracker.markParts(providerOptions.prompt.content, responseMetadata.id)
        }
      }
      return content as Array<Response.Part<Tools>>
    }

    // If there is a toolkit resolve and apply it to the provider options
    const toolkit = yield* resolveToolkit<Tools, any, any>(options.toolkit)

    // If the resolved toolkit is empty, return the generated content immediately
    if (Object.values(toolkit.tools).length === 0) {
      // But first check if we have pending approvals that require a toolkit
      if (hasPendingApprovals) {
        return yield* AiError.make({
          module: "LanguageModel",
          method: "generateText",
          reason: new AiError.ToolkitRequiredError({
            pendingApprovals: [...approved, ...denied]
              .map((result) => result.toolCall?.name)
              .filter(Predicate.isNotUndefined)
          })
        })
      }
      if (tracker) {
        const prepared = tracker.prepareUnsafe(providerOptions.prompt)
        if (Option.isSome(prepared)) {
          providerOptions.previousResponseId = prepared.value.previousResponseId
          providerOptions.incrementalPrompt = prepared.value.prompt
        }
      }
      const ResponseSchema = Schema.mutable(
        Schema.Array(Response.Part(Toolkit.empty))
      )
      const rawContent = yield* generateWithNonIncrementalFallback()
      const content = yield* Schema.decodeEffect(ResponseSchema)(rawContent)
      if (tracker) {
        const responseMetadata = content.find((part) => part.type === "response-metadata")
        if (Predicate.isNotUndefined(responseMetadata) && Predicate.isNotUndefined(responseMetadata.id)) {
          tracker.markParts(providerOptions.prompt.content, responseMetadata.id)
        }
      }
      return content as Array<Response.Part<Tools>>
    }

    // Pre-resolve pending tool approvals before calling the LLM
    if (hasPendingApprovals) {
      for (const approval of approved) {
        if (approval.toolCall && !toolkit.tools[approval.toolCall.name]) {
          return yield* AiError.make({
            module: "LanguageModel",
            method: "generateText",
            reason: new AiError.ToolNotFoundError({
              toolName: approval.toolCall.name,
              availableTools: Object.keys(toolkit.tools)
            })
          })
        }
      }

      const approvedResults = yield* executeApprovedToolCalls(
        approved,
        toolkit,
        options.concurrency
      )
      const deniedResults = createDenialResults(denied)
      const preResolvedResults = [...approvedResults, ...deniedResults]

      if (preResolvedResults.length > 0) {
        providerOptions.prompt = Prompt.fromMessages([
          ...providerOptions.prompt.content,
          Prompt.makeMessage("tool", { content: preResolvedResults })
        ])
      }
    }

    // Strip all resolved approval artifacts (both current and from previous
    // rounds) in a single pass before sending to the provider.
    {
      const { approved: allResolved, denied: allDenied } = collectToolApprovals(
        providerOptions.prompt.content
      )
      if (allResolved.length > 0 || allDenied.length > 0) {
        providerOptions.prompt = stripResolvedApprovals(
          providerOptions.prompt,
          allResolved,
          allDenied
        )
      }
    }

    const tools = typeof toolChoice === "object" && "oneOf" in toolChoice
      ? Object.values(toolkit.tools).filter((tool) => toolChoice.oneOf.includes(tool.name))
      : Object.values(toolkit.tools)
    providerOptions.tools = tools
    providerOptions.toolChoice = toolChoice

    if (tracker) {
      const prepared = tracker.prepareUnsafe(providerOptions.prompt)
      if (Option.isSome(prepared)) {
        providerOptions.previousResponseId = prepared.value.previousResponseId
        providerOptions.incrementalPrompt = prepared.value.prompt
      }
    }

    // Construct the response schema with the tools from the toolkit
    const ResponseSchema = Schema.mutable(
      Schema.Array(Response.Part(toolkit))
    )

    // If tool call resolution is disabled, return the response without
    // resolving the tool calls that were generated
    if (options.disableToolCallResolution === true) {
      const rawContent = yield* generateWithNonIncrementalFallback()
      const content = yield* Schema.decodeEffect(ResponseSchema)(rawContent)
      if (tracker) {
        const responseMetadata = content.find((part) => part.type === "response-metadata")
        if (Predicate.isNotUndefined(responseMetadata) && Predicate.isNotUndefined(responseMetadata.id)) {
          tracker.markParts(providerOptions.prompt.content, responseMetadata.id)
        }
      }
      return content as Array<Response.Part<Tools>>
    }

    const rawContent = yield* generateWithNonIncrementalFallback()

    // Resolve the generated tool calls
    const toolResults = yield* resolveToolCalls(
      rawContent,
      toolkit,
      providerOptions.prompt.content,
      options.concurrency
    ).pipe(
      Stream.filter(
        (result) =>
          result.type === "tool-approval-request" ||
          result.preliminary === false
      ),
      Stream.runCollect
    )

    const content = yield* Schema.decodeEffect(ResponseSchema)(rawContent)

    if (tracker) {
      const responseMetadata = content.find((part) => part.type === "response-metadata")
      if (Predicate.isNotUndefined(responseMetadata) && Predicate.isNotUndefined(responseMetadata.id)) {
        tracker.markParts(providerOptions.prompt.content, responseMetadata.id)
      }
    }

    // Return the content merged with the tool call results
    return [...content, ...toolResults] as Array<Response.Part<Tools>>
  })

  const streamContent: <
    Options extends NoExcessProperties<GenerateTextOptions<any>, Options>,
    Tools extends Record<string, Tool.Any> = {}
  >(
    options: Options & GenerateTextOptions<Tools>,
    providerOptions: Mutable<ProviderOptions>
  ) => Effect.Effect<
    Stream.Stream<
      Response.StreamPart<Tools>,
      AiError.AiError | Schema.SchemaError,
      IdGenerator
    >,
    Options extends { readonly toolkit: infer ToolkitValue } ?
      ExtractToolkitResolutionError<Exclude<ToolkitValue, undefined>>
      : never,
    Options extends { readonly toolkit: infer ToolkitValue } ?
      ExtractToolkitResolutionServices<Exclude<ToolkitValue, undefined>>
      : never
  > = Effect.fnUntraced(function*<
    Tools extends Record<string, Tool.Any>,
    Options extends NoExcessProperties<GenerateTextOptions<Tools>, Options>
  >(
    options: Options & GenerateTextOptions<Tools>,
    providerOptions: Mutable<ProviderOptions>
  ) {
    const tracker = Option.getOrUndefined(yield* Effect.serviceOption(ResponseIdTracker.ResponseIdTracker))
    const toolChoice = options.toolChoice ?? "auto"

    const streamWithNonIncrementalFallback = () => {
      const requestOptions: ProviderOptions = {
        ...providerOptions
      }
      const fallbackPrompt = requestOptions.prompt
      const fallbackOptions: ProviderOptions = {
        ...requestOptions,
        prompt: fallbackPrompt,
        incrementalPrompt: undefined,
        previousResponseId: undefined
      }
      return requestOptions.incrementalPrompt
        ? params.streamText(requestOptions).pipe(
          Stream.catchReason("AiError", "InvalidRequestError", (_) => params.streamText(fallbackOptions))
        )
        : params.streamText(requestOptions)
    }

    // Check for pending approvals that need resolution
    const { approved: pendingApproved, denied: pendingDenied } = collectToolApprovals(providerOptions.prompt.content, {
      excludeResolved: true
    })
    const hasPendingApprovals = pendingApproved.length > 0 || pendingDenied.length > 0

    // If there is no toolkit, return immediately
    if (Predicate.isUndefined(options.toolkit)) {
      // But first check if we have pending approvals that require a toolkit
      if (hasPendingApprovals) {
        return yield* AiError.make({
          module: "LanguageModel",
          method: "streamText",
          reason: new AiError.ToolkitRequiredError({
            pendingApprovals: [...pendingApproved, ...pendingDenied]
              .map((a) => a.toolCall?.name)
              .filter(Predicate.isNotUndefined)
          })
        })
      }
      if (tracker) {
        const prepared = tracker.prepareUnsafe(providerOptions.prompt)
        if (Option.isSome(prepared)) {
          providerOptions.previousResponseId = prepared.value.previousResponseId
          providerOptions.incrementalPrompt = prepared.value.prompt
        }
      }
      const schema = Schema.NonEmptyArray(Response.StreamPart(Toolkit.empty))
      const decodeParts = Schema.decodeEffect(schema)
      return pipe(
        streamWithNonIncrementalFallback(),
        Stream.mapArrayEffect((parts) =>
          decodeParts(parts).pipe(
            tracker ?
              Effect.tap((decodedParts) => {
                for (const part of decodedParts) {
                  if (part.type === "response-metadata" && Predicate.isNotUndefined(part.id)) {
                    tracker.markParts(providerOptions.prompt.content, part.id)
                  }
                }
                return Effect.void
              }) :
              identity
          )
        )
      ) as Stream.Stream<
        Response.StreamPart<Tools>,
        AiError.AiError | Schema.SchemaError,
        IdGenerator
      >
    }

    // If there is a toolkit resolve and apply it to the provider options
    const toolkit = yield* resolveToolkit<Tools, any, any>(options.toolkit)

    // If the toolkit is empty, return immediately
    if (Object.values(toolkit.tools).length === 0) {
      // But first check if we have pending approvals that require a toolkit
      if (hasPendingApprovals) {
        return yield* AiError.make({
          module: "LanguageModel",
          method: "streamText",
          reason: new AiError.ToolkitRequiredError({
            pendingApprovals: [...pendingApproved, ...pendingDenied]
              .map((a) => a.toolCall?.name)
              .filter(Predicate.isNotUndefined)
          })
        })
      }
      if (tracker) {
        const prepared = tracker.prepareUnsafe(providerOptions.prompt)
        if (Option.isSome(prepared)) {
          providerOptions.previousResponseId = prepared.value.previousResponseId
          providerOptions.incrementalPrompt = prepared.value.prompt
        }
      }
      const schema = Schema.NonEmptyArray(Response.StreamPart(Toolkit.empty))
      const decodeParts = Schema.decodeEffect(schema)
      return pipe(
        streamWithNonIncrementalFallback(),
        Stream.mapArrayEffect((parts) =>
          decodeParts(parts).pipe(
            tracker ?
              Effect.tap((decodedParts) => {
                for (const part of decodedParts) {
                  if (part.type === "response-metadata" && part.id) {
                    tracker.markParts(providerOptions.prompt.content, part.id)
                  }
                }
                return Effect.void
              }) :
              identity
          )
        )
      ) as Stream.Stream<
        Response.StreamPart<Tools>,
        AiError.AiError | Schema.SchemaError,
        IdGenerator
      >
    }

    // Pre-resolve pending tool approvals before calling the LLM
    let preResolvedStreamParts: Array<Response.StreamPart<Tools>> = []

    if (hasPendingApprovals) {
      for (const approval of pendingApproved) {
        if (approval.toolCall && !toolkit.tools[approval.toolCall.name]) {
          return yield* AiError.make({
            module: "LanguageModel",
            method: "streamText",
            reason: new AiError.ToolNotFoundError({
              toolName: approval.toolCall.name,
              availableTools: Object.keys(toolkit.tools)
            })
          })
        }
      }

      const approvedResults = yield* executeApprovedToolCalls(
        pendingApproved,
        toolkit,
        options.concurrency
      )
      const deniedResults = createDenialResults(pendingDenied)
      const preResolvedResults = [...approvedResults, ...deniedResults]

      if (preResolvedResults.length > 0) {
        providerOptions.prompt = Prompt.fromMessages([
          ...providerOptions.prompt.content,
          Prompt.makeMessage("tool", { content: preResolvedResults })
        ])
      }

      // Emit pre-resolved tool-results as stream parts so Chat.streamText
      // persists them to history. This lets collectToolApprovals find them
      // on subsequent rounds and skip the now-resolved approvals.
      // Note: r.result is already encoded (from executeApprovedToolCalls /
      // createDenialResults), so it goes into both result and encodedResult.
      for (const r of preResolvedResults) {
        preResolvedStreamParts.push(
          Response.makePart("tool-result", {
            id: r.id,
            name: r.name,
            providerExecuted: false,
            preliminary: false,
            result: r.result,
            encodedResult: r.result,
            isFailure: r.isFailure
          }) as Response.StreamPart<Tools>
        )
      }
    }

    // Strip all resolved approval artifacts (both current and from previous
    // rounds) in a single pass before sending to the provider.
    const { approved: allResolved, denied: allDenied } = collectToolApprovals(
      providerOptions.prompt.content
    )
    if (allResolved.length > 0 || allDenied.length > 0) {
      providerOptions.prompt = stripResolvedApprovals(
        providerOptions.prompt,
        allResolved,
        allDenied
      )
    }

    const tools = typeof toolChoice === "object" && "oneOf" in toolChoice
      ? Object.values(toolkit.tools).filter((tool) => toolChoice.oneOf.includes(tool.name))
      : Object.values(toolkit.tools)
    providerOptions.tools = tools
    providerOptions.toolChoice = toolChoice

    if (tracker) {
      const prepared = tracker.prepareUnsafe(providerOptions.prompt)
      if (Option.isSome(prepared)) {
        providerOptions.previousResponseId = prepared.value.previousResponseId
        providerOptions.incrementalPrompt = prepared.value.prompt
      }
    }

    // If tool call resolution is disabled, return the response without
    // resolving the tool calls that were generated
    if (options.disableToolCallResolution === true) {
      const schema = Schema.NonEmptyArray(Response.StreamPart(toolkit))
      const decodeParts = Schema.decodeEffect(schema)
      return streamWithNonIncrementalFallback().pipe(
        Stream.mapArrayEffect((parts) =>
          decodeParts(parts).pipe(
            tracker ?
              Effect.tap((decodedParts) => {
                for (const part of decodedParts) {
                  if (part.type === "response-metadata" && Predicate.isNotUndefined(part.id)) {
                    tracker.markParts(providerOptions.prompt.content, part.id)
                  }
                }
                return Effect.void
              }) :
              identity
          )
        )
      ) as Stream.Stream<
        Response.StreamPart<Tools>,
        AiError.AiError | Schema.SchemaError,
        IdGenerator
      >
    }

    const ResponseSchema = Schema.NonEmptyArray(Response.StreamPart(toolkit))
    const decodeParts = Schema.decodeEffect(ResponseSchema)

    // Queue for decoded parts and tool results
    const queue = yield* Queue.make<
      Response.StreamPart<Tools>,
      | AiError.AiError
      | Cause.Done
      | Schema.SchemaError
    >()
    const deferredFinishParts: Array<Response.StreamPart<Tools>> = []

    // Emit pre-resolved tool results so Chat.streamText persists them to
    // history. This ensures collectToolApprovals({ excludeResolved }) can
    // find the corresponding tool-results on future rounds.
    if (preResolvedStreamParts.length > 0) {
      yield* Queue.offerAll(queue, preResolvedStreamParts)
    }

    // FiberSet to track concurrent tool call handlers
    const toolCallFibers = yield* FiberSet.make<void, AiError.AiError>()

    // Helper function to handle tool calls with approval logic
    const handleToolCall = Effect.fnUntraced(function*(part: Response.ToolCallPartEncoded) {
      const tool = toolkit.tools[part.name]
      if (!tool) return

      const needsApproval = yield* isApprovalNeeded(
        tool,
        part,
        providerOptions.prompt.content
      )

      if (needsApproval) {
        const idGen = yield* IdGenerator
        const approvalId = yield* idGen.generateId()
        const approvalPart = Response.makePart("tool-approval-request", {
          approvalId,
          toolCallId: part.id
        }) as Response.StreamPart<Tools>
        yield* Queue.offer(queue, approvalPart)
        return
      }

      yield* toolkit.handle(part.name, part.params as any).pipe(
        Stream.unwrap,
        Stream.runForEach((result) => {
          const toolResultPart = Response.makePart("tool-result", {
            id: part.id,
            name: part.name,
            providerExecuted: false,
            ...result
          }) as Response.StreamPart<Tools>
          return Queue.offer(queue, toolResultPart)
        })
      )
    })

    yield* streamWithNonIncrementalFallback().pipe(
      Stream.runForEachArray(
        Effect.fnUntraced(function*(chunk) {
          const parts = yield* decodeParts(chunk)
          if (tracker) {
            for (const part of parts) {
              if (part.type === "response-metadata" && part.id) {
                tracker.markParts(providerOptions.prompt.content, part.id)
              }
            }
          }
          // Defer finish parts until all tool handlers complete. This guarantees
          // tool results are emitted before finish in streaming mode.
          const immediateParts: Array<Response.StreamPart<Tools>> = []
          for (const part of parts) {
            if (part.type === "finish") {
              deferredFinishParts.push(part)
            } else {
              immediateParts.push(part)
            }
          }
          if (immediateParts.length > 0) {
            yield* Queue.offerAll(queue, immediateParts)
          }
          // Fork tool call handlers - use the raw chunk for encoded params
          for (const part of chunk) {
            if (part.type === "tool-call" && part.providerExecuted !== true) {
              yield* FiberSet.run(toolCallFibers, handleToolCall(part))
            }
          }
        })
      ),
      // Wait for all tool calls to either:
      // - complete (FiberSet.awaitEmpty)
      // - fail (FiberSet.join)
      Effect.andThen(
        Effect.raceFirst(
          FiberSet.join(toolCallFibers),
          FiberSet.awaitEmpty(toolCallFibers)
        )
      ),
      Effect.andThen(
        Queue.offerAll(queue, deferredFinishParts)
      ),
      // And then end the queue
      Effect.andThen(Queue.end(queue)),
      Effect.tapCause((cause) => Queue.failCause(queue, cause)),
      Effect.forkScoped
    )

    return Stream.fromQueue(queue)
  }) as any

  return {
    generateText: generateText as Service["generateText"],
    generateObject,
    streamText: streamText as Service["streamText"]
  } as const
})

// =============================================================================
// Accessors
// =============================================================================

/**
 * Generates text using a language model.
 *
 * **Example** (Generating text with options)
 *
 * ```ts
 * import { Effect } from "effect"
 * import { LanguageModel } from "effect/unstable/ai"
 *
 * const program = Effect.gen(function*() {
 *   const response = yield* LanguageModel.generateText({
 *     prompt: "Write a haiku about programming",
 *     toolChoice: "none"
 *   })
 *
 *   console.log(response.text)
 *   console.log(response.usage.inputTokens.total)
 *
 *   return response
 * })
 * ```
 *
 * @category text generation
 * @since 4.0.0
 */
export const generateText: {
  // No toolkit: force `{}` instead of falling back to `Record<string, Tool.Any>`.
  <
    Options extends NoExcessProperties<GenerateTextOptionsWithoutToolkit, Options>
  >(
    options: Options & GenerateTextOptionsWithoutToolkit
  ): Effect.Effect<
    GenerateTextResponse<{}>,
    ExtractError<Options>,
    LanguageModel | ExtractServices<Options>
  >
  // Generic toolkit: preserve caller-supplied `Tools` in helpers like `<Tools>(toolkit: WithHandler<Tools>) => ...`.
  <
    Tools extends Record<string, Tool.Any>,
    Options extends NoExcessProperties<GenerateTextOptions<Tools> & { readonly toolkit: ToolkitInput<Tools> }, Options>
  >(
    options: Options & GenerateTextOptions<Tools> & { readonly toolkit: ToolkitInput<Tools> }
  ): Effect.Effect<
    GenerateTextResponse<Tools>,
    ExtractError<Options>,
    LanguageModel | ExtractServices<Options>
  >
  // Toolkit unions: recover distributive `ExtractTools<Options>` inference for `toolkitA | toolkitB` call sites.
  <
    Options extends {
      readonly toolkit: ToolkitOption<any>
    } & NoExcessProperties<GenerateTextOptions<any>, Options>
  >(
    options: Options & GenerateTextOptions<ExtractTools<Options>> & { readonly toolkit: Options["toolkit"] }
  ): Effect.Effect<
    GenerateTextResponse<ExtractTools<Options>>,
    ExtractError<Options>,
    ExtractServices<Options> | LanguageModel
  >
} = (options: GenerateTextOptions<any>): Effect.Effect<
  GenerateTextResponse<any>,
  AiError.AiError,
  LanguageModel
> =>
  Effect.flatMap(
    Effect.service(LanguageModel),
    (model) => model.generateText(options as any)
  )

/**
 * Generates a structured object from a schema using a language model.
 *
 * **Example** (Generating an object)
 *
 * ```ts
 * import { Effect, Schema } from "effect"
 * import { LanguageModel } from "effect/unstable/ai"
 *
 * const EventSchema = Schema.Struct({
 *   title: Schema.String,
 *   date: Schema.String,
 *   location: Schema.String
 * })
 *
 * const program = Effect.gen(function*() {
 *   const response = yield* LanguageModel.generateObject({
 *     prompt:
 *       "Extract event info: Tech Conference on March 15th in San Francisco",
 *     schema: EventSchema,
 *     objectName: "event"
 *   })
 *
 *   console.log(response.value)
 *   // { title: "Tech Conference", date: "March 15th", location: "San Francisco" }
 *
 *   return response.value
 * })
 * ```
 *
 * @category object generation
 * @since 4.0.0
 */
export const generateObject = <
  ObjectEncoded extends Record<string, any>,
  StructuredOutputSchema extends Schema.Encoder<ObjectEncoded, unknown>,
  Options extends NoExcessProperties<
    GenerateObjectOptions<any, StructuredOutputSchema>,
    Options
  >
>(
  options: Options & GenerateObjectOptions<ExtractTools<Options>, StructuredOutputSchema>
): Effect.Effect<
  GenerateObjectResponse<ExtractTools<Options>, StructuredOutputSchema["Type"]>,
  ExtractError<Options>,
  ExtractServices<Options> | StructuredOutputSchema["DecodingServices"] | LanguageModel
> =>
  Effect.flatMap(
    Effect.service(LanguageModel),
    (model) => model.generateObject(options as any)
  ) as any

/**
 * Generates text using a language model with streaming output.
 *
 * **Details**
 *
 * Returns a stream of response parts that are emitted as soon as they are
 * available from the model, enabling real-time text generation experiences.
 *
 * **Example** (Streaming text deltas)
 *
 * ```ts
 * import { Console, Effect, Stream } from "effect"
 * import { LanguageModel } from "effect/unstable/ai"
 *
 * const program = LanguageModel.streamText({
 *   prompt: "Write a story about a space explorer"
 * }).pipe(Stream.runForEach((part) => {
 *   if (part.type === "text-delta") {
 *     return Console.log(part.delta)
 *   }
 *   return Effect.void
 * }))
 * ```
 *
 * @category text generation
 * @since 4.0.0
 */
export const streamText: {
  // No toolkit: force `{}` instead of falling back to `Record<string, Tool.Any>`.
  <
    Options extends NoExcessProperties<GenerateTextOptionsWithoutToolkit, Options>
  >(
    options: Options & GenerateTextOptionsWithoutToolkit
  ): Stream.Stream<
    Response.StreamPart<{}>,
    ExtractError<Options>,
    ExtractServices<Options> | LanguageModel
  >
  // Generic toolkit: preserve caller-supplied `Tools` in helpers like `<Tools>(toolkit: WithHandler<Tools>) => ...`.
  <
    Tools extends Record<string, Tool.Any>,
    Options extends NoExcessProperties<GenerateTextOptions<Tools> & { readonly toolkit: ToolkitInput<Tools> }, Options>
  >(
    options: Options & GenerateTextOptions<Tools> & { readonly toolkit: ToolkitInput<Tools> }
  ): Stream.Stream<
    Response.StreamPart<Tools>,
    ExtractError<Options>,
    ExtractServices<Options> | LanguageModel
  >
  // Toolkit unions: recover distributive `ExtractTools<Options>` inference for `toolkitA | toolkitB` call sites.
  <
    Options extends {
      readonly toolkit: ToolkitOption<any>
    } & NoExcessProperties<GenerateTextOptions<any>, Options>
  >(
    options: Options & GenerateTextOptions<ExtractTools<Options>> & { readonly toolkit: Options["toolkit"] }
  ): Stream.Stream<
    Response.StreamPart<ExtractTools<Options>>,
    ExtractError<Options>,
    ExtractServices<Options> | LanguageModel
  >
} = (options: GenerateTextOptions<any>): Stream.Stream<
  Response.StreamPart<{}>,
  AiError.AiError,
  LanguageModel
> =>
  Stream.unwrap(Effect.map(
    Effect.service(LanguageModel),
    (model) => model.streamText(options as any)
  )) as any

// =============================================================================
// Tool Approval Helpers
// =============================================================================

interface ApprovalResult {
  readonly approvalId: string
  readonly toolCallId: string
  readonly approved: boolean
  readonly reason?: string | undefined
  readonly toolCall?: Prompt.ToolCallPart | undefined
}

interface CollectToolApprovalsOptions {
  readonly excludeResolved?: boolean
}

const collectToolApprovals = (
  messages: ReadonlyArray<Prompt.Message>,
  options?: CollectToolApprovalsOptions
): {
  readonly approved: Array<ApprovalResult>
  readonly denied: Array<ApprovalResult>
} => {
  const requests = new Map<
    string,
    Pick<ApprovalResult, "approvalId" | "toolCallId">
  >()
  const responses: Array<Omit<ApprovalResult, "toolCallId" | "toolCall">> = []
  const toolCallsById = new Map<string, Prompt.ToolCallPart>()
  const toolResultIds = new Set<string>()

  // Collect all tool approval requests, responses, tool calls, and tool results
  for (const message of messages) {
    if (message.role === "assistant") {
      for (const part of message.content) {
        if (part.type === "tool-approval-request") {
          requests.set(part.approvalId, {
            approvalId: part.approvalId,
            toolCallId: part.toolCallId
          })
        }
        if (part.type === "tool-call") {
          toolCallsById.set(part.id, part)
        }
      }
    }
    if (message.role === "tool") {
      for (const part of message.content) {
        if (part.type === "tool-approval-response") {
          responses.push({
            approvalId: part.approvalId,
            approved: part.approved,
            reason: part.reason
          })
        }
        if (part.type === "tool-result") {
          toolResultIds.add(part.id)
        }
      }
    }
  }

  const approved: Array<ApprovalResult> = []
  const denied: Array<ApprovalResult> = []

  for (const response of responses) {
    const request = requests.get(response.approvalId)
    if (Predicate.isNotUndefined(request)) {
      // Skip if already resolved
      if (options?.excludeResolved && toolResultIds.has(request.toolCallId)) {
        continue
      }

      const result: ApprovalResult = {
        ...response,
        toolCallId: request.toolCallId,
        toolCall: toolCallsById.get(request.toolCallId)
      }

      if (response.approved) {
        approved.push(result)
      } else {
        denied.push(result)
      }
    }
  }

  return { approved, denied }
}

/**
 * Strip resolved approval artifacts from the prompt before sending to the
 * provider. After pre-resolving approvals (executing approved tools and
 * creating denial results), the original `tool-approval-request` parts in
 * assistant messages and `tool-approval-response` parts in tool messages are
 * no longer needed. Leaving them in causes provider-specific errors (e.g.
 * OpenAI rejects `mcp_approval_response` items that reference approval
 * requests it never issued).
 */
const stripResolvedApprovals = (
  prompt: Prompt.Prompt,
  approved: ReadonlyArray<ApprovalResult>,
  denied: ReadonlyArray<ApprovalResult>
): Prompt.Prompt => {
  const resolvedApprovalIds = new Set<string>()
  for (const a of approved) resolvedApprovalIds.add(a.approvalId)
  for (const d of denied) resolvedApprovalIds.add(d.approvalId)

  const cleanedMessages: Array<Prompt.Message> = []

  for (const message of prompt.content) {
    if (message.role === "assistant") {
      const filteredContent = message.content.filter(
        (part) =>
          part.type !== "tool-approval-request" ||
          !resolvedApprovalIds.has(part.approvalId)
      )
      if (filteredContent.length > 0) {
        cleanedMessages.push(
          Prompt.makeMessage("assistant", {
            content: filteredContent,
            options: message.options
          })
        )
      }
    } else if (message.role === "tool") {
      const filteredContent = message.content.filter(
        (part) =>
          part.type !== "tool-approval-response" ||
          !resolvedApprovalIds.has(part.approvalId)
      )
      if (filteredContent.length > 0) {
        cleanedMessages.push(
          Prompt.makeMessage("tool", {
            content: filteredContent,
            options: message.options
          })
        )
      }
    } else {
      cleanedMessages.push(message)
    }
  }

  return Prompt.fromMessages(cleanedMessages)
}

const isApprovalNeeded = Effect.fnUntraced(function*<T extends Tool.Any>(
  tool: T,
  toolCall: Response.ToolCallPartEncoded,
  messages: ReadonlyArray<Prompt.Message>
): Effect.fn.Return<boolean, Schema.SchemaError, Tool.HandlerServices<T>> {
  if (Predicate.isUndefined(tool.needsApproval)) {
    return false
  }

  if (typeof tool.needsApproval === "function") {
    const params = yield* Schema.decodeUnknownEffect(tool.parametersSchema)(
      toolCall.params
    ) as any

    const result = tool.needsApproval(params, {
      toolCallId: toolCall.id,
      messages
    })

    return Effect.isEffect(result) ? yield* result : result
  }

  return tool.needsApproval
}, Effect.orElseSucceed(constFalse))

const executeApprovedToolCalls = <Tools extends Record<string, Tool.Any>>(
  approvals: ReadonlyArray<ApprovalResult>,
  toolkit: Toolkit.WithHandler<Tools>,
  concurrency: Concurrency | undefined
): Effect.Effect<
  Array<Prompt.ToolResultPart>,
  Tool.HandlerError<Tools[keyof Tools]> | AiError.AiError,
  Tool.HandlerServices<Tools[keyof Tools]>
> => {
  const executeTool = Effect.fnUntraced(function*(approval: ApprovalResult) {
    const toolCall = approval.toolCall

    if (Predicate.isUndefined(toolCall)) {
      return yield* Effect.die("Approval missing tool call reference")
    }

    const tool = toolkit.tools[toolCall.name]

    if (Predicate.isUndefined(tool)) {
      return yield* AiError.make({
        module: "LanguageModel",
        method: "generateText",
        reason: new AiError.ToolNotFoundError({
          toolName: toolCall.name,
          availableTools: Object.keys(toolkit.tools)
        })
      })
    }

    const resultStream = yield* toolkit.handle(
      toolCall.name,
      toolCall.params as any
    )

    const terminalResult = yield* resultStream.pipe(
      Stream.filter((result) => result.preliminary === false),
      Stream.run(Sink.last()),
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.die("Tool handler did not produce a final result"),
          onSome: Effect.succeed
        })
      )
    )

    return Prompt.makePart("tool-result", {
      id: approval.toolCallId,
      name: toolCall.name,
      isFailure: terminalResult.isFailure,
      result: terminalResult.encodedResult
    })
  })

  return Effect.gen(function*() {
    const resolveConcurrency = concurrency === "inherit"
      ? yield* Effect.service(CurrentConcurrency)
      : (concurrency ?? "unbounded")

    return yield* Effect.forEach(approvals, executeTool, {
      concurrency: resolveConcurrency
    })
  })
}

const createDenialResults = (
  denials: ReadonlyArray<ApprovalResult>
): ReadonlyArray<Prompt.ToolResultPart> => {
  const results: Array<Prompt.ToolResultPart> = []
  for (const denial of denials) {
    if (Predicate.isNotUndefined(denial.toolCall)) {
      results.push(
        Prompt.makePart("tool-result", {
          id: denial.toolCallId,
          name: denial.toolCall.name,
          isFailure: true,
          result: { type: "execution-denied", reason: denial.reason }
        })
      )
    }
  }
  return results
}

// =============================================================================
// Tool Call Resolution
// =============================================================================

type ToolResolutionResult<Tools extends Record<string, Tool.Any>> =
  | Response.ToolResultPart<
    Tool.Name<Tools[keyof Tools]>,
    Tool.Success<Tools[keyof Tools]>,
    Tool.Failure<Tools[keyof Tools]>
  >
  | Response.ToolApprovalRequestPart

const resolveToolCalls = <Tools extends Record<string, Tool.Any>>(
  content: ReadonlyArray<Response.AllPartsEncoded>,
  toolkit: Toolkit.WithHandler<Tools>,
  messages: ReadonlyArray<Prompt.Message>,
  concurrency: Concurrency | undefined
): Stream.Stream<
  ToolResolutionResult<Tools>,
  Tool.HandlerError<Tools[keyof Tools]> | AiError.AiError,
  Tool.HandlerServices<Tools[keyof Tools]> | IdGenerator
> => {
  const toolCalls: Array<Response.ToolCallPartEncoded> = []

  for (const part of content) {
    if (part.type === "tool-call") {
      if (part.providerExecuted === true) {
        continue
      }
      toolCalls.push(part)
    }
  }

  const { approved, denied } = collectToolApprovals(messages)
  const approvedToolCallIds = new Set(
    approved.map((approval) => approval.toolCallId)
  )
  const deniedByToolCallId = new Map(
    denied.map((denial) => [denial.toolCallId, denial])
  )

  const streams = toolCalls.map((toolCall) =>
    Effect.gen(function*() {
      const tool = toolkit.tools[toolCall.name]
      if (!tool) {
        return Stream.empty
      }

      if (deniedByToolCallId.has(toolCall.id)) {
        const denial = deniedByToolCallId.get(toolCall.id)!
        return Stream.succeed(
          Response.makePart("tool-result", {
            id: toolCall.id,
            name: toolCall.name,
            providerExecuted: false,
            isFailure: true,
            result: { type: "execution-denied", reason: denial.reason },
            encodedResult: { type: "execution-denied", reason: denial.reason },
            preliminary: false
          }) as ToolResolutionResult<Tools>
        )
      }

      if (approvedToolCallIds.has(toolCall.id)) {
        return toolkit.handle(toolCall.name, toolCall.params as any).pipe(
          Stream.unwrap,
          Stream.map(
            (result) =>
              Response.makePart("tool-result", {
                id: toolCall.id,
                name: toolCall.name,
                providerExecuted: false,
                ...result
              }) as ToolResolutionResult<Tools>
          )
        )
      }

      const needsApproval = yield* isApprovalNeeded(tool, toolCall, messages)
      if (needsApproval) {
        const generator = yield* IdGenerator
        const approvalId = yield* generator.generateId()
        return Stream.succeed(
          Response.makePart("tool-approval-request", {
            approvalId,
            toolCallId: toolCall.id
          }) as ToolResolutionResult<Tools>
        )
      }

      return toolkit.handle(toolCall.name, toolCall.params as any).pipe(
        Stream.unwrap,
        Stream.map(
          (result) =>
            Response.makePart("tool-result", {
              id: toolCall.id,
              name: toolCall.name,
              providerExecuted: false,
              ...result
            }) as ToolResolutionResult<Tools>
        )
      )
    }).pipe(Stream.unwrap)
  )

  const resolveConcurrency = concurrency === "inherit"
    ? Effect.service(CurrentConcurrency)
    : Effect.succeed(concurrency ?? "unbounded")

  return resolveConcurrency.pipe(
    Effect.map((concurrency) => Stream.mergeAll(streams, { concurrency })),
    Stream.unwrap
  )
}

// =============================================================================
// Utilities
// =============================================================================

const resolveToolkit = <Tools extends Record<string, Tool.Any>, E, R>(
  toolkit: ToolkitInput<Tools, E, R>
): Effect.Effect<Toolkit.WithHandler<Tools>, E, R> =>
  (Effect.isEffect(toolkit)
    ? toolkit
    : Effect.succeed(toolkit as unknown as Toolkit.WithHandler<Tools>)) as any

/** @internal */
export const getObjectName = <StructuredOutputSchema extends Schema.Top>(
  objectName: string | undefined,
  schema: StructuredOutputSchema
): string => {
  if (Predicate.isNotUndefined(objectName)) {
    return objectName
  }
  if ("identifier" in schema && typeof schema.identifier === "string") {
    return schema.identifier
  }
  const identifier = AST.resolveIdentifier(schema.ast)
  if (typeof identifier === "string") {
    return identifier
  }
  return "generateObject"
}

const resolveStructuredOutput = Effect.fnUntraced(function*<
  StructuredOutputSchema extends Schema.Top
>(response: ReadonlyArray<Response.AllParts<any>>, schema: StructuredOutputSchema) {
  const texts: Array<string> = []
  for (const part of response) {
    if (part.type === "text") {
      texts.push(part.text)
    }
  }

  const text = texts.join("")

  if (text.length === 0) {
    return yield* AiError.make({
      module: "LanguageModel",
      method: "generateObject",
      reason: new AiError.StructuredOutputError({
        description: "No text content in response",
        responseText: text
      })
    })
  }

  const decode = Schema.decodeEffect(Schema.fromJsonString(schema))
  return yield* Effect.mapError(decode(text), (error) =>
    AiError.make({
      module: "LanguageModel",
      method: "generateObject",
      reason: AiError.StructuredOutputError.fromSchemaError(error, text)
    }))
})

const applySpanTransformer = (
  transformer: Option.Option<SpanTransformer>,
  response: ReadonlyArray<Response.AllParts<any>>,
  options: ProviderOptions
): void => {
  if (Option.isSome(transformer)) {
    transformer.value({ ...options, response: response as any })
  }
}
