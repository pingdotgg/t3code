import {
  RELAY_WEBHOOK_INBOX_PATH_PREFIX,
  RELAY_WEBHOOK_MAX_BODY_BYTES,
} from "@t3tools/contracts/relay";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
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

/**
 * Reads the body while counting bytes, so a sender that omits Content-Length
 * cannot make the Worker buffer more than `limit` bytes. Null means too large.
 */
const readBodyWithin = <E>(stream: Stream.Stream<Uint8Array, E>, limit: number) =>
  Effect.gen(function* () {
    const chunks: Array<Uint8Array> = [];
    let size = 0;
    yield* Stream.runForEachWhile(stream, (chunk) =>
      Effect.sync(() => {
        size += chunk.byteLength;
        if (size > limit) return false;
        chunks.push(chunk);
        return true;
      }),
    );
    if (size > limit) return null;
    const body = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      body.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return body;
  });

const utf8 = new TextDecoder("utf-8", { fatal: true });
const decodeUtf8 = (bytes: Uint8Array): string | null => {
  try {
    return utf8.decode(bytes);
  } catch {
    return null;
  }
};

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
    const bytes = yield* readBodyWithin(request.stream, RELAY_WEBHOOK_MAX_BODY_BYTES);
    if (bytes === null) {
      return status(413, "body_too_large");
    }
    const body = decodeUtf8(bytes);
    // The body is stored and handed to an agent as text; binary would arrive mangled.
    if (body === null) {
      return status(415, "body_not_utf8");
    }
    const result = yield* inboxes.receive({
      inboxId,
      headers: webhookDeliveryHeaders(request.headers),
      body,
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
