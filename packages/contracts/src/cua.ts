import * as Schema from "effect/Schema";

import { ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

/** Native host descriptor, confined to the desktop/server control pipe. */
export const CuaDriverMcpConfiguration = Schema.Struct({
  command: TrimmedNonEmptyString,
  args: Schema.Array(Schema.String),
  environment: Schema.Array(Schema.Struct({ name: TrimmedNonEmptyString, value: Schema.String })),
  /** The daemon's socket, so the server can attach its own SDK client beside the agent's MCP proxy. */
  socketPath: Schema.optionalKey(TrimmedNonEmptyString),
});
export type CuaDriverMcpConfiguration = typeof CuaDriverMcpConfiguration.Type;

/** A window the agent is driving, refreshed for the user while a client watches. */
export const CuaWindowPreviewFrame = Schema.Struct({
  appName: Schema.optionalKey(Schema.String),
  windowTitle: Schema.optionalKey(Schema.String),
  width: Schema.Number,
  height: Schema.Number,
  mimeType: Schema.String,
  dataBase64: Schema.String,
  capturedAt: Schema.String,
});
export type CuaWindowPreviewFrame = typeof CuaWindowPreviewFrame.Type;

export const CuaWindowPreviewState = Schema.Struct({
  status: Schema.Literals(["idle", "live", "unavailable"]),
  /** Why no frame can be captured, for the client to show instead of a stale card. */
  detail: Schema.optionalKey(Schema.String),
  frame: Schema.optionalKey(CuaWindowPreviewFrame),
});
export type CuaWindowPreviewState = typeof CuaWindowPreviewState.Type;

export const CuaWindowPreviewSubscribeInput = Schema.Struct({
  threadId: ThreadId,
});
export type CuaWindowPreviewSubscribeInput = typeof CuaWindowPreviewSubscribeInput.Type;

export const DesktopCuaDriverRequest = Schema.Struct({
  version: Schema.Literal(1),
  type: Schema.Literal("cuaDriverRequest"),
  requestId: TrimmedNonEmptyString,
  enabled: Schema.Boolean,
});
export type DesktopCuaDriverRequest = typeof DesktopCuaDriverRequest.Type;

export const DesktopCuaDriverReport = Schema.Union([
  Schema.Struct({
    version: Schema.Literal(1),
    type: Schema.Literal("cuaDriverReport"),
    requestId: TrimmedNonEmptyString,
    status: Schema.Literal("ready"),
    mcp: CuaDriverMcpConfiguration,
  }),
  Schema.Struct({
    version: Schema.Literal(1),
    type: Schema.Literal("cuaDriverReport"),
    requestId: TrimmedNonEmptyString,
    status: Schema.Literals(["stopped", "unavailable"]),
    message: Schema.optionalKey(Schema.String),
  }),
]);
export type DesktopCuaDriverReport = typeof DesktopCuaDriverReport.Type;
