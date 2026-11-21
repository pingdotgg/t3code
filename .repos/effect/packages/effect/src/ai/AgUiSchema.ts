/**
 * Defines schemas for the Agent User Interaction (AG-UI) protocol.
 *
 * AG-UI connects an agent backend to a user-facing application: the
 * application posts a `RunAgentInput` and the agent answers with a stream of
 * events describing the run. These schemas follow the AG-UI 1.0 specification
 * and describe the request body, the conversation messages it carries, and
 * every event type. Converting to and from `effect/ai` values lives in `AgUi`,
 * and the HTTP binding lives in `AgUiServer`.
 *
 * @see https://docs.ag-ui.com
 *
 * @stability experimental
 * @since 4.1.0
 */
import * as Effect from "../Effect.ts"
import { identity } from "../Function.ts"
import * as Predicate from "../Predicate.ts"
import * as Schema from "../Schema.ts"
import * as SchemaTransformation from "../SchemaTransformation.ts"

/**
 * AG-UI protocol version implemented by these schemas.
 *
 * @stability experimental
 * @category constants
 * @since 4.1.0
 */
export const protocolVersion = "1.0"

// =============================================================================
// Shared
// =============================================================================

/**
 * Schema for open-ended metadata attached to events, messages, tools, and
 * other protocol values.
 *
 * **Details**
 *
 * The `ag-ui` key is reserved for the protocol's own use.
 *
 * @stability experimental
 * @category schemas
 * @since 4.1.0
 */
export const Metadata = Schema.Record(Schema.String, Schema.Unknown)

/**
 * Open-ended metadata attached to events, messages, tools, and other protocol
 * values.
 *
 * @stability experimental
 * @category models
 * @since 4.1.0
 */
export type Metadata = typeof Metadata.Type

const baseEventFields = {
  timestamp: Schema.optionalKey(Schema.Int),
  rawEvent: Schema.optionalKey(Schema.Unknown),
  metadata: Schema.optionalKey(Metadata)
}

const subagentEventFields = {
  ...baseEventFields,
  subagentRunId: Schema.optionalKey(Schema.String)
}

const TokenCount = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))

// AG-UI consumers remove list elements they do not recognise, such as union
// members or closed-set values added by a newer protocol version, instead of
// rejecting the value holding them. Recognised but malformed elements still
// fail to decode.
const withoutUnknownMembers = <S extends Schema.Constraint>(item: S, isUnknown: (value: unknown) => boolean) => {
  // Accepts only unrecognised material, so it never hides a malformed item.
  // JSON Schema and OpenAPI document the canonical model: a union splices in
  // a member that is only an `anyOf`, so an empty one leaves just the item's
  // variants and generated clients keep their discriminated types.
  const Unrecognised = Schema.Any.check(Schema.makeFilter(isUnknown, {
    toJsonSchema: () => ({ anyOf: [] })
  }))
  return Schema.Array(Schema.Union([item, Unrecognised])).pipe(
    Schema.decodeTo(
      Schema.Array(Schema.toType(item)),
      SchemaTransformation.transform({
        decode: (values) => values.filter((value) => !isUnknown(value)) as ReadonlyArray<S["Type"]>,
        encode: identity
      })
    )
  )
}

// Only a string outside the closed set is unrecognised; a missing or
// mistyped value is malformed
const hasUnknownTag = (value: unknown, key: string, tags: ReadonlySet<string>): boolean =>
  Predicate.isObject(value) && typeof value[key] === "string" && !tags.has(value[key])

// =============================================================================
// Content
// =============================================================================

/**
 * Schema for media bytes carried inline as base64 data.
 *
 * @stability experimental
 * @category schemas
 * @since 4.1.0
 */
export const DataSource = Schema.Struct({
  type: Schema.Literal("data"),
  value: Schema.String,
  mimeType: Schema.String
})

/**
 * Media bytes carried inline as base64 data.
 *
 * @stability experimental
 * @category models
 * @since 4.1.0
 */
export type DataSource = typeof DataSource.Type

/**
 * Schema for media bytes referenced by URL.
 *
 * @stability experimental
 * @category schemas
 * @since 4.1.0
 */
export const UrlSource = Schema.Struct({
  type: Schema.Literal("url"),
  value: Schema.String,
  mimeType: Schema.optionalKey(Schema.String)
})

/**
 * Media bytes referenced by URL.
 *
 * @stability experimental
 * @category models
 * @since 4.1.0
 */
export type UrlSource = typeof UrlSource.Type

/**
 * Schema for media bytes already stored at a provider and named by a handle
 * that provider issued.
 *
 * @stability experimental
 * @category schemas
 * @since 4.1.0
 */
export const FileSource = Schema.Struct({
  type: Schema.Literal("file"),
  value: Schema.String,
  provider: Schema.optionalKey(Schema.String),
  mimeType: Schema.optionalKey(Schema.String)
})

/**
 * Media bytes already stored at a provider and named by a handle that provider
 * issued.
 *
 * @stability experimental
 * @category models
 * @since 4.1.0
 */
export type FileSource = typeof FileSource.Type

/**
 * Schema for the source of a media content part.
 *
 * @stability experimental
 * @category schemas
 * @since 4.1.0
 */
export const PartSource = Schema.Union([DataSource, UrlSource, FileSource])

/**
 * Source of a media content part.
 *
 * @stability experimental
 * @category models
 * @since 4.1.0
 */
export type PartSource = typeof PartSource.Type

/**
 * Schema for a text content part.
 *
 * @stability experimental
 * @category schemas
 * @since 4.1.0
 */
export const TextPart = Schema.Struct({
  type: Schema.Literal("text"),
  id: Schema.optionalKey(Schema.String),
  text: Schema.String,
  metadata: Schema.optionalKey(Schema.Unknown)
})

/**
 * A text content part.
 *
 * @stability experimental
 * @category models
 * @since 4.1.0
 */
export type TextPart = typeof TextPart.Type

const mediaPart = <Type extends string>(type: Type) =>
  Schema.Struct({
    type: Schema.Literal(type),
    id: Schema.optionalKey(Schema.String),
    source: PartSource,
    metadata: Schema.optionalKey(Schema.Unknown)
  })

/**
 * Schema for an image content part.
 *
 * @stability experimental
 * @category schemas
 * @since 4.1.0
 */
export const ImagePart = mediaPart("image")

/**
 * An image content part.
 *
 * @stability experimental
 * @category models
 * @since 4.1.0
 */
export type ImagePart = typeof ImagePart.Type

/**
 * Schema for an audio content part.
 *
 * @stability experimental
 * @category schemas
 * @since 4.1.0
 */
export const AudioPart = mediaPart("audio")

/**
 * An audio content part.
 *
 * @stability experimental
 * @category models
 * @since 4.1.0
 */
export type AudioPart = typeof AudioPart.Type

/**
 * Schema for a video content part.
 *
 * @stability experimental
 * @category schemas
 * @since 4.1.0
 */
export const VideoPart = mediaPart("video")

/**
 * A video content part.
 *
 * @stability experimental
 * @category models
 * @since 4.1.0
 */
export type VideoPart = typeof VideoPart.Type

/**
 * Schema for a document content part.
 *
 * @stability experimental
 * @category schemas
 * @since 4.1.0
 */
export const DocumentPart = mediaPart("document")

/**
 * A document content part.
 *
 * @stability experimental
 * @category models
 * @since 4.1.0
 */
export type DocumentPart = typeof DocumentPart.Type

/**
 * Schema for any content part of a user or tool message.
 *
 * @stability experimental
 * @category schemas
 * @since 4.1.0
 */
export const ContentPart = Schema.Union([TextPart, ImagePart, AudioPart, VideoPart, DocumentPart])

/**
 * Any content part of a user or tool message.
 *
 * @stability experimental
 * @category models
 * @since 4.1.0
 */
export type ContentPart = typeof ContentPart.Type

const contentPartTypes: ReadonlySet<string> = new Set(["text", "image", "audio", "video", "document"])
const partSourceTypes: ReadonlySet<string> = new Set(["data", "url", "file"])

const mediaPartTypes: ReadonlySet<unknown> = new Set(["image", "audio", "video", "document"])

// A recognised media part whose required source is unrecognised is removed
// with it
const isUnknownContentPart = (value: unknown): boolean =>
  hasUnknownTag(value, "type", contentPartTypes) ||
  (Predicate.isObject(value) && mediaPartTypes.has(value.type) &&
    hasUnknownTag(value.source, "type", partSourceTypes))

const Content = Schema.Union([Schema.String, withoutUnknownMembers(ContentPart, isUnknownContentPart)])

// =============================================================================
// Messages
// =============================================================================

const messageFields = {
  subagentRunId: Schema.optionalKey(Schema.String),
  id: Schema.String,
  metadata: Schema.optionalKey(Metadata)
}

/**
 * Schema for instructions from the application developer.
 *
 * @stability experimental
 * @category schemas
 * @since 4.1.0
 */
export const DeveloperMessage = Schema.Struct({
  ...messageFields,
  role: Schema.Literal("developer"),
  name: Schema.optionalKey(Schema.String),
  encryptedValue: Schema.optionalKey(Schema.String),
  content: Schema.String
})

/**
 * Instructions from the application developer.
 *
 * @stability experimental
 * @category models
 * @since 4.1.0
 */
export type DeveloperMessage = typeof DeveloperMessage.Type

/**
 * Schema for instructions from the system.
 *
 * @stability experimental
 * @category schemas
 * @since 4.1.0
 */
export const SystemMessage = Schema.Struct({
  ...messageFields,
  role: Schema.Literal("system"),
  name: Schema.optionalKey(Schema.String),
  encryptedValue: Schema.optionalKey(Schema.String),
  content: Schema.String
})

/**
 * Instructions from the system.
 *
 * @stability experimental
 * @category models
 * @since 4.1.0
 */
export type SystemMessage = typeof SystemMessage.Type

/**
 * Schema for a tool call made by an assistant message.
 *
 * **Details**
 *
 * `function.arguments` is the JSON text of the call's arguments.
 *
 * @stability experimental
 * @category schemas
 * @since 4.1.0
 */
export const ToolCall = Schema.Struct({
  id: Schema.String,
  type: Schema.Literal("function"),
  function: Schema.Struct({
    name: Schema.String,
    arguments: Schema.String
  }),
  encryptedValue: Schema.optionalKey(Schema.String),
  metadata: Schema.optionalKey(Metadata)
})

/**
 * A tool call made by an assistant message.
 *
 * @stability experimental
 * @category models
 * @since 4.1.0
 */
export type ToolCall = typeof ToolCall.Type

const toolCallTypes: ReadonlySet<string> = new Set(["function"])

/**
 * Schema for a message from the agent.
 *
 * @stability experimental
 * @category schemas
 * @since 4.1.0
 */
export const AssistantMessage = Schema.Struct({
  ...messageFields,
  role: Schema.Literal("assistant"),
  name: Schema.optionalKey(Schema.String),
  encryptedValue: Schema.optionalKey(Schema.String),
  content: Schema.optionalKey(Schema.String),
  toolCalls: Schema.optionalKey(
    withoutUnknownMembers(ToolCall, (value) => hasUnknownTag(value, "type", toolCallTypes))
  )
})

/**
 * A message from the agent.
 *
 * @stability experimental
 * @category models
 * @since 4.1.0
 */
export type AssistantMessage = typeof AssistantMessage.Type

/**
 * Schema for a message from the person using the application.
 *
 * @stability experimental
 * @category schemas
 * @since 4.1.0
 */
export const UserMessage = Schema.Struct({
  ...messageFields,
  role: Schema.Literal("user"),
  name: Schema.optionalKey(Schema.String),
  encryptedValue: Schema.optionalKey(Schema.String),
  content: Content
})

/**
 * A message from the person using the application.
 *
 * @stability experimental
 * @category models
 * @since 4.1.0
 */
export type UserMessage = typeof UserMessage.Type

/**
 * Schema for the result of a tool call, as a message in the conversation.
 *
 * **Details**
 *
 * `error` is present when the tool call failed.
 *
 * @stability experimental
 * @category schemas
 * @since 4.1.0
 */
export const ToolMessage = Schema.Struct({
  ...messageFields,
  role: Schema.Literal("tool"),
  content: Content,
  toolCallId: Schema.String,
  error: Schema.optionalKey(Schema.String),
  encryptedValue: Schema.optionalKey(Schema.String)
})

/**
 * The result of a tool call, as a message in the conversation.
 *
 * @stability experimental
 * @category models
 * @since 4.1.0
 */
export type ToolMessage = typeof ToolMessage.Type

/**
 * Schema for structured progress kept in the conversation as a message.
 *
 * @stability experimental
 * @category schemas
 * @since 4.1.0
 */
export const ActivityMessage = Schema.Struct({
  ...messageFields,
  role: Schema.Literal("activity"),
  activityType: Schema.String,
  content: Schema.Record(Schema.String, Schema.Unknown)
})

/**
 * Structured progress kept in the conversation as a message.
 *
 * @stability experimental
 * @category models
 * @since 4.1.0
 */
export type ActivityMessage = typeof ActivityMessage.Type

/**
 * Schema for a span of the agent's reasoning, kept in the conversation as a
 * message.
 *
 * @stability experimental
 * @category schemas
 * @since 4.1.0
 */
export const ReasoningMessage = Schema.Struct({
  ...messageFields,
  role: Schema.Literal("reasoning"),
  content: Schema.String,
  encryptedValue: Schema.optionalKey(Schema.String)
})

/**
 * A span of the agent's reasoning, kept in the conversation as a message.
 *
 * @stability experimental
 * @category models
 * @since 4.1.0
 */
export type ReasoningMessage = typeof ReasoningMessage.Type

/**
 * Schema for any message in an AG-UI conversation, discriminated by `role`.
 *
 * @stability experimental
 * @category schemas
 * @since 4.1.0
 */
export const Message = Schema.Union([
  DeveloperMessage,
  SystemMessage,
  AssistantMessage,
  UserMessage,
  ToolMessage,
  ActivityMessage,
  ReasoningMessage
])

/**
 * Any message in an AG-UI conversation, discriminated by `role`.
 *
 * @stability experimental
 * @category models
 * @since 4.1.0
 */
export type Message = typeof Message.Type

const messageRoles: ReadonlySet<string> = new Set([
  "developer",
  "system",
  "assistant",
  "user",
  "tool",
  "activity",
  "reasoning"
])

const Messages = withoutUnknownMembers(Message, (value) => hasUnknownTag(value, "role", messageRoles))

// =============================================================================
// Run input
// =============================================================================

/**
 * Schema for a tool the application offers to the agent.
 *
 * **Details**
 *
 * `parameters` is a JSON Schema describing the tool's arguments.
 *
 * @stability experimental
 * @category schemas
 * @since 4.1.0
 */
export const Tool = Schema.Struct({
  name: Schema.String,
  description: Schema.String,
  parameters: Schema.optionalKey(Schema.Unknown),
  metadata: Schema.optionalKey(Metadata)
})

/**
 * A tool the application offers to the agent.
 *
 * @stability experimental
 * @category models
 * @since 4.1.0
 */
export type Tool = typeof Tool.Type

/**
 * Schema for a named piece of ambient information given to the agent for a
 * run.
 *
 * @stability experimental
 * @category schemas
 * @since 4.1.0
 */
export const Context = Schema.Struct({
  description: Schema.String,
  value: Schema.String
})

/**
 * A named piece of ambient information given to the agent for a run.
 *
 * @stability experimental
 * @category models
 * @since 4.1.0
 */
export type Context = typeof Context.Type

/**
 * Schema for an answer to an interrupt, sent on the run that continues from
 * it.
 *
 * @stability experimental
 * @category schemas
 * @since 4.1.0
 */
export const ResumeEntry = Schema.Struct({
  interruptId: Schema.String,
  status: Schema.Literals(["resolved", "cancelled"]),
  payload: Schema.optionalKey(Schema.Unknown),
  metadata: Schema.optionalKey(Metadata)
})

/**
 * An answer to an interrupt, sent on the run that continues from it.
 *
 * @stability experimental
 * @category models
 * @since 4.1.0
 */
export type ResumeEntry = typeof ResumeEntry.Type

const resumeStatuses: ReadonlySet<string> = new Set(["resolved", "cancelled"])

/**
 * Schema for the request body that starts an agent run.
 *
 * **Details**
 *
 * `messages` is the complete conversation so far, which lets an agent serve
 * runs without keeping its own history. Missing `tools` and `context` decode
 * to empty arrays. As AG-UI requires, messages, content parts, tool calls,
 * and resume entries of kinds or statuses this version does not recognise are
 * removed during decoding rather than rejected.
 *
 * **Gotchas**
 *
 * Every field comes from the client. Treat messages, tools, and context as
 * untrusted input.
 *
 * @stability experimental
 * @category schemas
 * @since 4.1.0
 */
export const RunAgentInput = Schema.Struct({
  threadId: Schema.String,
  runId: Schema.String,
  protocolVersion: Schema.optionalKey(Schema.String),
  parentRunId: Schema.optionalKey(Schema.String),
  state: Schema.optionalKey(Schema.Unknown),
  messages: Messages,
  tools: Schema.Array(Tool).pipe(Schema.withDecodingDefaultTypeKey(Effect.succeed([]))),
  context: Schema.Array(Context).pipe(Schema.withDecodingDefaultTypeKey(Effect.succeed([]))),
  forwardedProps: Schema.optionalKey(Schema.Unknown),
  resume: Schema.optionalKey(
    withoutUnknownMembers(ResumeEntry, (value) => hasUnknownTag(value, "status", resumeStatuses))
  )
})

/**
 * The request body that starts an agent run.
 *
 * @stability experimental
 * @category models
 * @since 4.1.0
 */
export type RunAgentInput = typeof RunAgentInput.Type

// =============================================================================
// Text message events
// =============================================================================

/**
 * Schema for the role of a streamed text message.
 *
 * @stability experimental
 * @category schemas
 * @since 4.1.0
 */
export const TextMessageRole = Schema.Literals(["developer", "system", "assistant", "user"])

/**
 * The role of a streamed text message.
 *
 * @stability experimental
 * @category models
 * @since 4.1.0
 */
export type TextMessageRole = typeof TextMessageRole.Type

/**
 * Schema for the event that opens a streamed text message.
 *
 * @stability experimental
 * @category schemas
 * @since 4.1.0
 */
export const TextMessageStartEvent = Schema.Struct({
  type: Schema.Literal("TEXT_MESSAGE_START"),
  ...subagentEventFields,
  messageId: Schema.String,
  role: Schema.optionalKey(TextMessageRole),
  name: Schema.optionalKey(Schema.String)
})

/**
 * Opens a streamed text message.
 *
 * @stability experimental
 * @category models
 * @since 4.1.0
 */
export type TextMessageStartEvent = typeof TextMessageStartEvent.Type

/**
 * Schema for the event that appends a fragment to a streamed text message.
 *
 * @stability experimental
 * @category schemas
 * @since 4.1.0
 */
export const TextMessageContentEvent = Schema.Struct({
  type: Schema.Literal("TEXT_MESSAGE_CONTENT"),
  ...subagentEventFields,
  messageId: Schema.String,
  delta: Schema.String
})

/**
 * Appends a fragment to a streamed text message.
 *
 * @stability experimental
 * @category models
 * @since 4.1.0
 */
export type TextMessageContentEvent = typeof TextMessageContentEvent.Type

/**
 * Schema for the event that closes a streamed text message.
 *
 * @stability experimental
 * @category schemas
 * @since 4.1.0
 */
export const TextMessageEndEvent = Schema.Struct({
  type: Schema.Literal("TEXT_MESSAGE_END"),
  ...subagentEventFields,
  messageId: Schema.String
})

/**
 * Closes a streamed text message.
 *
 * @stability experimental
 * @category models
 * @since 4.1.0
 */
export type TextMessageEndEvent = typeof TextMessageEndEvent.Type

/**
 * Schema for the shorthand event that stands in for a text message's start,
 * content, and end sequence.
 *
 * @stability experimental
 * @category schemas
 * @since 4.1.0
 */
export const TextMessageChunkEvent = Schema.Struct({
  type: Schema.Literal("TEXT_MESSAGE_CHUNK"),
  ...subagentEventFields,
  messageId: Schema.optionalKey(Schema.String),
  role: Schema.optionalKey(TextMessageRole),
  delta: Schema.optionalKey(Schema.String),
  name: Schema.optionalKey(Schema.String)
})

/**
 * Shorthand that stands in for a text message's start, content, and end
 * sequence.
 *
 * @stability experimental
 * @category models
 * @since 4.1.0
 */
export type TextMessageChunkEvent = typeof TextMessageChunkEvent.Type

// =============================================================================
// Tool call events
// =============================================================================

/**
 * Schema for the event that opens a tool call.
 *
 * @stability experimental
 * @category schemas
 * @since 4.1.0
 */
export const ToolCallStartEvent = Schema.Struct({
  type: Schema.Literal("TOOL_CALL_START"),
  ...subagentEventFields,
  toolCallId: Schema.String,
  toolCallName: Schema.String,
  parentMessageId: Schema.optionalKey(Schema.String)
})

/**
 * Opens a tool call.
 *
 * @stability experimental
 * @category models
 * @since 4.1.0
 */
export type ToolCallStartEvent = typeof ToolCallStartEvent.Type

/**
 * Schema for the event that appends a fragment of a tool call's JSON
 * arguments.
 *
 * @stability experimental
 * @category schemas
 * @since 4.1.0
 */
export const ToolCallArgsEvent = Schema.Struct({
  type: Schema.Literal("TOOL_CALL_ARGS"),
  ...subagentEventFields,
  toolCallId: Schema.String,
  delta: Schema.String
})

/**
 * Appends a fragment of a tool call's JSON arguments.
 *
 * @stability experimental
 * @category models
 * @since 4.1.0
 */
export type ToolCallArgsEvent = typeof ToolCallArgsEvent.Type

/**
 * Schema for the event that closes a tool call once its arguments are
 * complete.
 *
 * @stability experimental
 * @category schemas
 * @since 4.1.0
 */
export const ToolCallEndEvent = Schema.Struct({
  type: Schema.Literal("TOOL_CALL_END"),
  ...subagentEventFields,
  toolCallId: Schema.String
})

/**
 * Closes a tool call once its arguments are complete.
 *
 * @stability experimental
 * @category models
 * @since 4.1.0
 */
export type ToolCallEndEvent = typeof ToolCallEndEvent.Type

/**
 * Schema for the shorthand event that stands in for a tool call's start,
 * arguments, and end sequence.
 *
 * @stability experimental
 * @category schemas
 * @since 4.1.0
 */
export const ToolCallChunkEvent = Schema.Struct({
  type: Schema.Literal("TOOL_CALL_CHUNK"),
  ...subagentEventFields,
  toolCallId: Schema.optionalKey(Schema.String),
  toolCallName: Schema.optionalKey(Schema.String),
  parentMessageId: Schema.optionalKey(Schema.String),
  delta: Schema.optionalKey(Schema.String)
})

/**
 * Shorthand that stands in for a tool call's start, arguments, and end
 * sequence.
 *
 * @stability experimental
 * @category models
 * @since 4.1.0
 */
export type ToolCallChunkEvent = typeof ToolCallChunkEvent.Type

/**
 * Schema for the event that delivers the result of a tool call as a new tool
 * message.
 *
 * @stability experimental
 * @category schemas
 * @since 4.1.0
 */
export const ToolCallResultEvent = Schema.Struct({
  type: Schema.Literal("TOOL_CALL_RESULT"),
  ...subagentEventFields,
  messageId: Schema.String,
  toolCallId: Schema.String,
  content: Content,
  role: Schema.optionalKey(Schema.Literal("tool"))
})

/**
 * Delivers the result of a tool call as a new tool message.
 *
 * @stability experimental
 * @category models
 * @since 4.1.0
 */
export type ToolCallResultEvent = typeof ToolCallResultEvent.Type

// =============================================================================
// State and activity events
// =============================================================================

/**
 * Schema for one RFC 6902 JSON Patch operation.
 *
 * @stability experimental
 * @category schemas
 * @since 4.1.0
 */
export const JsonPatchOperation = Schema.Union([
  Schema.Struct({ op: Schema.Literal("add"), path: Schema.String, value: Schema.Unknown }),
  Schema.Struct({ op: Schema.Literal("remove"), path: Schema.String }),
  Schema.Struct({ op: Schema.Literal("replace"), path: Schema.String, value: Schema.Unknown }),
  Schema.Struct({ op: Schema.Literal("move"), from: Schema.String, path: Schema.String }),
  Schema.Struct({ op: Schema.Literal("copy"), from: Schema.String, path: Schema.String }),
  Schema.Struct({ op: Schema.Literal("test"), path: Schema.String, value: Schema.Unknown })
])

/**
 * One RFC 6902 JSON Patch operation.
 *
 * @stability experimental
 * @category models
 * @since 4.1.0
 */
export type JsonPatchOperation = typeof JsonPatchOperation.Type

/**
 * Schema for the event that replaces the agent state.
 *
 * @stability experimental
 * @category schemas
 * @since 4.1.0
 */
export const StateSnapshotEvent = Schema.Struct({
  type: Schema.Literal("STATE_SNAPSHOT"),
  ...subagentEventFields,
  snapshot: Schema.Unknown
})

/**
 * Replaces the agent state.
 *
 * @stability experimental
 * @category models
 * @since 4.1.0
 */
export type StateSnapshotEvent = typeof StateSnapshotEvent.Type

/**
 * Schema for the event that applies a JSON Patch to the agent state.
 *
 * @stability experimental
 * @category schemas
 * @since 4.1.0
 */
export const StateDeltaEvent = Schema.Struct({
  type: Schema.Literal("STATE_DELTA"),
  ...subagentEventFields,
  delta: Schema.Array(JsonPatchOperation)
})

/**
 * Applies a JSON Patch to the agent state.
 *
 * @stability experimental
 * @category models
 * @since 4.1.0
 */
export type StateDeltaEvent = typeof StateDeltaEvent.Type

/**
 * Schema for the event that replaces the conversation the agent owns.
 *
 * @stability experimental
 * @category schemas
 * @since 4.1.0
 */
export const MessagesSnapshotEvent = Schema.Struct({
  type: Schema.Literal("MESSAGES_SNAPSHOT"),
  ...baseEventFields,
  messages: Messages
})

/**
 * Replaces the conversation the agent owns.
 *
 * @stability experimental
 * @category models
 * @since 4.1.0
 */
export type MessagesSnapshotEvent = typeof MessagesSnapshotEvent.Type

/**
 * Schema for the event that sets the content of an activity message.
 *
 * @stability experimental
 * @category schemas
 * @since 4.1.0
 */
export const ActivitySnapshotEvent = Schema.Struct({
  type: Schema.Literal("ACTIVITY_SNAPSHOT"),
  ...subagentEventFields,
  messageId: Schema.String,
  activityType: Schema.String,
  content: Schema.Record(Schema.String, Schema.Unknown),
  replace: Schema.optionalKey(Schema.Boolean)
})

/**
 * Sets the content of an activity message.
 *
 * @stability experimental
 * @category models
 * @since 4.1.0
 */
export type ActivitySnapshotEvent = typeof ActivitySnapshotEvent.Type

/**
 * Schema for the event that applies a JSON Patch to an activity message.
 *
 * @stability experimental
 * @category schemas
 * @since 4.1.0
 */
export const ActivityDeltaEvent = Schema.Struct({
  type: Schema.Literal("ACTIVITY_DELTA"),
  ...subagentEventFields,
  messageId: Schema.String,
  activityType: Schema.String,
  patch: Schema.Array(JsonPatchOperation)
})

/**
 * Applies a JSON Patch to an activity message.
 *
 * @stability experimental
 * @category models
 * @since 4.1.0
 */
export type ActivityDeltaEvent = typeof ActivityDeltaEvent.Type

// =============================================================================
// Special events
// =============================================================================

/**
 * Schema for the event that passes through an event from an external system.
 *
 * @stability experimental
 * @category schemas
 * @since 4.1.0
 */
export const RawEvent = Schema.Struct({
  type: Schema.Literal("RAW"),
  ...subagentEventFields,
  event: Schema.Unknown,
  source: Schema.optionalKey(Schema.String)
})

/**
 * Passes through an event from an external system.
 *
 * @stability experimental
 * @category models
 * @since 4.1.0
 */
export type RawEvent = typeof RawEvent.Type

/**
 * Schema for an application-defined event.
 *
 * @stability experimental
 * @category schemas
 * @since 4.1.0
 */
export const CustomEvent = Schema.Struct({
  type: Schema.Literal("CUSTOM"),
  ...subagentEventFields,
  name: Schema.String,
  value: Schema.Unknown
})

/**
 * An application-defined event.
 *
 * @stability experimental
 * @category models
 * @since 4.1.0
 */
export type CustomEvent = typeof CustomEvent.Type

// =============================================================================
// Lifecycle events
// =============================================================================

/**
 * Schema for the event that opens a run.
 *
 * @stability experimental
 * @category schemas
 * @since 4.1.0
 */
export const RunStartedEvent = Schema.Struct({
  type: Schema.Literal("RUN_STARTED"),
  ...baseEventFields,
  threadId: Schema.String,
  runId: Schema.String,
  protocolVersion: Schema.optionalKey(Schema.String),
  parentRunId: Schema.optionalKey(Schema.String),
  input: Schema.optionalKey(RunAgentInput)
})

/**
 * Opens a run.
 *
 * @stability experimental
 * @category models
 * @since 4.1.0
 */
export type RunStartedEvent = typeof RunStartedEvent.Type

/**
 * Schema for something a run needs from outside before it can continue, such
 * as an approval.
 *
 * @stability experimental
 * @category schemas
 * @since 4.1.0
 */
export const Interrupt = Schema.Struct({
  subagentRunId: Schema.optionalKey(Schema.String),
  id: Schema.String,
  reason: Schema.String,
  message: Schema.optionalKey(Schema.String),
  toolCallId: Schema.optionalKey(Schema.String),
  responseSchema: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
  expiresAt: Schema.optionalKey(Schema.String),
  metadata: Schema.optionalKey(Metadata)
})

/**
 * Something a run needs from outside before it can continue, such as an
 * approval.
 *
 * @stability experimental
 * @category models
 * @since 4.1.0
 */
export type Interrupt = typeof Interrupt.Type

/**
 * Schema for why a run ended.
 *
 * **Details**
 *
 * A `success` outcome may name frontend tool calls the application still has
 * to answer. An `interrupt` outcome pauses the run until a later run resumes
 * it.
 *
 * @stability experimental
 * @category schemas
 * @since 4.1.0
 */
export const RunFinishedOutcome = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("success"),
    pendingToolCallIds: Schema.optionalKey(Schema.Array(Schema.String))
  }),
  Schema.Struct({
    type: Schema.Literal("interrupt"),
    interrupts: Schema.NonEmptyArray(Interrupt)
  }),
  Schema.Struct({
    type: Schema.Literal("cancelled")
  })
])

/**
 * Why a run ended.
 *
 * @stability experimental
 * @category models
 * @since 4.1.0
 */
export type RunFinishedOutcome = typeof RunFinishedOutcome.Type

/**
 * Schema for token counts reported for one provider and model.
 *
 * @stability experimental
 * @category schemas
 * @since 4.1.0
 */
export const TokenUsage = Schema.Struct({
  provider: Schema.optionalKey(Schema.String),
  model: Schema.optionalKey(Schema.String),
  inputTokens: Schema.optionalKey(TokenCount),
  outputTokens: Schema.optionalKey(TokenCount),
  totalTokens: Schema.optionalKey(TokenCount),
  reasoningTokens: Schema.optionalKey(TokenCount),
  cachedInputTokens: Schema.optionalKey(TokenCount),
  cacheWriteInputTokens: Schema.optionalKey(TokenCount)
})

/**
 * Token counts reported for one provider and model.
 *
 * @stability experimental
 * @category models
 * @since 4.1.0
 */
export type TokenUsage = typeof TokenUsage.Type

/**
 * Schema for the event that closes a run that did not fail.
 *
 * @stability experimental
 * @category schemas
 * @since 4.1.0
 */
export const RunFinishedEvent = Schema.Struct({
  type: Schema.Literal("RUN_FINISHED"),
  ...baseEventFields,
  threadId: Schema.String,
  runId: Schema.String,
  result: Schema.optionalKey(Schema.Unknown),
  outcome: Schema.optionalKey(RunFinishedOutcome),
  usage: Schema.optionalKey(Schema.Array(TokenUsage))
})

/**
 * Closes a run that did not fail.
 *
 * @stability experimental
 * @category models
 * @since 4.1.0
 */
export type RunFinishedEvent = typeof RunFinishedEvent.Type

/**
 * Schema for the event that ends a run that failed.
 *
 * @stability experimental
 * @category schemas
 * @since 4.1.0
 */
export const RunErrorEvent = Schema.Struct({
  type: Schema.Literal("RUN_ERROR"),
  ...baseEventFields,
  message: Schema.String,
  code: Schema.optionalKey(Schema.String),
  usage: Schema.optionalKey(Schema.Array(TokenUsage))
})

/**
 * Ends a run that failed.
 *
 * @stability experimental
 * @category models
 * @since 4.1.0
 */
export type RunErrorEvent = typeof RunErrorEvent.Type

/**
 * Schema for the event that opens a named step within a run.
 *
 * @stability experimental
 * @category schemas
 * @since 4.1.0
 */
export const StepStartedEvent = Schema.Struct({
  type: Schema.Literal("STEP_STARTED"),
  ...subagentEventFields,
  stepName: Schema.String
})

/**
 * Opens a named step within a run.
 *
 * @stability experimental
 * @category models
 * @since 4.1.0
 */
export type StepStartedEvent = typeof StepStartedEvent.Type

/**
 * Schema for the event that closes a named step.
 *
 * @stability experimental
 * @category schemas
 * @since 4.1.0
 */
export const StepFinishedEvent = Schema.Struct({
  type: Schema.Literal("STEP_FINISHED"),
  ...subagentEventFields,
  stepName: Schema.String
})

/**
 * Closes a named step.
 *
 * @stability experimental
 * @category models
 * @since 4.1.0
 */
export type StepFinishedEvent = typeof StepFinishedEvent.Type

// =============================================================================
// Reasoning events
// =============================================================================

/**
 * Schema for the event that opens a span of reasoning.
 *
 * @stability experimental
 * @category schemas
 * @since 4.1.0
 */
export const ReasoningStartEvent = Schema.Struct({
  type: Schema.Literal("REASONING_START"),
  ...subagentEventFields,
  messageId: Schema.String
})

/**
 * Opens a span of reasoning.
 *
 * @stability experimental
 * @category models
 * @since 4.1.0
 */
export type ReasoningStartEvent = typeof ReasoningStartEvent.Type

/**
 * Schema for the event that opens a streamed reasoning message.
 *
 * @stability experimental
 * @category schemas
 * @since 4.1.0
 */
export const ReasoningMessageStartEvent = Schema.Struct({
  type: Schema.Literal("REASONING_MESSAGE_START"),
  ...subagentEventFields,
  messageId: Schema.String,
  role: Schema.Literal("reasoning")
})

/**
 * Opens a streamed reasoning message.
 *
 * @stability experimental
 * @category models
 * @since 4.1.0
 */
export type ReasoningMessageStartEvent = typeof ReasoningMessageStartEvent.Type

/**
 * Schema for the event that appends a fragment to a streamed reasoning
 * message.
 *
 * @stability experimental
 * @category schemas
 * @since 4.1.0
 */
export const ReasoningMessageContentEvent = Schema.Struct({
  type: Schema.Literal("REASONING_MESSAGE_CONTENT"),
  ...subagentEventFields,
  messageId: Schema.String,
  delta: Schema.String
})

/**
 * Appends a fragment to a streamed reasoning message.
 *
 * @stability experimental
 * @category models
 * @since 4.1.0
 */
export type ReasoningMessageContentEvent = typeof ReasoningMessageContentEvent.Type

/**
 * Schema for the event that closes a streamed reasoning message.
 *
 * @stability experimental
 * @category schemas
 * @since 4.1.0
 */
export const ReasoningMessageEndEvent = Schema.Struct({
  type: Schema.Literal("REASONING_MESSAGE_END"),
  ...subagentEventFields,
  messageId: Schema.String
})

/**
 * Closes a streamed reasoning message.
 *
 * @stability experimental
 * @category models
 * @since 4.1.0
 */
export type ReasoningMessageEndEvent = typeof ReasoningMessageEndEvent.Type

/**
 * Schema for the shorthand event that stands in for a reasoning message's
 * start, content, and end sequence.
 *
 * @stability experimental
 * @category schemas
 * @since 4.1.0
 */
export const ReasoningMessageChunkEvent = Schema.Struct({
  type: Schema.Literal("REASONING_MESSAGE_CHUNK"),
  ...subagentEventFields,
  messageId: Schema.optionalKey(Schema.String),
  delta: Schema.optionalKey(Schema.String)
})

/**
 * Shorthand that stands in for a reasoning message's start, content, and end
 * sequence.
 *
 * @stability experimental
 * @category models
 * @since 4.1.0
 */
export type ReasoningMessageChunkEvent = typeof ReasoningMessageChunkEvent.Type

/**
 * Schema for the event that closes a span of reasoning.
 *
 * @stability experimental
 * @category schemas
 * @since 4.1.0
 */
export const ReasoningEndEvent = Schema.Struct({
  type: Schema.Literal("REASONING_END"),
  ...subagentEventFields,
  messageId: Schema.String
})

/**
 * Closes a span of reasoning.
 *
 * @stability experimental
 * @category models
 * @since 4.1.0
 */
export type ReasoningEndEvent = typeof ReasoningEndEvent.Type

/**
 * Schema for the event that attaches provider-encrypted reasoning to a message
 * or tool call.
 *
 * @stability experimental
 * @category schemas
 * @since 4.1.0
 */
export const ReasoningEncryptedValueEvent = Schema.Struct({
  type: Schema.Literal("REASONING_ENCRYPTED_VALUE"),
  ...subagentEventFields,
  subtype: Schema.Literals(["tool-call", "message"]),
  entityId: Schema.String,
  encryptedValue: Schema.String
})

/**
 * Attaches provider-encrypted reasoning to a message or tool call.
 *
 * @stability experimental
 * @category models
 * @since 4.1.0
 */
export type ReasoningEncryptedValueEvent = typeof ReasoningEncryptedValueEvent.Type

// =============================================================================
// Subagent events
// =============================================================================

/**
 * Schema for the event that opens a subagent invocation within a run.
 *
 * @stability experimental
 * @category schemas
 * @since 4.1.0
 */
export const SubagentStartedEvent = Schema.Struct({
  type: Schema.Literal("SUBAGENT_STARTED"),
  ...baseEventFields,
  subagentRunId: Schema.String,
  name: Schema.String,
  description: Schema.optionalKey(Schema.String),
  parentSubagentRunId: Schema.optionalKey(Schema.String),
  parentToolCallId: Schema.optionalKey(Schema.String),
  parentMessageId: Schema.optionalKey(Schema.String)
})

/**
 * Opens a subagent invocation within a run.
 *
 * @stability experimental
 * @category models
 * @since 4.1.0
 */
export type SubagentStartedEvent = typeof SubagentStartedEvent.Type

/**
 * Schema for the event that closes a subagent invocation that did not fail.
 *
 * @stability experimental
 * @category schemas
 * @since 4.1.0
 */
export const SubagentFinishedEvent = Schema.Struct({
  type: Schema.Literal("SUBAGENT_FINISHED"),
  ...baseEventFields,
  subagentRunId: Schema.String,
  result: Schema.optionalKey(Schema.Unknown),
  outcome: Schema.optionalKey(Schema.Union([
    Schema.Struct({ type: Schema.Literal("success") }),
    Schema.Struct({
      type: Schema.Literal("suspended"),
      interruptIds: Schema.optionalKey(Schema.Array(Schema.String))
    })
  ]))
})

/**
 * Closes a subagent invocation that did not fail.
 *
 * @stability experimental
 * @category models
 * @since 4.1.0
 */
export type SubagentFinishedEvent = typeof SubagentFinishedEvent.Type

/**
 * Schema for the event that reports a failed subagent invocation without
 * ending the run.
 *
 * @stability experimental
 * @category schemas
 * @since 4.1.0
 */
export const SubagentErrorEvent = Schema.Struct({
  type: Schema.Literal("SUBAGENT_ERROR"),
  ...baseEventFields,
  subagentRunId: Schema.String,
  message: Schema.String,
  code: Schema.optionalKey(Schema.String)
})

/**
 * Reports a failed subagent invocation without ending the run.
 *
 * @stability experimental
 * @category models
 * @since 4.1.0
 */
export type SubagentErrorEvent = typeof SubagentErrorEvent.Type

// =============================================================================
// Events
// =============================================================================

/**
 * Schema for any AG-UI event, discriminated by `type`.
 *
 * @stability experimental
 * @category schemas
 * @since 4.1.0
 */
export const Event = Schema.Union([
  TextMessageStartEvent,
  TextMessageContentEvent,
  TextMessageEndEvent,
  TextMessageChunkEvent,
  ToolCallStartEvent,
  ToolCallArgsEvent,
  ToolCallEndEvent,
  ToolCallChunkEvent,
  ToolCallResultEvent,
  StateSnapshotEvent,
  StateDeltaEvent,
  MessagesSnapshotEvent,
  ActivitySnapshotEvent,
  ActivityDeltaEvent,
  RawEvent,
  CustomEvent,
  RunStartedEvent,
  RunFinishedEvent,
  RunErrorEvent,
  StepStartedEvent,
  StepFinishedEvent,
  ReasoningStartEvent,
  ReasoningMessageStartEvent,
  ReasoningMessageContentEvent,
  ReasoningMessageEndEvent,
  ReasoningMessageChunkEvent,
  ReasoningEndEvent,
  ReasoningEncryptedValueEvent,
  SubagentStartedEvent,
  SubagentFinishedEvent,
  SubagentErrorEvent
])

/**
 * Any AG-UI event, discriminated by `type`.
 *
 * @stability experimental
 * @category models
 * @since 4.1.0
 */
export type Event = typeof Event.Type
