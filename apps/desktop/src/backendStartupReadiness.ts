import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

export type BackendStartupReadySource = "listening" | "http";

export interface BackendStartupReadinessService {
  readonly listening: Option.Option<Effect.Effect<void, unknown>>;
  readonly httpReady: Effect.Effect<void, unknown>;
  readonly cancelHttpWait: Effect.Effect<void>;
}

export class BackendStartupReadiness extends Context.Service<
  BackendStartupReadiness,
  BackendStartupReadinessService
>()("@t3tools/desktop/BackendStartupReadiness") {}

export interface WaitForBackendStartupReadyOptions {
  readonly listeningPromise?: Promise<void> | null;
  readonly waitForHttpReady: () => Promise<void>;
  readonly cancelHttpWait: () => void;
}

function fromPromise(promise: Promise<void>): Effect.Effect<void, unknown> {
  return Effect.callback<void, unknown>((resume) => {
    promise.then(
      () => resume(Effect.void),
      (error) => resume(Effect.fail(error)),
    );
  });
}

function fromPromiseThunk(thunk: () => Promise<void>): Effect.Effect<void, unknown> {
  return Effect.callback<void, unknown>((resume) => {
    try {
      thunk().then(
        () => resume(Effect.void),
        (error) => resume(Effect.fail(error)),
      );
    } catch (error) {
      resume(Effect.fail(error));
    }
  });
}

export function waitForBackendStartupReadyEffect(): Effect.Effect<
  BackendStartupReadySource,
  unknown,
  BackendStartupReadiness
> {
  return Effect.gen(function* () {
    const readiness = yield* BackendStartupReadiness;
    const httpReady = readiness.httpReady.pipe(Effect.as("http" as const));

    if (Option.isNone(readiness.listening)) {
      return yield* httpReady.pipe(Effect.onInterrupt(() => readiness.cancelHttpWait));
    }

    const listeningReady = readiness.listening.value.pipe(
      Effect.matchEffect({
        onFailure: (error) => readiness.cancelHttpWait.pipe(Effect.andThen(Effect.fail(error))),
        onSuccess: () => readiness.cancelHttpWait.pipe(Effect.as("listening" as const)),
      }),
    );

    return yield* Effect.raceFirst(listeningReady, httpReady).pipe(
      Effect.onInterrupt(() => readiness.cancelHttpWait),
    );
  });
}

/**
 * @deprecated - Temporary promise shim until remaining desktop entrypoint is ported to Effect.
 */
export function waitForBackendStartupReady(
  options: WaitForBackendStartupReadyOptions,
): Promise<BackendStartupReadySource> {
  return Effect.runPromise(
    waitForBackendStartupReadyEffect().pipe(
      Effect.provideService(BackendStartupReadiness, {
        listening: Option.fromNullishOr(options.listeningPromise).pipe(Option.map(fromPromise)),
        httpReady: fromPromiseThunk(options.waitForHttpReady),
        cancelHttpWait: Effect.sync(options.cancelHttpWait),
      }),
    ),
  );
}
