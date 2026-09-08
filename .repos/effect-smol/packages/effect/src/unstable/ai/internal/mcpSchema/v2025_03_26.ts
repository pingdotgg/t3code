/**
 * Exact MCP v2025-03-26 wire schemas.
 *
 * This revision is expressed as a frozen delta from the exact 2024-11-05
 * schemas. Transport envelopes (including JSON-RPC batches) are owned by the
 * transport codec rather than Effect RPC payload schemas.
 *
 * @internal
 */
import * as Schema from "../../../../Schema.ts"
import * as Rpc from "../../../rpc/Rpc.ts"
import * as RpcGroup from "../../../rpc/RpcGroup.ts"
import * as Previous from "./v2024_11_05.ts"

export * from "./v2024_11_05.ts"

export const protocolVersion = "2025-03-26"

const optional = Previous.optional

export const ServerCapabilities = Schema.Struct({
  ...Previous.ServerCapabilities.fields,
  completions: optional(Schema.Struct({}))
})

export const AudioContent = Schema.Struct({
  type: Schema.Literal("audio"),
  data: Schema.String,
  mimeType: Schema.String,
  annotations: optional(Previous.Annotation)
})

export const PromptOrToolContent = Schema.Union([
  Previous.TextContent,
  Previous.ImageContent,
  AudioContent,
  Previous.EmbeddedResource
])

export const SamplingContent = Schema.Union([
  Previous.TextContent,
  Previous.ImageContent,
  AudioContent
])

export const PromptMessage = Schema.Struct({
  role: Previous.Role,
  content: PromptOrToolContent
})

export const SamplingMessage = Schema.Struct({
  role: Previous.Role,
  content: SamplingContent
})

export const ToolAnnotations = Schema.Struct({
  title: optional(Schema.String),
  readOnlyHint: optional(Schema.Boolean),
  destructiveHint: optional(Schema.Boolean),
  idempotentHint: optional(Schema.Boolean),
  openWorldHint: optional(Schema.Boolean)
})

export const Tool = Schema.Struct({
  ...Previous.Tool.fields,
  annotations: optional(ToolAnnotations)
})

export const InitializeResult = Schema.Struct({
  ...Previous.ResultMeta.fields,
  protocolVersion: Schema.String,
  capabilities: ServerCapabilities,
  serverInfo: Previous.Implementation,
  instructions: optional(Schema.String)
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

export const CallToolResult = Schema.Struct({
  ...Previous.ResultMeta.fields,
  content: Schema.Array(PromptOrToolContent),
  isError: optional(Schema.Boolean)
})

export const CreateMessageResult = Schema.Struct({
  ...Previous.ResultMeta.fields,
  role: Previous.Role,
  content: SamplingContent,
  model: Schema.String,
  stopReason: optional(Schema.String)
})

export class Initialize extends Rpc.make("initialize", {
  success: InitializeResult,
  error: Previous.McpError,
  payload: {
    ...Previous.RequestMeta.fields,
    protocolVersion: Schema.String,
    capabilities: Previous.ClientCapabilities,
    clientInfo: Previous.Implementation
  }
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
    arguments: optional(Schema.JsonObject)
  }
}) {}

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
    metadata: optional(Schema.JsonObject)
  }
}) {}

export class ProgressNotification extends Rpc.make("notifications/progress", {
  payload: {
    ...Previous.NotificationMeta.fields,
    progressToken: Previous.ProgressToken,
    progress: Schema.Finite,
    total: optional(Schema.Finite),
    message: optional(Schema.String)
  }
}) {}

export class ClientRequestRpcs extends RpcGroup.make(
  Previous.Ping,
  Initialize,
  Previous.Complete,
  Previous.SetLevel,
  GetPrompt,
  Previous.ListPrompts,
  Previous.ListResources,
  Previous.ListResourceTemplates,
  Previous.ReadResource,
  Previous.Subscribe,
  Previous.Unsubscribe,
  CallTool,
  ListTools
) {}

export class ClientNotificationRpcs extends RpcGroup.make(
  Previous.CancelledNotification,
  ProgressNotification,
  Previous.InitializedNotification,
  Previous.RootsListChangedNotification
) {}

export class ClientRpcs extends ClientRequestRpcs.merge(ClientNotificationRpcs) {}

export class ServerRequestRpcs extends RpcGroup.make(
  Previous.Ping,
  CreateMessage,
  Previous.ListRoots
) {}

export class ServerNotificationRpcs extends RpcGroup.make(
  Previous.CancelledNotification,
  ProgressNotification,
  Previous.LoggingMessageNotification,
  Previous.ResourceUpdatedNotification,
  Previous.ResourceListChangedNotification,
  Previous.ToolListChangedNotification,
  Previous.PromptListChangedNotification
) {}
