import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";

/** Native host descriptor, confined to the desktop/server control pipe. */
export const CuaDriverMcpConfiguration = Schema.Struct({
  command: TrimmedNonEmptyString,
  args: Schema.Array(Schema.String),
  environment: Schema.Array(Schema.Struct({ name: TrimmedNonEmptyString, value: Schema.String })),
  /** The daemon's socket, so the server can attach its own SDK client beside the agent's MCP proxy. */
  socketPath: Schema.optionalKey(TrimmedNonEmptyString),
});
export type CuaDriverMcpConfiguration = typeof CuaDriverMcpConfiguration.Type;

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

/**
 * Whether the environment's host can run computer use right now. Setup flows
 * show it; the switch itself records intent and is not a readiness signal.
 */
export const CuaHostStatus = Schema.Struct({
  /** The host's OS, which decides what the user must grant. */
  platform: Schema.Literals(["darwin", "linux", "win32", "other"]),
  /** The driver started for an agent session and is running. */
  running: Schema.Boolean,
  /** Why the last start failed, until a later start succeeds. */
  failure: Schema.optionalKey(Schema.String),
});
export type CuaHostStatus = typeof CuaHostStatus.Type;
