import {
  OrchestrationV2GetTurnItemResult,
  OrchestrationV2ThreadHistoryPage,
  OrchestrationV2ThreadStreamItem,
  PEER_LINK_THREAD_HISTORY_ROUTE,
  PEER_LINK_THREAD_ITEM_ROUTE,
  PEER_LINK_THREAD_STREAM_ROUTE,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import { eventStreamResponse } from "../eventStreamResponse.ts";
import * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ServerSettings from "../serverSettings.ts";
import { subscribeOrchestrationV2Thread } from "../ws.ts";

/** How soon an open stream ends after its link is revoked here or the beta is turned off. */
const ACCESS_RECHECK_INTERVAL = Duration.seconds(30);
const NO_STORE = { "cache-control": "no-store" };

// The owner's thread types hold DateTime values; the JSON codec writes them as strings.
const encodeStreamItem = Schema.encodeEffect(
  Schema.fromJsonString(Schema.toCodecJson(OrchestrationV2ThreadStreamItem)),
);
const encodeHistoryPage = Schema.encodeEffect(Schema.toCodecJson(OrchestrationV2ThreadHistoryPage));
const encodeItem = Schema.encodeEffect(Schema.toCodecJson(OrchestrationV2GetTurnItemResult));

const refusal = (status: number, error: string) =>
  HttpServerResponse.jsonUnsafe({ error }, { status, headers: NO_STORE });

/**
 * Admits a peer link's session, as `/mcp` does: no browser origin, the link's own bearer, and the
 * Linked environments beta on here. Every access level may read, as each reads through `/mcp`.
 */
const admitLink = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  if (request.headers.origin !== undefined) return refusal(403, "origin_not_allowed");
  const auth = yield* EnvironmentAuth.EnvironmentAuth;
  const settings = yield* ServerSettings.ServerSettingsService;
  const linksEnabled = settings.getSettings.pipe(
    Effect.map((current) => current.linkedEnvironmentsEnabled),
    Effect.orElseSucceed(() => false),
  );
  // Verifying renews the link's session, as each `/mcp` call does.
  const verify = auth.authenticateMcpClient(request).pipe(Effect.option);
  const client = yield* verify;
  if (client._tag === "None") return refusal(401, "unauthorized");
  if (!client.value.peerLink) return refusal(403, "not_a_link_session");
  if (!(yield* linksEnabled)) return refusal(403, "linked_environments_off");
  const params = new URLSearchParams(request.url.split("?", 2)[1] ?? "");
  const threadId = params.get("thread");
  if (!threadId) return refusal(400, "invalid_request");
  const threads = yield* ThreadManagement.ThreadManagementService;
  const shell = yield* threads.getThreadShell(ThreadId.make(threadId)).pipe(Effect.option);
  if (shell._tag === "None") return refusal(500, "thread_read_failed");
  if (shell.value === null || shell.value.deletedAt !== null) {
    return refusal(404, "thread_not_found");
  }
  return {
    threadId: shell.value.id,
    params,
    linkExpiresAt: client.value.linkExpiresAt,
    /** Completes once the link's session or the beta no longer admits it. */
    revoked: Effect.all([verify, linksEnabled]).pipe(
      Effect.repeat({
        schedule: Schedule.spaced(ACCESS_RECHECK_INTERVAL),
        until: ([current, enabled]) => current._tag === "None" || !enabled,
      }),
    ),
  };
});

const withLinkExpiry = (
  response: HttpServerResponse.HttpServerResponse,
  linkExpiresAt: DateTime.Utc | undefined,
) =>
  linkExpiresAt === undefined
    ? response
    : HttpServerResponse.setHeader(
        response,
        McpInvocationContext.LINK_EXPIRES_AT_HEADER,
        DateTime.formatIso(linkExpiresAt),
      );

// The owner's thread subscription with a bounded snapshot: the same items, in the same order.
const streamRoute = HttpRouter.add(
  "GET",
  PEER_LINK_THREAD_STREAM_ROUTE,
  Effect.gen(function* () {
    const admitted = yield* admitLink;
    if (HttpServerResponse.isHttpServerResponse(admitted)) return admitted;
    const items = yield* subscribeOrchestrationV2Thread({
      threadId: admitted.threadId,
      acceptBoundedSnapshot: true,
    }).pipe(Effect.option);
    if (items._tag === "None") return refusal(500, "thread_read_failed");
    return withLinkExpiry(
      eventStreamResponse(
        items.value.pipe(
          // A failed read closes the response; the linking environment reports it and reconnects.
          Stream.catchCause(() => Stream.empty),
          Stream.interruptWhen(admitted.revoked),
        ),
        encodeStreamItem,
      ),
      admitted.linkExpiresAt,
    );
  }),
);

const historyRoute = HttpRouter.add(
  "GET",
  PEER_LINK_THREAD_HISTORY_ROUTE,
  Effect.gen(function* () {
    const admitted = yield* admitLink;
    if (HttpServerResponse.isHttpServerResponse(admitted)) return admitted;
    const cursor = admitted.params.get("cursor");
    if (!cursor) return refusal(400, "invalid_request");
    const threads = yield* ThreadManagement.ThreadManagementService;
    const body = yield* threads
      .getThreadHistoryPage(admitted.threadId, cursor)
      .pipe(Effect.flatMap(encodeHistoryPage), Effect.option);
    if (body._tag === "None") return refusal(500, "thread_read_failed");
    return withLinkExpiry(
      HttpServerResponse.jsonUnsafe(body.value, { headers: NO_STORE }),
      admitted.linkExpiresAt,
    );
  }),
);

const itemRoute = HttpRouter.add(
  "GET",
  PEER_LINK_THREAD_ITEM_ROUTE,
  Effect.gen(function* () {
    const admitted = yield* admitLink;
    if (HttpServerResponse.isHttpServerResponse(admitted)) return admitted;
    const itemId = admitted.params.get("item");
    if (!itemId) return refusal(400, "invalid_request");
    const threads = yield* ThreadManagement.ThreadManagementService;
    const body = yield* threads
      .getTurnItem({ threadId: admitted.threadId, itemId: TurnItemId.make(itemId) })
      .pipe(Effect.flatMap(encodeItem), Effect.option);
    if (body._tag === "None") return refusal(500, "thread_read_failed");
    return withLinkExpiry(
      HttpServerResponse.jsonUnsafe(body.value, { headers: NO_STORE }),
      admitted.linkExpiresAt,
    );
  }),
);

/** What an environment serves of its threads to the environments linked to it. */
export const layer = Layer.mergeAll(streamRoute, historyRoute, itemRoute);
