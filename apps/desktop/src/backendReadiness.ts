import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";
import * as Cause from "effect/Cause";
import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as Schedule from "effect/Schedule";
import { HttpClient } from "effect/unstable/http";

export interface WaitForHttpReadyEffectOptions {
  readonly timeout?: Duration.Duration;
  readonly interval?: Duration.Duration;
  readonly requestTimeout?: Duration.Duration;
  readonly path?: string;
}

export interface WaitForHttpReadyOptions extends WaitForHttpReadyEffectOptions {
  readonly signal?: AbortSignal;
}

const DEFAULT_TIMEOUT = Duration.seconds(30);
const DEFAULT_INTERVAL = Duration.millis(100);
const DEFAULT_REQUEST_TIMEOUT = Duration.seconds(1);

export class BackendReadinessAbortedError extends Data.TaggedError(
  "BackendReadinessAbortedError",
)<{}> {
  static is = (u: unknown): u is BackendReadinessAbortedError =>
    Predicate.isTagged(u, "BackendReadinessAbortedError");

  override get message() {
    return "Backend readiness wait was aborted.";
  }
}

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
): Effect.fn.Return<void, Error, HttpClient.HttpClient> {
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
    Effect.timeoutOption(timeout),
    Effect.catchTags({
      TimeoutError: () => Effect.fail(new BackendTimeoutError({ url: baseUrl })),
      // Maybe map this to different error kind?
      HttpClientError: () => Effect.fail(new BackendTimeoutError({ url: baseUrl })),
    }),
  );
});

/**
 * @deprecated - Temporary promise shim until remaining desktop entrypoint is ported to Effect
 */
export async function waitForHttpReady(
  baseUrl: URL,
  options?: WaitForHttpReadyOptions,
): Promise<void> {
  const signal = options?.signal;

  const exit = await Effect.runPromiseExit(
    waitForHttpReadyEffect(baseUrl, options).pipe(Effect.provide(NodeHttpClient.layerUndici)),
    { signal },
  );
  if (exit._tag === "Success") return;
  if (Cause.hasInterrupts(exit.cause)) throw new BackendReadinessAbortedError();
  throw Cause.squash(exit.cause);
}
