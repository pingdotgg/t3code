/**
 * Exact MCP v2024-11-05 wire schemas.
 *
 * Transport topology is intentionally not represented here. This module owns
 * the dated JSON-RPC method payloads and results only.
 *
 * @internal
 */
import * as Option from "../../../../Option.ts"
import * as Schema from "../../../../Schema.ts"
import * as SchemaGetter from "../../../../SchemaGetter.ts"
import * as Rpc from "../../../rpc/Rpc.ts"
import * as RpcGroup from "../../../rpc/RpcGroup.ts"

export const protocolVersion = "2024-11-05"

export const optional = <S extends Schema.Constraint>(
  schema: S
): Schema.decodeTo<Schema.optional<S>, Schema.optionalKey<S>> =>
  Schema.optionalKey(schema).pipe(
    Schema.decodeTo(Schema.optional(schema), {
      decode: SchemaGetter.passthrough(),
      encode: SchemaGetter.transformOptional(Option.flatMap(Option.fromUndefinedOr))
    })
  )
const JsonObject = Schema.JsonObject

export const RequestId = Schema.Union([Schema.String, Schema.Finite])
export const ProgressToken = Schema.Union([Schema.String, Schema.Finite])
export const Role = Schema.Literals(["user", "assistant"])
export const LoggingLevel = Schema.Literals([
  "debug",
  "info",
  "notice",
  "warning",
  "error",
  "critical",
  "alert",
  "emergency"
])

export const RequestMeta = Schema.Struct({
  _meta: optional(Schema.Struct({
    progressToken: optional(ProgressToken)
  }))
})

export const NotificationMeta = Schema.Struct({
  _meta: optional(JsonObject)
})

export const ResultMeta = Schema.Struct({
  _meta: optional(JsonObject)
})

export const PaginatedRequest = Schema.Struct({
  ...RequestMeta.fields,
  cursor: optional(Schema.String)
})

export const PaginatedResult = Schema.Struct({
  ...ResultMeta.fields,
  nextCursor: optional(Schema.String)
})

export const Implementation = Schema.Struct({
  name: Schema.String,
  version: Schema.String
})

export const ClientCapabilities = Schema.Struct({
  experimental: optional(Schema.Record(Schema.String, JsonObject)),
  roots: optional(Schema.Struct({
    listChanged: optional(Schema.Boolean)
  })),
  sampling: optional(JsonObject)
})

export const ServerCapabilities = Schema.Struct({
  experimental: optional(Schema.Record(Schema.String, JsonObject)),
  logging: optional(JsonObject),
  prompts: optional(Schema.Struct({
    listChanged: optional(Schema.Boolean)
  })),
  resources: optional(Schema.Struct({
    subscribe: optional(Schema.Boolean),
    listChanged: optional(Schema.Boolean)
  })),
  tools: optional(Schema.Struct({
    listChanged: optional(Schema.Boolean)
  }))
})

export const McpError = Schema.Struct({
  code: Schema.Int,
  message: Schema.String,
  data: optional(Schema.Any)
})
export type McpError = typeof McpError.Type

export const Annotation = Schema.Struct({
  audience: optional(Schema.Array(Role)),
  priority: optional(Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 1 })))
})

export const TextResourceContents = Schema.Struct({
  uri: Schema.String,
  mimeType: optional(Schema.String),
  text: Schema.String
})

export const BlobResourceContents = Schema.Struct({
  uri: Schema.String,
  mimeType: optional(Schema.String),
  blob: Schema.String
})

export const ResourceContents = Schema.Union([
  TextResourceContents,
  BlobResourceContents
])

export const TextContent = Schema.Struct({
  type: Schema.Literal("text"),
  text: Schema.String,
  annotations: optional(Annotation)
})

export const ImageContent = Schema.Struct({
  type: Schema.Literal("image"),
  data: Schema.String,
  mimeType: Schema.String,
  annotations: optional(Annotation)
})

export const EmbeddedResource = Schema.Struct({
  type: Schema.Literal("resource"),
  resource: ResourceContents,
  annotations: optional(Annotation)
})

export const PromptOrToolContent = Schema.Union([
  TextContent,
  ImageContent,
  EmbeddedResource
])

export const SamplingContent = Schema.Union([
  TextContent,
  ImageContent
])

export const Resource = Schema.Struct({
  uri: Schema.String,
  name: Schema.String,
  description: optional(Schema.String),
  mimeType: optional(Schema.String),
  size: optional(Schema.Finite),
  annotations: optional(Annotation)
})

export const ResourceTemplate = Schema.Struct({
  uriTemplate: Schema.String,
  name: Schema.String,
  description: optional(Schema.String),
  mimeType: optional(Schema.String),
  annotations: optional(Annotation)
})

export const PromptArgument = Schema.Struct({
  name: Schema.String,
  description: optional(Schema.String),
  required: optional(Schema.Boolean)
})

export const Prompt = Schema.Struct({
  name: Schema.String,
  description: optional(Schema.String),
  arguments: optional(Schema.Array(PromptArgument))
})

export const PromptMessage = Schema.Struct({
  role: Role,
  content: PromptOrToolContent
})

export const ToolInputSchema = Schema.Struct({
  type: Schema.Literal("object"),
  properties: optional(Schema.Record(Schema.String, JsonObject)),
  required: optional(Schema.Array(Schema.String))
})

export const Tool = Schema.Struct({
  name: Schema.String,
  description: optional(Schema.String),
  inputSchema: ToolInputSchema
})

export const ModelHint = Schema.Struct({
  name: optional(Schema.String)
})

export const ModelPreferences = Schema.Struct({
  hints: optional(Schema.Array(ModelHint)),
  costPriority: optional(Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 1 }))),
  speedPriority: optional(Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 1 }))),
  intelligencePriority: optional(Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 1 })))
})

export const SamplingMessage = Schema.Struct({
  role: Role,
  content: SamplingContent
})

export const ResourceReference = Schema.Struct({
  type: Schema.Literal("ref/resource"),
  uri: Schema.String
})

export const PromptReference = Schema.Struct({
  type: Schema.Literal("ref/prompt"),
  name: Schema.String
})

export const Root = Schema.Struct({
  uri: Schema.String,
  name: optional(Schema.String)
})

export const InitializeResult = Schema.Struct({
  ...ResultMeta.fields,
  protocolVersion: Schema.String,
  capabilities: ServerCapabilities,
  serverInfo: Implementation,
  instructions: optional(Schema.String)
})

export const ListResourcesResult = Schema.Struct({
  ...PaginatedResult.fields,
  resources: Schema.Array(Resource)
})

export const ListResourceTemplatesResult = Schema.Struct({
  ...PaginatedResult.fields,
  resourceTemplates: Schema.Array(ResourceTemplate)
})

export const ReadResourceResult = Schema.Struct({
  ...ResultMeta.fields,
  contents: Schema.Array(ResourceContents)
})

export const ListPromptsResult = Schema.Struct({
  ...PaginatedResult.fields,
  prompts: Schema.Array(Prompt)
})

export const GetPromptResult = Schema.Struct({
  ...ResultMeta.fields,
  description: optional(Schema.String),
  messages: Schema.Array(PromptMessage)
})

export const ListToolsResult = Schema.Struct({
  ...PaginatedResult.fields,
  tools: Schema.Array(Tool)
})

export const CallToolResult = Schema.Struct({
  ...ResultMeta.fields,
  content: Schema.Array(PromptOrToolContent),
  isError: optional(Schema.Boolean)
})

export const CreateMessageResult = Schema.Struct({
  ...ResultMeta.fields,
  role: Role,
  content: SamplingContent,
  model: Schema.String,
  stopReason: optional(Schema.String)
})

export const CompleteResult = Schema.Struct({
  ...ResultMeta.fields,
  completion: Schema.Struct({
    values: Schema.Array(Schema.String),
    total: optional(Schema.Finite),
    hasMore: optional(Schema.Boolean)
  })
})

export const ListRootsResult = Schema.Struct({
  ...ResultMeta.fields,
  roots: Schema.Array(Root)
})

export class Ping extends Rpc.make("ping", {
  success: ResultMeta,
  error: McpError,
  payload: Schema.UndefinedOr(RequestMeta)
}) {}

export class Initialize extends Rpc.make("initialize", {
  success: InitializeResult,
  error: McpError,
  payload: {
    ...RequestMeta.fields,
    protocolVersion: Schema.String,
    capabilities: ClientCapabilities,
    clientInfo: Implementation
  }
}) {}

export class Complete extends Rpc.make("completion/complete", {
  success: CompleteResult,
  error: McpError,
  payload: {
    ...RequestMeta.fields,
    ref: Schema.Union([PromptReference, ResourceReference]),
    argument: Schema.Struct({
      name: Schema.String,
      value: Schema.String
    })
  }
}) {}

export class SetLevel extends Rpc.make("logging/setLevel", {
  success: ResultMeta,
  error: McpError,
  payload: {
    ...RequestMeta.fields,
    level: LoggingLevel
  }
}) {}

export class GetPrompt extends Rpc.make("prompts/get", {
  success: GetPromptResult,
  error: McpError,
  payload: {
    ...RequestMeta.fields,
    name: Schema.String,
    arguments: optional(Schema.Record(Schema.String, Schema.String))
  }
}) {}

export class ListPrompts extends Rpc.make("prompts/list", {
  success: ListPromptsResult,
  error: McpError,
  payload: Schema.UndefinedOr(PaginatedRequest)
}) {}

export class ListResources extends Rpc.make("resources/list", {
  success: ListResourcesResult,
  error: McpError,
  payload: Schema.UndefinedOr(PaginatedRequest)
}) {}

export class ListResourceTemplates extends Rpc.make("resources/templates/list", {
  success: ListResourceTemplatesResult,
  error: McpError,
  payload: Schema.UndefinedOr(PaginatedRequest)
}) {}

export class ReadResource extends Rpc.make("resources/read", {
  success: ReadResourceResult,
  error: McpError,
  payload: {
    ...RequestMeta.fields,
    uri: Schema.String
  }
}) {}

export class Subscribe extends Rpc.make("resources/subscribe", {
  success: ResultMeta,
  error: McpError,
  payload: {
    ...RequestMeta.fields,
    uri: Schema.String
  }
}) {}

export class Unsubscribe extends Rpc.make("resources/unsubscribe", {
  success: ResultMeta,
  error: McpError,
  payload: {
    ...RequestMeta.fields,
    uri: Schema.String
  }
}) {}

export class CallTool extends Rpc.make("tools/call", {
  success: CallToolResult,
  error: McpError,
  payload: {
    ...RequestMeta.fields,
    name: Schema.String,
    arguments: optional(JsonObject)
  }
}) {}

export class ListTools extends Rpc.make("tools/list", {
  success: ListToolsResult,
  error: McpError,
  payload: Schema.UndefinedOr(PaginatedRequest)
}) {}

export class CreateMessage extends Rpc.make("sampling/createMessage", {
  success: CreateMessageResult,
  error: McpError,
  payload: {
    ...RequestMeta.fields,
    messages: Schema.Array(SamplingMessage),
    modelPreferences: optional(ModelPreferences),
    systemPrompt: optional(Schema.String),
    includeContext: optional(Schema.Literals(["none", "thisServer", "allServers"])),
    temperature: optional(Schema.Finite),
    maxTokens: Schema.Finite,
    stopSequences: optional(Schema.Array(Schema.String)),
    metadata: optional(JsonObject)
  }
}) {}

export class ListRoots extends Rpc.make("roots/list", {
  success: ListRootsResult,
  error: McpError,
  payload: Schema.UndefinedOr(RequestMeta)
}) {}

export class CancelledNotification extends Rpc.make("notifications/cancelled", {
  payload: {
    ...NotificationMeta.fields,
    requestId: RequestId,
    reason: optional(Schema.String)
  }
}) {}

export class ProgressNotification extends Rpc.make("notifications/progress", {
  payload: {
    ...NotificationMeta.fields,
    progressToken: ProgressToken,
    progress: Schema.Finite,
    total: optional(Schema.Finite)
  }
}) {}

export class InitializedNotification extends Rpc.make("notifications/initialized", {
  payload: Schema.UndefinedOr(NotificationMeta)
}) {}

export class RootsListChangedNotification extends Rpc.make("notifications/roots/list_changed", {
  payload: Schema.UndefinedOr(NotificationMeta)
}) {}

export class LoggingMessageNotification extends Rpc.make("notifications/message", {
  payload: {
    ...NotificationMeta.fields,
    level: LoggingLevel,
    logger: optional(Schema.String),
    data: Schema.Any
  }
}) {}

export class ResourceUpdatedNotification extends Rpc.make("notifications/resources/updated", {
  payload: {
    ...NotificationMeta.fields,
    uri: Schema.String
  }
}) {}

export class ResourceListChangedNotification extends Rpc.make("notifications/resources/list_changed", {
  payload: Schema.UndefinedOr(NotificationMeta)
}) {}

export class ToolListChangedNotification extends Rpc.make("notifications/tools/list_changed", {
  payload: Schema.UndefinedOr(NotificationMeta)
}) {}

export class PromptListChangedNotification extends Rpc.make("notifications/prompts/list_changed", {
  payload: Schema.UndefinedOr(NotificationMeta)
}) {}

export class ClientRequestRpcs extends RpcGroup.make(
  Ping,
  Initialize,
  Complete,
  SetLevel,
  GetPrompt,
  ListPrompts,
  ListResources,
  ListResourceTemplates,
  ReadResource,
  Subscribe,
  Unsubscribe,
  CallTool,
  ListTools
) {}

export class ClientNotificationRpcs extends RpcGroup.make(
  CancelledNotification,
  ProgressNotification,
  InitializedNotification,
  RootsListChangedNotification
) {}

export class ClientRpcs extends ClientRequestRpcs.merge(ClientNotificationRpcs) {}

export class ServerRequestRpcs extends RpcGroup.make(
  Ping,
  CreateMessage,
  ListRoots
) {}

export class ServerNotificationRpcs extends RpcGroup.make(
  CancelledNotification,
  ProgressNotification,
  LoggingMessageNotification,
  ResourceUpdatedNotification,
  ResourceListChangedNotification,
  ToolListChangedNotification,
  PromptListChangedNotification
) {}
