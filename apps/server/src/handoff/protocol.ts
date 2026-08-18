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
