import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { HttpClient } from "effect/unstable/http";

export interface WaitForHttpReadyEffectOptions {
  readonly timeout?: Duration.Duration;
  readonly interval?: Duration.Duration;
  readonly requestTimeout?: Duration.Duration;
  readonly path?: string;
}

const DEFAULT_TIMEOUT = Duration.seconds(30);
const DEFAULT_INTERVAL = Duration.millis(100);
const DEFAULT_REQUEST_TIMEOUT = Duration.seconds(1);

export class BackendTimeoutError extends Data.TaggedError("BackendTimeoutError")<{
  readonly url: URL;
}> {
  override get message() {
    return `Timed out waiting for backend readiness at ${this.url.href}.`;
  }
}

export const waitForHttpReadyEffect = Effect.fn("waitForHttpReadyEffect")(function* (
  baseUrl: URL,
  options?: WaitForHttpReadyEffectOptions,
): Effect.fn.Return<void, BackendTimeoutError, HttpClient.HttpClient> {
  const timeout = options?.timeout ?? DEFAULT_TIMEOUT;
  const interval = options?.interval ?? DEFAULT_INTERVAL;
  const requestTimeout = options?.requestTimeout ?? DEFAULT_REQUEST_TIMEOUT;
  const readinessPath = options?.path ?? "/";
  const requestUrl = new URL(readinessPath, baseUrl);

  const client = (yield* HttpClient.HttpClient).pipe(
    HttpClient.filterStatusOk,
    HttpClient.transformResponse(Effect.timeout(requestTimeout)),
    HttpClient.retry(Schedule.spaced(interval)),
  );

  yield* client.get(requestUrl).pipe(
    Effect.asVoid,
    Effect.timeout(timeout),
    Effect.mapError(() => new BackendTimeoutError({ url: baseUrl })),
  );
});
