import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";

import { encryptWebPush } from "./webPushEncrypt.ts";

const encodeData = Schema.encodeSync(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.String)),
);

class UnifiedPushRetryableError extends Schema.TaggedError<UnifiedPushRetryableError>()(
  "UnifiedPushRetryableError",
  {},
) {}

const backoff = Schedule.min([Schedule.exponential("1 second"), Schedule.spaced("60 seconds")]);
// Retries refresh updated_at, so this cap stands in for the phone's ten-minute freshness check.
const MAX_MESSAGE_AGE_MS = 10 * 60 * 1_000;

export const postUnifiedPush = Effect.fn("UnifiedPush.post")(function* (
  endpoint: string,
  data: Readonly<Record<string, string>>,
  keys?: { readonly p256dh: string; readonly auth: string },
) {
  const client = yield* HttpClient.HttpClient;
  const remainingMs =
    Number(data.updated_at) + MAX_MESSAGE_AGE_MS - (yield* Clock.currentTimeMillis);
  if (!(remainingMs > 0)) return { outcome: "expired", status: undefined } as const;
  const attempt = Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    const body = encodeData({ ...data, updated_at: String(now) });
    // A distributor that relays through a public Web Push service gives the connector's keys; plain POSTs suit one you host.
    const request = keys
      ? yield* Effect.tryPromise({
          try: () => encryptWebPush({ plaintext: new TextEncoder().encode(body), ...keys }),
          catch: () => "unencryptable" as const,
        }).pipe(
          Effect.map((encrypted) =>
            HttpClientRequest.post(endpoint).pipe(
              HttpClientRequest.bodyUint8Array(encrypted, "application/octet-stream"),
              HttpClientRequest.setHeaders({
                "content-encoding": "aes128gcm",
                ttl: String(MAX_MESSAGE_AGE_MS / 1_000),
                urgency: "high",
              }),
            ),
          ),
          Effect.option,
        )
      : Option.some(
          HttpClientRequest.post(endpoint).pipe(
            HttpClientRequest.bodyText(body, "application/json"),
          ),
        );
    if (Option.isNone(request)) return { outcome: "unencryptable", status: undefined } as const;
    const response = yield* client
      .execute(request.value)
      .pipe(Effect.mapError(() => new UnifiedPushRetryableError({})));
    const status = response.status;
    if (status >= 200 && status < 300) return { outcome: "accepted", status } as const;
    if (status === 404 || status === 410) return { outcome: "gone", status } as const;
    if (status === 429 || status >= 500) return yield* new UnifiedPushRetryableError({});
    return { outcome: "rejected", status } as const;
  });
  // The deadline covers the requests too, so a stalled one cannot outlive it or hold the queue.
  const sent = yield* attempt.pipe(Effect.retry(backoff), Effect.timeoutOption(remainingMs));
  return Option.getOrElse(sent, () => ({ outcome: "expired", status: undefined }) as const);
});
