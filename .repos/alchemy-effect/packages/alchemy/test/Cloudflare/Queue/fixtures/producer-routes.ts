import type { WriteQueueClient } from "@/Cloudflare/Queues/WriteQueue.ts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import type * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

/** Producer accepted the message(s). */
const accepted = HttpServerResponse.json({ ok: true }, { status: 202 });
const failed = (cause: Cause.Cause<unknown>) =>
  HttpServerResponse.json({ error: Cause.pretty(cause) }, { status: 500 });

/**
 * Shared producer routes exercised by both the binding and HTTP fixtures so
 * every method of {@link WriteQueueClient} is driven over `fetch`. The
 * Cloudflare Queue binding is producer-only, so this is the full surface:
 *
 * - `POST /send` — `send(body)` with the default JSON content type.
 * - `POST /send-text` — `send(body, { contentType: "text" })`.
 * - `POST /sendBatch` — `sendBatch([...])` with JSON message bodies.
 * - `POST /sendBatch-text` — `sendBatch([...])` with per-message `text`
 *   content type.
 *
 * (`raw` is the native-binding escape hatch and `Effect.die`s over the HTTP
 * token, so it is intentionally not routed here.)
 *
 * Returns `undefined` when the path is not a producer route so the caller can
 * fall through to a 404.
 */
export const producerRoutes = (
  q: WriteQueueClient,
  request: HttpServerRequest.HttpServerRequest,
  url: URL,
) =>
  Effect.gen(function* () {
    if (request.method !== "POST") return undefined;
    switch (url.pathname) {
      case "/send": {
        const text = yield* request.text;
        return yield* q.send({ text }).pipe(
          Effect.matchCauseEffect({
            onSuccess: () => accepted,
            onFailure: failed,
          }),
        );
      }
      case "/send-text": {
        const text = yield* request.text;
        return yield* q.send(text, { contentType: "text" }).pipe(
          Effect.matchCauseEffect({
            onSuccess: () => accepted,
            onFailure: failed,
          }),
        );
      }
      case "/sendBatch":
        return yield* q
          .sendBatch([{ body: { text: "a" } }, { body: { text: "b" } }])
          .pipe(
            Effect.matchCauseEffect({
              onSuccess: () => accepted,
              onFailure: failed,
            }),
          );
      case "/sendBatch-text":
        return yield* q
          .sendBatch([
            { body: "a", contentType: "text" },
            { body: "b", contentType: "text" },
          ])
          .pipe(
            Effect.matchCauseEffect({
              onSuccess: () => accepted,
              onFailure: failed,
            }),
          );
      default:
        return undefined;
    }
  });
