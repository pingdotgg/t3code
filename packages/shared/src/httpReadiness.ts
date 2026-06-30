import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";

const DEFAULT_HTTP_READY_TIMEOUT = Duration.seconds(30);
const DEFAULT_HTTP_READY_INTERVAL = Duration.millis(100);
export const DEFAULT_HTTP_READY_PROBE_TIMEOUT = Duration.seconds(1);
export const DEFAULT_HTTP_READY_PROBE_TIMEOUT_MS = Duration.toMillis(
  DEFAULT_HTTP_READY_PROBE_TIMEOUT,
);

function normalizeDuration(input: {
  readonly duration: Duration.Input | undefined;
  readonly durationMs: number | undefined;
  readonly fallback: Duration.Duration;
}): Duration.Duration {
  return Option.getOrElse(
    Duration.fromInput(input.duration ?? input.durationMs ?? input.fallback),
    () => input.fallback,
  );
}

/**
 * Normalizes an arbitrary readiness probe failure into a plain, structured value
 * suitable for diagnostic logging. Preserves the tagged-error `_tag` (and
 * message/cause) shape for Effect tagged errors while recursing through nested
 * `cause`/`reason` chains.
 */
export function describeReadinessCause(cause: unknown): unknown {
  if (cause instanceof Error) {
    const tag = (cause as { readonly _tag?: unknown })._tag;
    const nested = (cause as { readonly cause?: unknown }).cause;
    return {
      ...(typeof tag === "string" ? { _tag: tag } : { name: cause.name }),
      message: cause.message,
      ...(nested === undefined ? {} : { cause: describeReadinessCause(nested) }),
    };
  }
  if (typeof cause !== "object" || cause === null) {
    return cause;
  }

  const record = cause as Readonly<Record<string, unknown>>;
  return {
    ...(typeof record._tag === "string" ? { _tag: record._tag } : {}),
    ...(typeof record.message === "string" ? { message: record.message } : {}),
    ...(record.reason === undefined ? {} : { reason: describeReadinessCause(record.reason) }),
    ...(record.cause === undefined ? {} : { cause: describeReadinessCause(record.cause) }),
  };
}

/**
 * Generic HTTP readiness probe shared by the SSH tunnel and the desktop backend
 * manager. Polls `baseUrl + path` until it returns a 2xx response or the overall
 * `timeout` elapses. Each individual probe is bounded by `probeTimeout` so a
 * single hung request cannot stall the retry loop, and the retry cadence is
 * `interval` bounded to roughly `timeout / interval` attempts. Legacy `*Ms`
 * options are still accepted at the boundary and are treated as milliseconds.
 *
 * The error type is left to the caller via `makeError`, so each consumer keeps
 * its own tagged error. `makeError` is called at every failure site; callers can
 * inspect `cause` (which carries a `kind` discriminator for the probe-timeout and
 * overall-timeout cases) to reproduce phase-specific messages, or ignore it.
 */
export const waitForHttpReady = Effect.fn("shared.httpReadiness.waitForHttpReady")(function* <
  E,
>(input: {
  readonly baseUrl: string;
  readonly path?: string;
  readonly timeout?: Duration.Input;
  readonly interval?: Duration.Input;
  readonly probeTimeout?: Duration.Input;
  readonly timeoutMs?: number;
  readonly intervalMs?: number;
  readonly probeTimeoutMs?: number;
  readonly makeError: (info: {
    readonly requestUrl: string;
    readonly probeTimeoutMs: number;
    readonly attempt: number;
    readonly cause: unknown;
  }) => E;
}): Effect.fn.Return<void, E, HttpClient.HttpClient> {
  const timeout = normalizeDuration({
    duration: input.timeout,
    durationMs: input.timeoutMs,
    fallback: DEFAULT_HTTP_READY_TIMEOUT,
  });
  const interval = normalizeDuration({
    duration: input.interval,
    durationMs: input.intervalMs,
    fallback: DEFAULT_HTTP_READY_INTERVAL,
  });
  const probeTimeout = normalizeDuration({
    duration: input.probeTimeout,
    durationMs: input.probeTimeoutMs,
    fallback: DEFAULT_HTTP_READY_PROBE_TIMEOUT,
  });
  const timeoutMs = Duration.toMillis(timeout);
  const intervalMs = Duration.toMillis(interval);
  const probeTimeoutMs = Duration.toMillis(probeTimeout);
  const retryPolicy = Schedule.spaced(interval).pipe(
    Schedule.take(Math.max(0, Math.ceil(timeoutMs / intervalMs))),
  );
  const requestUrl = new URL(input.path ?? "/", input.baseUrl).toString();
  const client = yield* HttpClient.HttpClient;
  const lastProbeFailure = yield* Ref.make<unknown>(null);
  let attempt = 0;

  // Tracks errors this function itself produced via `makeError`, so the
  // pass-through guards below never double-wrap an already-constructed error
  // (mirrors the SSH original's `cause instanceof SshReadinessError` checks).
  const makeError = input.makeError;
  const madeErrors = new WeakSet<object>();
  const fail = (cause: unknown): E => {
    const error = makeError({ requestUrl, probeTimeoutMs, attempt, cause });
    if (typeof error === "object" && error !== null) {
      madeErrors.add(error);
    }
    return error;
  };
  const isMadeError = (value: unknown): value is E =>
    typeof value === "object" && value !== null && madeErrors.has(value);

  yield* Effect.logDebug("httpReadiness.start", {
    baseUrl: input.baseUrl,
    requestUrl,
    timeoutMs,
    intervalMs,
    probeTimeoutMs,
  });

  const readinessClient = client.pipe(
    HttpClient.filterStatusOk,
    HttpClient.transform((effect) =>
      Effect.gen(function* () {
        attempt += 1;
        const responseOption = yield* effect.pipe(
          Effect.timeoutOption(probeTimeout),
          Effect.mapError((cause) => fail(cause)),
        );
        return yield* Option.match(responseOption, {
          onSome: Effect.succeed,
          onNone: () =>
            Effect.fail(
              fail({
                kind: "probe-timeout",
                attempt,
                probeTimeoutMs,
              }),
            ),
        });
      }).pipe(
        Effect.mapError((cause) => (isMadeError(cause) ? cause : fail(cause))),
        Effect.tapError((cause) =>
          Ref.set(lastProbeFailure, {
            attempt,
            cause: describeReadinessCause(cause),
          }),
        ),
      ),
    ),
    HttpClient.tap((response) => response.text.pipe(Effect.ignore)),
    HttpClient.retry(retryPolicy),
  );

  const result = yield* readinessClient.execute(HttpClientRequest.get(requestUrl)).pipe(
    Effect.mapError((cause) => (isMadeError(cause) ? cause : fail(cause))),
    Effect.timeoutOption(timeout),
  );

  return yield* Option.match(result, {
    onSome: () =>
      Effect.logDebug("httpReadiness.succeeded", {
        baseUrl: input.baseUrl,
        requestUrl,
        attempts: attempt,
      }),
    onNone: () =>
      Effect.gen(function* () {
        const lastFailure = yield* Ref.get(lastProbeFailure);
        yield* Effect.logWarning("httpReadiness.timedOut", {
          baseUrl: input.baseUrl,
          requestUrl,
          timeoutMs,
          intervalMs,
          probeTimeoutMs,
          attempts: attempt,
          lastFailure,
        });
        return yield* Effect.fail(
          fail({
            kind: "overall-timeout",
            baseUrl: input.baseUrl,
            timeoutMs,
            lastFailure,
          }),
        );
      }),
  });
});
