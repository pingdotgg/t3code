import {
  RELAY_WEBHOOK_INBOX_PATH_PREFIX,
  RELAY_WEBHOOK_MAX_BODY_BYTES,
} from "@t3tools/contracts/relay";
import * as Effect from "effect/Effect";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

import * as WebhookDeliveries from "./WebhookDeliveries.ts";
import * as WebhookInboxes from "./WebhookInboxes.ts";

// Credentials and edge/proxy bookkeeping never reach the environment; every
// other header is kept so the agent can tell what sent the webhook.
const DROPPED_HEADERS = new Set([
  "authorization",
  "proxy-authorization",
  "cookie",
  "forwarded",
  "x-real-ip",
  "true-client-ip",
  "host",
  "connection",
  "content-length",
  "accept-encoding",
  "cdn-loop",
]);
const DROPPED_HEADER_PREFIXES = ["cf-", "x-forwarded-"];

export function webhookDeliveryHeaders(
  headers: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  const kept: Record<string, string> = {};
  for (const [rawName, value] of Object.entries(headers)) {
    const name = rawName.toLowerCase();
    if (
      value === undefined ||
      DROPPED_HEADERS.has(name) ||
      DROPPED_HEADER_PREFIXES.some((prefix) => name.startsWith(prefix))
    ) {
      continue;
    }
    kept[name] = value;
  }
  return kept;
}

const status = (code: number, error?: string) =>
  HttpServerResponse.jsonUnsafe(error ? { ok: false, error } : { ok: true }, { status: code });

const receiveWebhook = (
  inboxes: WebhookInboxes.WebhookInboxes["Service"],
  deliveries: WebhookDeliveries.WebhookDeliveries["Service"],
) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const { inboxId } = yield* HttpRouter.params;
    if (!inboxId || inboxId.length > 64) {
      return status(404, "inbox_not_found");
    }
    const declaredLength = Number(request.headers["content-length"]);
    if (Number.isFinite(declaredLength) && declaredLength > RELAY_WEBHOOK_MAX_BODY_BYTES) {
      return status(413, "body_too_large");
    }
    const body = yield* request.arrayBuffer;
    if (body.byteLength > RELAY_WEBHOOK_MAX_BODY_BYTES) {
      return status(413, "body_too_large");
    }
    const result = yield* inboxes.receive({
      inboxId,
      headers: webhookDeliveryHeaders(request.headers),
      body: new TextDecoder().decode(body),
    });
    switch (result.status) {
      case "stored":
        // Stored is durable: if queueing fails the cron sweep pushes it later.
        yield* deliveries
          .enqueue(result.deliveryId)
          .pipe(
            Effect.catch((error) =>
              Effect.logWarning("Failed to queue webhook delivery", { cause: error.cause }),
            ),
          );
        return status(202);
      case "inbox_not_found":
        return status(404, "inbox_not_found");
      case "inbox_full":
        return status(429, "inbox_full");
    }
  }).pipe(
    Effect.withSpan("relay.webhook_inbox.receive"),
    Effect.catchTags({
      HttpServerError: () => Effect.succeed(status(400, "body_unreadable")),
      WebhookInboxPersistenceError: (error) =>
        Effect.logError("Failed to store webhook delivery", { cause: error.cause }).pipe(
          Effect.as(status(500, "internal_error")),
        ),
    }),
  );

/** Public `POST /v1/inbox/:inboxId`: stores the request as-is and queues it for its environment. */
export const webhookInboxRoute = HttpRouter.use((router) =>
  Effect.gen(function* () {
    const inboxes = yield* WebhookInboxes.WebhookInboxes;
    const deliveries = yield* WebhookDeliveries.WebhookDeliveries;
    yield* router.add(
      "POST",
      `${RELAY_WEBHOOK_INBOX_PATH_PREFIX}:inboxId`,
      receiveWebhook(inboxes, deliveries),
    );
  }),
);
