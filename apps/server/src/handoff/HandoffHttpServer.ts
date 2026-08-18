/**
 * HandoffHttpServer — `POST /handoff`, the server side of the `d handoff`
 * CLI callback.
 *
 * Authenticates with the same per-session bearer credential the MCP transport
 * uses (`McpSessionRegistry`): the token was injected into the session's
 * environment at spawn, it expires with the session, and it resolves to the
 * thread it was issued for — so the parent thread id for lineage comes from
 * the credential itself and cannot be spoofed by the calling process.
 *
 * @module handoff/HandoffHttpServer
 */
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as McpSessionRegistry from "../mcp/McpSessionRegistry.ts";
import { performHandoff } from "./HandoffService.ts";
import { HANDOFF_HTTP_PATH, HandoffRequest, type HandoffResponse } from "./protocol.ts";

const unauthorized = HttpServerResponse.jsonUnsafe(
  {
    error: "invalid_handoff_credential",
    message: "A valid session-scoped bearer credential is required.",
  },
  {
    status: 401,
    headers: {
      "cache-control": "no-store",
      "www-authenticate": "Bearer",
    },
  },
);

class InvalidHandoffRequestError extends Data.TaggedError("InvalidHandoffRequestError")<{
  readonly cause: unknown;
}> {}

const decodeHandoffRequest = Schema.decodeUnknownEffect(HandoffRequest);

export const handoffRouteLayer = HttpRouter.add(
  "POST",
  HANDOFF_HTTP_PATH,
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const serverEnvironment = yield* ServerEnvironment.ServerEnvironment;

    const authorization = request.headers.authorization;
    const token =
      authorization?.startsWith("Bearer ") === true
        ? authorization.slice("Bearer ".length).trim()
        : "";
    const invocation = yield* McpSessionRegistry.resolveActiveMcpToken(token);
    if (!invocation) return unauthorized;

    const payload = yield* request.json.pipe(
      Effect.flatMap((body) => decodeHandoffRequest(body)),
      Effect.mapError((cause) => new InvalidHandoffRequestError({ cause })),
    );

    const result = yield* performHandoff({
      parentThreadId: invocation.threadId,
      request: payload,
    });
    const environmentId = yield* serverEnvironment.getEnvironmentId;

    return HttpServerResponse.jsonUnsafe({
      threadId: result.threadId,
      environmentId,
      title: result.title,
    } satisfies HandoffResponse);
  }).pipe(
    Effect.catchTags({
      InvalidHandoffRequestError: () =>
        Effect.succeed(
          HttpServerResponse.jsonUnsafe(
            {
              error: "invalid_request",
              message: "Body must be JSON with non-empty `name` and `summary`.",
            },
            { status: 400 },
          ),
        ),
      HandoffParentNotFoundError: (error) =>
        Effect.succeed(
          HttpServerResponse.jsonUnsafe(
            {
              error: "parent_thread_not_found",
              message: `Thread ${error.parentThreadId} no longer exists or is archived.`,
            },
            { status: 404 },
          ),
        ),
      HandoffDispatchError: (error) =>
        Effect.logError("handoff dispatch failed", { cause: error }).pipe(
          Effect.as(
            HttpServerResponse.jsonUnsafe(
              {
                error: "handoff_failed",
                message: `Handoff failed while dispatching (${error.stage}).`,
              },
              { status: 500 },
            ),
          ),
        ),
    }),
  ),
);
