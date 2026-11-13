import * as Schema from "effect/Schema";

import { NonNegativeInt, ThreadId, TrimmedNonEmptyString, TurnItemId } from "./baseSchemas.ts";

// The producing tool call restricts each app to its source server.
const McpAppTarget = {
  threadId: ThreadId,
  itemId: TurnItemId,
};

export const McpAppCallToolInput = Schema.Struct({
  ...McpAppTarget,
  name: TrimmedNonEmptyString,
  arguments: Schema.Record(Schema.String, Schema.Unknown),
});
export type McpAppCallToolInput = typeof McpAppCallToolInput.Type;

export const McpAppCallToolResult = Schema.Struct({
  content: Schema.Array(Schema.Unknown),
  structuredContent: Schema.optional(Schema.Unknown),
  isError: Schema.optional(Schema.Boolean),
  _meta: Schema.optional(Schema.Unknown),
});
export type McpAppCallToolResult = typeof McpAppCallToolResult.Type;

export const McpAppToolInfoInput = Schema.Struct({
  ...McpAppTarget,
  name: TrimmedNonEmptyString,
});
export type McpAppToolInfoInput = typeof McpAppToolInfoInput.Type;

export const McpAppToolInfo = Schema.Struct({
  callable: Schema.Boolean,
  readOnly: Schema.Boolean,
  title: Schema.optional(Schema.String),
  tool: Schema.optional(Schema.Unknown),
});
export type McpAppToolInfo = typeof McpAppToolInfo.Type;

export const McpAppReadResourceInput = Schema.Struct({
  ...McpAppTarget,
  uri: TrimmedNonEmptyString,
});
export type McpAppReadResourceInput = typeof McpAppReadResourceInput.Type;

export const McpAppReadResourceResult = Schema.Struct({
  contents: Schema.Array(Schema.Unknown),
});
export type McpAppReadResourceResult = typeof McpAppReadResourceResult.Type;

/** Replaces prior context; no content clears it. */
export const McpAppUpdateModelContextInput = Schema.Struct({
  ...McpAppTarget,
  conversationThreadId: ThreadId,
  content: Schema.optional(Schema.Array(Schema.Unknown)),
  structuredContent: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
});
export type McpAppUpdateModelContextInput = typeof McpAppUpdateModelContextInput.Type;

export const ThreadMcpServersInput = Schema.Struct({ threadId: ThreadId });
export type ThreadMcpServersInput = typeof ThreadMcpServersInput.Type;

export const ThreadMcpServerStatus = Schema.Literals([
  "connected",
  "pending",
  "needs-auth",
  "failed",
  "disabled",
]);
export type ThreadMcpServerStatus = typeof ThreadMcpServerStatus.Type;

export const ThreadMcpServer = Schema.Struct({
  name: Schema.String,
  status: ThreadMcpServerStatus,
  toolCount: NonNegativeInt,
  /** Origin only: configured URLs can carry tokens in their path or query. */
  origin: Schema.optional(Schema.String),
});
export type ThreadMcpServer = typeof ThreadMcpServer.Type;

/** Empty while the thread has no live provider session that reports MCP servers. */
export const ThreadMcpServers = Schema.Struct({ servers: Schema.Array(ThreadMcpServer) });
export type ThreadMcpServers = typeof ThreadMcpServers.Type;

export const McpAppRequestErrorReason = Schema.Literals([
  "not-an-app",
  "provider-unsupported",
  "session-stopped",
  "tool-not-callable",
  "unsupported-content",
  "request-failed",
]);
export type McpAppRequestErrorReason = typeof McpAppRequestErrorReason.Type;

export class McpAppRequestError extends Schema.TaggedError<McpAppRequestError>()(
  "McpAppRequestError",
  {
    threadId: ThreadId,
    reason: McpAppRequestErrorReason,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "not-an-app":
        return "This tool call has no MCP app.";
      case "provider-unsupported":
        return "This thread's provider cannot run MCP app requests.";
      case "session-stopped":
        return "The app's thread is not running. Send a message in the thread that created it to use the app again.";
      case "tool-not-callable":
        return "This app cannot call that tool.";
      case "unsupported-content":
        return "Only text and structured content are supported.";
      case "request-failed":
        return "The app's MCP server request failed.";
    }
  }
}
