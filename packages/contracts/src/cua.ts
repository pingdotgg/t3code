import * as Schema from "effect/Schema";

import { ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ToolActivityNativeAppReference } from "./providerRuntime.ts";

export const CuaApplication = Schema.Struct({
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(160)),
  bundleId: Schema.optionalKey(TrimmedNonEmptyString.check(Schema.isMaxLength(512))),
  launchPath: Schema.optionalKey(TrimmedNonEmptyString.check(Schema.isMaxLength(2048))),
  pid: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThan(0))),
});
export type CuaApplication = typeof CuaApplication.Type;

export class CuaApplicationsError extends Schema.TaggedError<CuaApplicationsError>()(
  "CuaApplicationsError",
  { cause: Schema.Defect() },
) {
  override get message() {
    return "Could not list applications on this computer.";
  }
}

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
  app: Schema.optionalKey(ToolActivityNativeAppReference),
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

/** Driver readiness is independent of the enableCua setting. */
export const CuaHostStatus = Schema.Struct({
  platform: Schema.Literals(["darwin", "linux", "win32", "other"]),
  running: Schema.Boolean,
  /** Why the last start failed, until a later start succeeds. */
  failure: Schema.optionalKey(Schema.String),
});
export type CuaHostStatus = typeof CuaHostStatus.Type;

/** A Chromium browser on the environment's host that agents can attach to. */
export const BrowserTabsBrowser = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  /** Where the user turns on remote debugging, such as `chrome://inspect/#remote-debugging`. */
  inspectUrl: Schema.String,
  /** The browser is running with remote debugging on right now. */
  remoteDebugging: Schema.Boolean,
});
export type BrowserTabsBrowser = typeof BrowserTabsBrowser.Type;

/** What browser tab setup shows. Checking never installs anything. */
export const BrowserTabsStatus = Schema.Struct({
  browsers: Schema.Array(BrowserTabsBrowser),
  /** Chrome DevTools MCP is installed; setup installs it. */
  toolInstalled: Schema.Boolean,
});
export type BrowserTabsStatus = typeof BrowserTabsStatus.Type;

export const BrowserTabsAction = Schema.Literals(["install-tool"]);
export type BrowserTabsAction = typeof BrowserTabsAction.Type;

export class BrowserTabsError extends Schema.TaggedError<BrowserTabsError>()("BrowserTabsError", {
  action: BrowserTabsAction,
  /** The install failure. Never shown to users. */
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    return "Chrome DevTools MCP did not install.";
  }
}
