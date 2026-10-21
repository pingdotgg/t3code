import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import { HttpClient, HttpClientRequest } from "effect/http";

const DEFAULT_HTTP_READY_PROBE_TIMEOUT_MS = 1_000;

function describeReadinessCause(cause: unknown): unknown {
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

export const waitForHttpReady = Effect.fn("shared.httpReadiness.waitForHttpReady")(function* <
  E,
>(input: {
  readonly baseUrl: string;
  readonly path?: string;
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
  const timeoutMs = input.timeoutMs ?? 30_000;
  const intervalMs = input.intervalMs ?? 100;
  const probeTimeoutMs = input.probeTimeoutMs ?? DEFAULT_HTTP_READY_PROBE_TIMEOUT_MS;
  const retryPolicy = Schedule.spaced(Duration.millis(intervalMs)).pipe(
    Schedule.upTo({ times: Math.max(0, Math.ceil(timeoutMs / intervalMs)) }),
  );
  const requestUrl = new URL(input.path ?? "/", input.baseUrl).toString();
  const client = yield* HttpClient.HttpClient;
  const lastProbeFailure = yield* Ref.make<unknown>(null);
  let attempt = 0;

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
          Effect.timeoutOption(Duration.millis(probeTimeoutMs)),
          Effect.mapError((cause) => fail(cause)),
        );
        return yield* Effect.fromOption(responseOption, () =>
          fail({
            kind: "probe-timeout",
            attempt,
            probeTimeoutMs,
          }),
        );
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
    Effect.timeoutOption(Duration.millis(timeoutMs)),
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
