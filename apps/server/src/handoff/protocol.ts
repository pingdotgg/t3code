/**
 * Handoff callback protocol — the wire contract between the `d handoff` CLI
 * (running inside a d-spawned agent session) and the server's `POST /handoff`
 * route, plus the environment variables the provider adapter injects at
 * session spawn so the CLI can find and authenticate to the server.
 *
 * Both ends live in this package (CLI subcommand and HTTP route), so the
 * schemas stay here rather than in `@t3tools/contracts`, which carries the
 * client-server protocol for external surfaces.
 *
 * @module handoff/protocol
 */
import { EnvironmentId, ThreadId, TrimmedNonEmptyString } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

/** Origin of the running d server, e.g. `http://127.0.0.1:3000`. */
export const T3_SERVER_ORIGIN_ENV = "T3_SERVER_ORIGIN";
/** Session-scoped bearer token authenticating callbacks to the server. */
export const T3_SERVER_TOKEN_ENV = "T3_SERVER_TOKEN";
/** Thread id of the session this environment was injected into. */
export const T3_THREAD_ID_ENV = "T3_THREAD_ID";
/**
 * How to invoke this server's own CLI (`<execPath> <binScript>`), for
 * sessions where no installed `d` binary is on PATH (e.g. dev servers).
 */
export const T3_CLI_ENV = "T3_CLI";
/**
 * CLI entry the shim at `T3_CLI` runs. Injected because the entry is not
 * always reachable from the shim's own directory: a packaged desktop app
 * unpacks the plugin but keeps the server bundle inside its asar archive.
 */
export const T3_CLI_ENTRY_ENV = "T3_CLI_ENTRY";
/**
 * Executable the shim reads `T3_CLI_ENTRY` with — this server's own runtime,
 * so an archived entry is read by the same asar-aware Electron binary that
 * runs the server.
 */
export const T3_CLI_RUNTIME_ENV = "T3_CLI_RUNTIME";

export const HANDOFF_HTTP_PATH = "/handoff";

export const HandoffRequest = Schema.Struct({
  name: TrimmedNonEmptyString,
  summary: TrimmedNonEmptyString,
});
export type HandoffRequest = typeof HandoffRequest.Type;

export const HandoffResponse = Schema.Struct({
  threadId: ThreadId,
  environmentId: EnvironmentId,
  title: Schema.String,
});
export type HandoffResponse = typeof HandoffResponse.Type;

export const HANDOFF_CREATED_ACTIVITY_KIND = "handoff.created";
export const HANDOFF_RECEIVED_ACTIVITY_KIND = "handoff.received";
