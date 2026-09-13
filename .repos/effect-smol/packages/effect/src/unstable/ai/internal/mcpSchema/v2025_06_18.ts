/**
 * Exact MCP v2025-06-18 wire schemas.
 *
 * This module is independent of the public compatibility-oriented McpSchema
 * surface and is frozen as a dated delta from v2025-03-26.
 *
 * @internal
 */
import * as Schema from "../../../../Schema.ts"
import * as Rpc from "../../../rpc/Rpc.ts"
import * as RpcGroup from "../../../rpc/RpcGroup.ts"
import * as Previous from "./v2025_03_26.ts"

export * from "./v2025_03_26.ts"

export const protocolVersion = "2025-06-18"

const optional = Previous.optional
const JsonObject = Schema.JsonObject
const Meta = optional(JsonObject)

export const Implementation = Schema.Struct({
  name: Schema.String,
  title: optional(Schema.String),
  version: Schema.String
})

export const ClientCapabilities = Schema.Struct({
  ...Previous.ClientCapabilities.fields,
  elicitation: optional(Schema.Struct({}))
})

export const Annotations = Schema.Struct({
  audience: optional(Schema.Array(Previous.Role)),
  priority: optional(Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 1 })))
})

export const Resource = Schema.Struct({
  ...Previous.Resource.fields,
  title: optional(Schema.String),
  annotations: optional(Annotations),
  _meta: Meta
})

export const ResourceTemplate = Schema.Struct({
  ...Previous.ResourceTemplate.fields,
  title: optional(Schema.String),
  annotations: optional(Annotations),
  _meta: Meta
})

export const TextResourceContents = Schema.Struct({
  ...Previous.TextResourceContents.fields,
  _meta: Meta
})

export const BlobResourceContents = Schema.Struct({
  ...Previous.BlobResourceContents.fields,
  _meta: Meta
})

export const ResourceContents = Schema.Union([TextResourceContents, BlobResourceContents])

export const PromptArgument = Schema.Struct({
  ...Previous.PromptArgument.fields,
  title: optional(Schema.String)
})

export const Prompt = Schema.Struct({
  ...Previous.Prompt.fields,
  title: optional(Schema.String),
  arguments: optional(Schema.Array(PromptArgument)),
  _meta: Meta
})

export const EmbeddedResource = Schema.Struct({
  type: Schema.Literal("resource"),
  resource: ResourceContents,
  annotations: optional(Annotations),
  _meta: Meta
})

export const ResourceLink = Schema.Struct({
  ...Resource.fields,
  type: Schema.Literal("resource_link")
})

export const TextContent = Schema.Struct({
  ...Previous.TextContent.fields,
  annotations: optional(Annotations),
  _meta: Meta
})

export const ImageContent = Schema.Struct({
  ...Previous.ImageContent.fields,
  annotations: optional(Annotations),
  _meta: Meta
})

export const AudioContent = Schema.Struct({
  ...Previous.AudioContent.fields,
  annotations: optional(Annotations),
  _meta: Meta
})

export const ContentBlock = Schema.Union([
  TextContent,
  ImageContent,
  AudioContent,
  EmbeddedResource,
  ResourceLink
])

export const SamplingContent = Schema.Union([TextContent, ImageContent, AudioContent])

export const PromptMessage = Schema.Struct({
  role: Previous.Role,
  content: ContentBlock
})

export const SamplingMessage = Schema.Struct({
  role: Previous.Role,
  content: SamplingContent
})

export const ServerCapabilities = Schema.Struct({
  ...Previous.ServerCapabilities.fields
})

export const InitializeResult = Schema.Struct({
  ...Previous.ResultMeta.fields,
  protocolVersion: Schema.String,
  capabilities: ServerCapabilities,
  serverInfo: Implementation,
  instructions: optional(Schema.String)
})

export class Initialize extends Rpc.make("initialize", {
  success: InitializeResult,
  error: Previous.McpError,
  payload: {
    ...Previous.RequestMeta.fields,
    protocolVersion: Schema.String,
    capabilities: ClientCapabilities,
    clientInfo: Implementation
  }
}) {}

const ToolJsonSchema = Schema.StructWithRest(
  Schema.Struct({
    type: Schema.Literal("object"),
    properties: optional(Schema.Record(Schema.String, JsonObject)),
    required: optional(Schema.Array(Schema.String))
  }),
  [Schema.JsonObject]
)

export const Tool = Schema.Struct({
  name: Schema.String,
  title: optional(Schema.String),
  description: optional(Schema.String),
  inputSchema: ToolJsonSchema,
  outputSchema: optional(ToolJsonSchema),
  annotations: optional(Previous.ToolAnnotations),
  _meta: Meta
})

export const CallToolResult = Schema.Struct({
  ...Previous.ResultMeta.fields,
  content: Schema.Array(ContentBlock),
  structuredContent: optional(JsonObject),
  isError: optional(Schema.Boolean)
})

export const CreateMessageResult = Schema.Struct({
  ...Previous.ResultMeta.fields,
  role: Previous.Role,
  content: SamplingContent,
  model: Schema.String,
  stopReason: optional(Schema.String)
})

export class CreateMessage extends Rpc.make("sampling/createMessage", {
  success: CreateMessageResult,
  error: Previous.McpError,
  payload: {
    ...Previous.RequestMeta.fields,
    messages: Schema.Array(SamplingMessage),
    modelPreferences: optional(Previous.ModelPreferences),
    systemPrompt: optional(Schema.String),
    includeContext: optional(Schema.Literals(["none", "thisServer", "allServers"])),
    temperature: optional(Schema.Finite),
    maxTokens: Schema.Finite,
    stopSequences: optional(Schema.Array(Schema.String)),
    metadata: optional(JsonObject)
  }
}) {}

export const PromptReference = Schema.Struct({
  ...Previous.PromptReference.fields,
  title: optional(Schema.String)
})

export const ResourceTemplateReference = Schema.Struct({
  type: Schema.Literal("ref/resource"),
  uri: Schema.String
})

export const CompleteResult = Previous.CompleteResult

export class Complete extends Rpc.make("completion/complete", {
  success: CompleteResult,
  error: Previous.McpError,
  payload: {
    ...Previous.RequestMeta.fields,
    ref: Schema.Union([PromptReference, ResourceTemplateReference]),
    argument: Schema.Struct({
      name: Schema.String,
      value: Schema.String
    }),
    context: optional(Schema.Struct({
      arguments: optional(Schema.Record(Schema.String, Schema.String))
    }))
  }
}) {}

export const ListResourcesResult = Schema.Struct({
  ...Previous.PaginatedResult.fields,
  resources: Schema.Array(Resource)
})

export const ListResourceTemplatesResult = Schema.Struct({
  ...Previous.PaginatedResult.fields,
  resourceTemplates: Schema.Array(ResourceTemplate)
})

export const ReadResourceResult = Schema.Struct({
  ...Previous.ResultMeta.fields,
  contents: Schema.Array(ResourceContents)
})

export const ListPromptsResult = Schema.Struct({
  ...Previous.PaginatedResult.fields,
  prompts: Schema.Array(Prompt)
})

export const GetPromptResult = Schema.Struct({
  ...Previous.ResultMeta.fields,
  description: optional(Schema.String),
  messages: Schema.Array(PromptMessage)
})

export const ListToolsResult = Schema.Struct({
  ...Previous.PaginatedResult.fields,
  tools: Schema.Array(Tool)
})

export class ListResources extends Rpc.make("resources/list", {
  success: ListResourcesResult,
  error: Previous.McpError,
  payload: Schema.UndefinedOr(Previous.PaginatedRequest)
}) {}

export class ListResourceTemplates extends Rpc.make("resources/templates/list", {
  success: ListResourceTemplatesResult,
  error: Previous.McpError,
  payload: Schema.UndefinedOr(Previous.PaginatedRequest)
}) {}

export class ReadResource extends Rpc.make("resources/read", {
  success: ReadResourceResult,
  error: Previous.McpError,
  payload: { ...Previous.RequestMeta.fields, uri: Schema.String }
}) {}

export class ListPrompts extends Rpc.make("prompts/list", {
  success: ListPromptsResult,
  error: Previous.McpError,
  payload: Schema.UndefinedOr(Previous.PaginatedRequest)
}) {}

export class GetPrompt extends Rpc.make("prompts/get", {
  success: GetPromptResult,
  error: Previous.McpError,
  payload: {
    ...Previous.RequestMeta.fields,
    name: Schema.String,
    arguments: optional(Schema.Record(Schema.String, Schema.String))
  }
}) {}

export class ListTools extends Rpc.make("tools/list", {
  success: ListToolsResult,
  error: Previous.McpError,
  payload: Schema.UndefinedOr(Previous.PaginatedRequest)
}) {}

export class CallTool extends Rpc.make("tools/call", {
  success: CallToolResult,
  error: Previous.McpError,
  payload: {
    ...Previous.RequestMeta.fields,
    name: Schema.String,
    arguments: optional(JsonObject)
  }
}) {}

export const ElicitResult = Schema.Struct({
  ...Previous.ResultMeta.fields,
  action: Schema.Literals(["accept", "decline", "cancel"]),
  content: optional(Schema.Record(
    Schema.String,
    Schema.Union([Schema.String, Schema.Finite, Schema.Boolean])
  ))
})

const StringSchema = Schema.Struct({
  type: Schema.Literal("string"),
  title: optional(Schema.String),
  description: optional(Schema.String),
  minLength: optional(Schema.Int),
  maxLength: optional(Schema.Int),
  format: optional(Schema.Literals(["email", "uri", "date", "date-time"]))
})
const NumberSchema = Schema.Struct({
  type: Schema.Literals(["number", "integer"]),
  title: optional(Schema.String),
  description: optional(Schema.String),
  minimum: optional(Schema.Finite),
  maximum: optional(Schema.Finite)
})
const BooleanSchema = Schema.Struct({
  type: Schema.Literal("boolean"),
  title: optional(Schema.String),
  description: optional(Schema.String),
  default: optional(Schema.Boolean)
})
const EnumSchema = Schema.Struct({
  type: Schema.Literal("string"),
  title: optional(Schema.String),
  description: optional(Schema.String),
  enum: Schema.Array(Schema.String),
  enumNames: optional(Schema.Array(Schema.String))
})
const RequestedSchema = Schema.Struct({
  type: Schema.Literal("object"),
  properties: Schema.Record(
    Schema.String,
    Schema.Union([StringSchema, NumberSchema, BooleanSchema, EnumSchema])
  ),
  required: optional(Schema.Array(Schema.String))
})

export class Elicit extends Rpc.make("elicitation/create", {
  success: ElicitResult,
  error: Previous.McpError,
  payload: {
    ...Previous.RequestMeta.fields,
    message: Schema.String,
    requestedSchema: RequestedSchema
  }
}) {}

export class ClientRequestRpcs extends RpcGroup.make(
  Previous.Ping,
  Initialize,
  Complete,
  Previous.SetLevel,
  GetPrompt,
  ListPrompts,
  ListResources,
  ListResourceTemplates,
  ReadResource,
  Previous.Subscribe,
  Previous.Unsubscribe,
  CallTool,
  ListTools
) {}

export class ClientNotificationRpcs extends RpcGroup.make(
  Previous.CancelledNotification,
  Previous.ProgressNotification,
  Previous.InitializedNotification,
  Previous.RootsListChangedNotification
) {}

export class ClientRpcs extends ClientRequestRpcs.merge(ClientNotificationRpcs) {}

export class ServerRequestRpcs extends RpcGroup.make(
  Previous.Ping,
  CreateMessage,
  Previous.ListRoots,
  Elicit
) {}

export class ServerNotificationRpcs extends RpcGroup.make(
  Previous.CancelledNotification,
  Previous.ProgressNotification,
  Previous.LoggingMessageNotification,
  Previous.ResourceUpdatedNotification,
  Previous.ResourceListChangedNotification,
  Previous.ToolListChangedNotification,
  Previous.PromptListChangedNotification
) {}
