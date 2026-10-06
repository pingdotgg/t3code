import { expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpBody from "effect/http/HttpBody";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";

class UnexpectedStatus extends Data.TaggedError("UnexpectedStatus")<{
  message: string;
}> {}

// Bounded: rides out cold starts and (live) API-token propagation, which can
// take several seconds before R2 accepts the token-derived S3 credentials.
const retry = Schedule.max([Schedule.spaced("2 seconds"), Schedule.recurs(20)]);

const expectStatus = (
  request: HttpClientRequest.HttpClientRequest,
  status: number,
) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const res = yield* client.execute(request);
    const body = yield* res.text;
    if (res.status !== status) {
      return yield* new UnexpectedStatus({
        message: `${request.method} ${request.url} → ${res.status}: ${body.slice(0, 500)}`,
      });
    }
    return body;
  });

const until = <A, R>(effect: Effect.Effect<A, unknown, R>) =>
  effect.pipe(Effect.retry({ schedule: retry }), Effect.orDie);

const json = <T>(url: string) =>
  until(
    expectStatus(HttpClientRequest.get(url), 200).pipe(
      Effect.map((body) => JSON.parse(body) as T),
    ),
  );

/**
 * Drive a deployed presign fixture (`routes.ts`) end to end: upload through
 * a presigned PUT URL as an unauthenticated client, read it back through
 * the Worker's native binding and through a presigned GET URL, and check
 * that a pinned Content-Type is enforced.
 */
export const presignRoundTrip = (workerUrl: string, key: string) =>
  Effect.gen(function* () {
    const { url: putUrl } = yield* json<{ url: string }>(
      `${workerUrl}/presign-put?key=${encodeURIComponent(key)}&contentType=text/plain`,
    );

    yield* until(
      expectStatus(
        HttpClientRequest.put(putUrl).pipe(
          HttpClientRequest.setBody(
            HttpBody.text("uploaded via presigned url", "text/plain"),
          ),
        ),
        200,
      ),
    );

    const read = yield* json<{ value: string | null; contentType: string }>(
      `${workerUrl}/read?key=${encodeURIComponent(key)}`,
    );
    expect(read.value).toBe("uploaded via presigned url");
    expect(read.contentType).toBe("text/plain");

    // The signed Content-Type is enforced
    const client = yield* HttpClient.HttpClient;
    const wrongType = yield* client.execute(
      HttpClientRequest.put(putUrl).pipe(
        HttpClientRequest.setBody(HttpBody.text("{}", "application/json")),
      ),
    );
    expect(wrongType.status).toBe(403);

    const { url: getUrl } = yield* json<{ url: string }>(
      `${workerUrl}/presign-get?key=${encodeURIComponent(key)}&contentType=application/octet-stream`,
    );
    const downloaded = yield* client.get(getUrl);
    expect(downloaded.status).toBe(200);
    expect(downloaded.headers["content-type"]).toBe("application/octet-stream");
    expect(yield* downloaded.text).toBe("uploaded via presigned url");

    return { putUrl, getUrl };
  });
