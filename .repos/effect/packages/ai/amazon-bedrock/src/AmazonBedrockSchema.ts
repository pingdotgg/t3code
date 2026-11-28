/**
 * The `AmazonBedrockSchema` module defines handwritten schemas for the subset
 * of the Amazon Bedrock Converse API that this provider uses: the Converse
 * request and response, and the ConverseStream events.
 *
 * **Details**
 *
 * The Smithy model of the Converse API expresses most content as unions. A
 * union is modelled here as a struct whose members are all optional. Every
 * struct that Bedrock sends back keeps the fields this provider does not
 * model, so a new union member or field reaches a low-level consumer instead
 * of failing the whole response or being dropped. Blobs travel as base64
 * strings, as in the JSON protocol.
 *
 * @stability unstable
 * @since 4.0.0
 */
import type * as Brand from "effect/Brand"
import * as Predicate from "effect/Predicate"
import * as Schema from "effect/Schema"

/**
 * The rest of every response struct: fields this provider does not model are
 * decoded as they are, so a low-level consumer can read them.
 */
const UnknownRecord = Schema.Record(Schema.String, Schema.Unknown)

/**
 * A struct that Bedrock can send back, with {@link UnknownRecord} as its rest.
 */
const ResponseStruct = <const Fields extends Schema.Struct.Fields>(fields: Fields) =>
  Schema.StructWithRest(Schema.Struct(fields), [UnknownRecord])

// =============================================================================
// Common
// =============================================================================

/**
 * The stop reasons that the Smithy model of the Converse API names.
 *
 * @stability unstable
 * @category schemas
 * @since 4.0.0
 */
export const KnownStopReason = Schema.Literals([
  "end_turn",
  "tool_use",
  "max_tokens",
  "stop_sequence",
  "guardrail_intervened",
  "content_filtered",
  "malformed_model_output",
  "malformed_tool_use",
  "model_context_window_exceeded"
])

/**
 * The type of {@link KnownStopReason}.
 *
 * @stability unstable
 * @category schemas
 * @since 4.0.0
 */
export type KnownStopReason = typeof KnownStopReason.Type

/**
 * The reason the model stopped generating a response. Any string decodes, so a
 * reason that Bedrock adds later does not fail the response.
 *
 * @stability unstable
 * @category schemas
 * @since 4.0.0
 */
export const StopReason = Schema.Union([KnownStopReason, Schema.StringForLiteralAutocomplete])

/**
 * The type of {@link StopReason}.
 *
 * @stability unstable
 * @category schemas
 * @since 4.0.0
 */
export type StopReason = typeof StopReason.Type

/**
 * Token usage statistics returned by the Converse API.
 *
 * @stability unstable
 * @category schemas
 * @since 4.0.0
 */
export const TokenUsage = ResponseStruct({
  inputTokens: Schema.Int,
  outputTokens: Schema.Int,
  totalTokens: Schema.Int,
  cacheReadInputTokens: Schema.optional(Schema.Int),
  cacheWriteInputTokens: Schema.optional(Schema.Int)
})

/**
 * The type of {@link TokenUsage}.
 *
 * @stability unstable
 * @category schemas
 * @since 4.0.0
 */
export type TokenUsage = typeof TokenUsage.Type

// =============================================================================
// Content Blocks
// =============================================================================

/**
 * A tool-use content block: the model's request to invoke a tool.
 *
 * @stability unstable
 * @category schemas
 * @since 4.0.0
 */
export const ToolUseBlock = ResponseStruct({
  toolUseId: Schema.String,
  name: Schema.String,
  input: Schema.Unknown
})

/**
 * One piece of the content of a tool result: text or a JSON document.
 *
 * @stability unstable
 * @category schemas
 * @since 4.0.0
 */
export const ToolResultContentBlock = ResponseStruct({
  text: Schema.optional(Schema.String),
  json: Schema.optional(Schema.Unknown)
})

/**
 * A tool-result content block: the outcome of a tool invocation fed back to
 * the model.
 *
 * @stability unstable
 * @category schemas
 * @since 4.0.0
 */
export const ToolResultBlock = ResponseStruct({
  toolUseId: Schema.String,
  content: Schema.Array(ToolResultContentBlock),
  status: Schema.optional(Schema.Literals(["success", "error"]))
})

/**
 * The reasoning text produced by a model, with the signature that verifies
 * the model generated it. The signature must be echoed back unmodified when
 * the block is sent in a later turn.
 *
 * @stability unstable
 * @category schemas
 * @since 4.0.0
 */
export const ReasoningTextBlock = ResponseStruct({
  text: Schema.String,
  signature: Schema.optional(Schema.String)
})

/**
 * A reasoning content block: either reasoning text or reasoning that the
 * model provider redacted, as a base64 string.
 *
 * @stability unstable
 * @category schemas
 * @since 4.0.0
 */
export const ReasoningContentBlock = ResponseStruct({
  reasoningText: Schema.optional(ReasoningTextBlock),
  redactedContent: Schema.optional(Schema.String)
})

/**
 * A cache point marking the end of a reusable prefix of a request.
 *
 * **Details**
 *
 * Converse caches everything preceding the block, so a cache point is its own
 * content block appended after the content it should cover. `ttl` opts into
 * extended caching; when omitted Bedrock uses the default lifetime.
 * Bedrock does not send cache points back, so unlike the response structs
 * this one keeps no unmodelled fields and stays exact as a request option.
 *
 * @stability unstable
 * @category schemas
 * @since 4.0.0
 */
export const CachePointBlock = Schema.Struct({
  type: Schema.Literal("default"),
  ttl: Schema.optionalKey(Schema.Literals(["5m", "1h"]))
})

/**
 * The type of {@link CachePointBlock}.
 *
 * @stability unstable
 * @category schemas
 * @since 4.0.0
 */
export type CachePointBlock = typeof CachePointBlock.Type

/**
 * The image formats the Converse API accepts.
 *
 * @stability unstable
 * @category schemas
 * @since 4.0.0
 */
export const ImageFormat = Schema.Literals(["png", "jpeg", "gif", "webp"])

/**
 * An image content block. The image is sent as base64 bytes.
 *
 * @stability unstable
 * @category schemas
 * @since 4.0.0
 */
export const ImageBlock = ResponseStruct({
  format: ImageFormat,
  source: ResponseStruct({ bytes: Schema.String })
})

/**
 * The document formats the Converse API accepts.
 *
 * @stability unstable
 * @category schemas
 * @since 4.0.0
 */
export const DocumentFormat = Schema.Literals(["pdf", "csv", "doc", "docx", "xls", "xlsx", "html", "txt", "md"])

/**
 * A document content block. Bedrock restricts `name` to alphanumerics, single
 * runs of whitespace, hyphens, parentheses and square brackets.
 *
 * @stability unstable
 * @category schemas
 * @since 4.0.0
 */
export const DocumentBlock = ResponseStruct({
  format: DocumentFormat,
  name: Schema.String,
  source: ResponseStruct({ bytes: Schema.String })
})

/**
 * A content block within a Converse message. A block member this provider
 * does not model, such as `citationsContent`, is kept as it was sent.
 *
 * @stability unstable
 * @category schemas
 * @since 4.0.0
 */
export const ContentBlock = ResponseStruct({
  text: Schema.optional(Schema.String),
  toolUse: Schema.optional(ToolUseBlock),
  toolResult: Schema.optional(ToolResultBlock),
  reasoningContent: Schema.optional(ReasoningContentBlock),
  image: Schema.optional(ImageBlock),
  document: Schema.optional(DocumentBlock),
  cachePoint: Schema.optional(CachePointBlock)
})

/**
 * A message within a Converse conversation.
 *
 * @stability unstable
 * @category schemas
 * @since 4.0.0
 */
export const Message = ResponseStruct({
  role: Schema.Literals(["user", "assistant"]),
  content: Schema.Array(ContentBlock)
})

/**
 * A system content block: system text or a cache point.
 *
 * @stability unstable
 * @category schemas
 * @since 4.0.0
 */
export const SystemContentBlock = Schema.Struct({
  text: Schema.optional(Schema.String),
  cachePoint: Schema.optional(CachePointBlock)
})

// =============================================================================
// Request
// =============================================================================

/**
 * Base inference parameters to pass to a model in a Converse call.
 *
 * @stability unstable
 * @category schemas
 * @since 4.0.0
 */
export const InferenceConfiguration = Schema.Struct({
  maxTokens: Schema.optional(Schema.Int),
  stopSequences: Schema.optional(Schema.Array(Schema.String)),
  temperature: Schema.optional(Schema.Number),
  topP: Schema.optional(Schema.Number)
})

/**
 * The JSON Schema specification of a tool the model may call.
 *
 * @stability unstable
 * @category schemas
 * @since 4.0.0
 */
export const ToolSpecification = Schema.Struct({
  name: Schema.String,
  description: Schema.optionalKey(Schema.String),
  inputSchema: Schema.Struct({
    json: Schema.Record(Schema.String, Schema.Unknown)
  })
})

/**
 * A tool entry within a {@link ToolConfiguration}: a tool specification, or a
 * cache point marking the end of the cacheable prefix of the tool list.
 *
 * @stability unstable
 * @category schemas
 * @since 4.0.0
 */
export const Tool = Schema.Struct({
  toolSpec: Schema.optional(ToolSpecification),
  cachePoint: Schema.optional(CachePointBlock)
})

/**
 * Controls how the model selects a tool: let it decide (`auto`), force any
 * tool (`any`), or force a specific tool (`tool`).
 *
 * @stability unstable
 * @category schemas
 * @since 4.0.0
 */
export const ToolChoice = Schema.Union([
  Schema.Struct({ auto: Schema.Struct({}) }),
  Schema.Struct({ any: Schema.Struct({}) }),
  Schema.Struct({ tool: Schema.Struct({ name: Schema.String }) })
])

/**
 * The type of {@link ToolChoice}.
 *
 * @stability unstable
 * @category schemas
 * @since 4.0.0
 */
export type ToolChoice = typeof ToolChoice.Type

/**
 * The tool configuration for a Converse request.
 *
 * @stability unstable
 * @category schemas
 * @since 4.0.0
 */
export const ToolConfiguration = Schema.Struct({
  tools: Schema.Array(Tool),
  toolChoice: Schema.optionalKey(ToolChoice)
})

/**
 * A JSON Schema the model's output must conform to. `schema` is the JSON
 * Schema serialized to a string, as Converse requires.
 *
 * @stability unstable
 * @category schemas
 * @since 4.0.0
 */
export const JsonSchemaDefinition = Schema.Struct({
  schema: Schema.String,
  name: Schema.optionalKey(Schema.String),
  description: Schema.optionalKey(Schema.String)
})

/**
 * Structured output parameters for a Converse request.
 *
 * @stability unstable
 * @category schemas
 * @since 4.0.0
 */
export const OutputFormat = Schema.Struct({
  type: Schema.Literal("json_schema"),
  structure: Schema.Struct({ jsonSchema: JsonSchemaDefinition })
})

/**
 * Output configuration for a Converse request: native structured output
 * (`textFormat`) and the model's effort level (`effort`, on the models that
 * accept it).
 *
 * @stability unstable
 * @category schemas
 * @since 4.0.0
 */
export const OutputConfig = Schema.Struct({
  textFormat: Schema.optionalKey(OutputFormat),
  effort: Schema.optionalKey(Schema.String)
})

/**
 * The guardrail of a Converse request. `streamProcessingMode` applies to
 * ConverseStream only and is removed from Converse requests.
 *
 * @stability unstable
 * @category schemas
 * @since 4.0.0
 */
export const GuardrailConfiguration = Schema.Struct({
  guardrailIdentifier: Schema.String,
  guardrailVersion: Schema.String,
  trace: Schema.optionalKey(Schema.Literals(["enabled", "disabled", "enabled_full"])),
  streamProcessingMode: Schema.optionalKey(Schema.Literals(["sync", "async"]))
})

/**
 * The request payload for the Converse and ConverseStream operations.
 *
 * **Details**
 *
 * `modelId` travels in the URL, not in the body. `additionalModelRequestFields`
 * carries inference parameters specific to the target model; extended
 * thinking on an Anthropic model is enabled through it.
 *
 * @stability unstable
 * @category schemas
 * @since 4.0.0
 */
export const ConverseRequest = Schema.Struct({
  modelId: Schema.String,
  messages: Schema.Array(Message),
  system: Schema.optional(Schema.Array(SystemContentBlock)),
  toolConfig: Schema.optionalKey(ToolConfiguration),
  inferenceConfig: Schema.optional(InferenceConfiguration),
  outputConfig: Schema.optionalKey(OutputConfig),
  additionalModelRequestFields: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  guardrailConfig: Schema.optional(GuardrailConfiguration)
})

/**
 * The type of {@link ConverseRequest}.
 *
 * @stability unstable
 * @category schemas
 * @since 4.0.0
 */
export type ConverseRequest = typeof ConverseRequest.Type

// =============================================================================
// Response
// =============================================================================

/**
 * Metrics about a Converse call.
 *
 * @stability unstable
 * @category schemas
 * @since 4.0.0
 */
export const ConverseMetrics = ResponseStruct({
  latencyMs: Schema.Number
})

/**
 * The response from a successful Converse call. `trace` and any field this
 * provider does not model, such as `additionalModelResponseFields`, are kept
 * as Bedrock sent them.
 *
 * @stability unstable
 * @category schemas
 * @since 4.0.0
 */
export const ConverseResponse = ResponseStruct({
  output: ResponseStruct({ message: Message }),
  usage: TokenUsage,
  stopReason: StopReason,
  metrics: Schema.optional(ConverseMetrics),
  trace: Schema.optional(Schema.Unknown)
})

/**
 * The type of {@link ConverseResponse}.
 *
 * @stability unstable
 * @category schemas
 * @since 4.0.0
 */
export type ConverseResponse = typeof ConverseResponse.Type

// =============================================================================
// Stream Events
// =============================================================================

/**
 * The start of a streamed message.
 *
 * @stability unstable
 * @category schemas
 * @since 4.0.0
 */
export const MessageStartEvent = ResponseStruct({
  role: Schema.Literals(["user", "assistant"])
})

/**
 * The start of a streamed content block. Tool-use blocks announce their id and
 * name here; text and reasoning blocks start directly with deltas.
 *
 * @stability unstable
 * @category schemas
 * @since 4.0.0
 */
export const ContentBlockStartEvent = ResponseStruct({
  contentBlockIndex: Schema.Int,
  start: Schema.optional(ResponseStruct({
    toolUse: Schema.optional(ResponseStruct({ toolUseId: Schema.String, name: Schema.String }))
  }))
})

/**
 * A delta within a streamed content block: text, a fragment of tool input
 * JSON, or reasoning text, signature or redacted content. A delta member this
 * provider does not model, such as `citation`, is kept as it was sent.
 *
 * @stability unstable
 * @category schemas
 * @since 4.0.0
 */
export const ContentBlockDelta = ResponseStruct({
  text: Schema.optional(Schema.String),
  toolUse: Schema.optional(ResponseStruct({ input: Schema.String })),
  reasoningContent: Schema.optional(ResponseStruct({
    text: Schema.optional(Schema.String),
    signature: Schema.optional(Schema.String),
    redactedContent: Schema.optional(Schema.String)
  }))
})

/**
 * A streamed delta event for a content block.
 *
 * @stability unstable
 * @category schemas
 * @since 4.0.0
 */
export const ContentBlockDeltaEvent = ResponseStruct({
  contentBlockIndex: Schema.Int,
  delta: ContentBlockDelta
})

/**
 * A streamed stop event for a content block.
 *
 * @stability unstable
 * @category schemas
 * @since 4.0.0
 */
export const ContentBlockStopEvent = ResponseStruct({
  contentBlockIndex: Schema.Int
})

/**
 * The stop event for a streamed message.
 *
 * @stability unstable
 * @category schemas
 * @since 4.0.0
 */
export const MessageStopEvent = ResponseStruct({
  stopReason: StopReason
})

/**
 * The trailing metadata event of a stream, carrying usage and metrics. Bedrock
 * sends it after `messageStop`.
 *
 * @stability unstable
 * @category schemas
 * @since 4.0.0
 */
export const ConverseStreamMetadataEvent = ResponseStruct({
  usage: TokenUsage,
  metrics: Schema.optional(ConverseMetrics),
  trace: Schema.optional(Schema.Unknown)
})

const KnownConverseStreamEvent = Schema.Union([
  Schema.Struct({ messageStart: MessageStartEvent }),
  Schema.Struct({ contentBlockStart: ContentBlockStartEvent }),
  Schema.Struct({ contentBlockDelta: ContentBlockDeltaEvent }),
  Schema.Struct({ contentBlockStop: ContentBlockStopEvent }),
  Schema.Struct({ messageStop: MessageStopEvent }),
  Schema.Struct({ metadata: ConverseStreamMetadataEvent })
])

const knownStreamEventTypes = new Set(
  KnownConverseStreamEvent.members.flatMap((member) => Object.keys(member.fields))
)

/**
 * A ConverseStream event this provider does not model, keyed by its
 * event-stream `:event-type` like every other event: `{ [eventType]: payload }`.
 *
 * **Details**
 *
 * The type declares no index signature, so an `in` check on a
 * {@link ConverseStreamEvent} still narrows to the known event, and the brand
 * keeps this member apart from them. Read the payload with `Object.entries`.
 *
 * @stability unstable
 * @category models
 * @since 4.0.0
 */
export type UnknownConverseStreamEvent = Brand.Branded<object, "UnknownConverseStreamEvent">

/**
 * Fallback schema for a ConverseStream event this provider does not model.
 *
 * @stability unstable
 * @category schemas
 * @since 4.0.0
 */
export const UnknownConverseStreamEvent = Schema.declare<UnknownConverseStreamEvent>(
  (value): value is UnknownConverseStreamEvent => {
    if (!Predicate.isObject(value)) {
      return false
    }
    const keys = Object.keys(value)
    return keys.length === 1 && !knownStreamEventTypes.has(keys[0])
  },
  {
    identifier: "UnknownConverseStreamEvent",
    description: "Fallback for unknown future stream events"
  }
)

/**
 * A ConverseStream event, keyed by its event-stream `:event-type`, as the AWS
 * SDK shapes it: `{ messageStart: ... }`, `{ contentBlockDelta: ... }` and so
 * on. An event type this provider does not model decodes through
 * {@link UnknownConverseStreamEvent}; a malformed known event still fails.
 *
 * @stability unstable
 * @category schemas
 * @since 4.0.0
 */
export const ConverseStreamEvent = Schema.Union([...KnownConverseStreamEvent.members, UnknownConverseStreamEvent])

/**
 * The type of {@link ConverseStreamEvent}.
 *
 * @stability unstable
 * @category schemas
 * @since 4.0.0
 */
export type ConverseStreamEvent = typeof ConverseStreamEvent.Type

/**
 * The body of an exception frame in a ConverseStream response, such as a
 * `throttlingException`.
 *
 * @stability unstable
 * @category schemas
 * @since 4.0.0
 */
export const ConverseStreamException = ResponseStruct({
  message: Schema.optional(Schema.String)
})
