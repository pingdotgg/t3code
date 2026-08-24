/**
 * Handoff callback environment — the env vars d injects into every spawned
 * agent session so the `d handoff` CLI inside it can find and authenticate
 * to this server (ADR 0002).
 *
 * The credential is the session's MCP bearer token: already per-thread,
 * already expiring with the session, already revoked when the session stops.
 *
 * `T3_CLI` is a single executable path (the `bin/d` shim shipped inside the
 * d Claude plugin), never a "runtime + script" pair: the skill expands it as
 * `"${T3_CLI:-d}"`, and zsh does not word-split unquoted parameters, so a
 * multi-word value would be treated as one filename.
 *
 * @module handoff/callbackEnvironment
 */
import type { McpProviderSessionConfig } from "../mcp/McpProviderSession.ts";
import {
  T3_CLI_ENTRY_ENV,
  T3_CLI_ENV,
  T3_CLI_RUNTIME_ENV,
  T3_SERVER_ORIGIN_ENV,
  T3_SERVER_TOKEN_ENV,
  T3_THREAD_ID_ENV,
} from "./protocol.ts";

export function makeHandoffCallbackEnvironment(
  session: McpProviderSessionConfig,
  options?: {
    /** Absolute path of the plugin's `bin/d` shim; omitted → sessions fall back to `d` on PATH. */
    readonly cliShimPath?: string;
    /** CLI entry the shim runs; omitted → the shim resolves one next to itself. */
    readonly cliEntryPath?: string;
    /** Executable that reads the entry; omitted → the shim falls back to `node`. */
    readonly cliRuntimePath?: string;
  },
): Record<string, string> {
  const origin = new URL(session.endpoint).origin;
  const token = session.authorizationHeader.startsWith("Bearer ")
    ? session.authorizationHeader.slice("Bearer ".length)
    : session.authorizationHeader;
  return {
    [T3_SERVER_ORIGIN_ENV]: origin,
    [T3_SERVER_TOKEN_ENV]: token,
    [T3_THREAD_ID_ENV]: session.threadId,
    ...(options?.cliShimPath ? { [T3_CLI_ENV]: options.cliShimPath } : {}),
    ...(options?.cliEntryPath ? { [T3_CLI_ENTRY_ENV]: options.cliEntryPath } : {}),
    ...(options?.cliEntryPath && options.cliRuntimePath
      ? { [T3_CLI_RUNTIME_ENV]: options.cliRuntimePath }
      : {}),
  };
}
