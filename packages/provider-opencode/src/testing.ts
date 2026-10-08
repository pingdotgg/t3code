/**
 * OpenCode internals the server's replay testkits and live tests drive
 * directly: the 2.x client, server, adapter, and text generation, plus the
 * 1.x transcript identifiers.
 *
 * @module provider-opencode/testing
 */
export {
  OPENCODE_DEFAULT_INSTANCE_ID,
  OPENCODE_PROVIDER,
  OPENCODE_SDK_PROTOCOL,
} from "./server/adapter.ts";
export * as OpenCode2Adapter from "./server/v2/adapter.ts";
export { OPENCODE_2_STILL_STOPPING, t3McpServerName } from "./server/v2/adapter.ts";
export * as OpenCode2Client from "./server/v2/OpenCode2Client.ts";
export * as OpenCode2Server from "./server/v2/OpenCode2Server.ts";
export * as OpenCode2TextGeneration from "./server/v2/textGeneration.ts";
