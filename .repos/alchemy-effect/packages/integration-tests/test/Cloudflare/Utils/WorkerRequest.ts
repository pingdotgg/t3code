import * as Data from "effect/Data";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import type * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Schedule from "effect/Schedule";

export class WorkerNotPropagated extends Data.TaggedError("WorkerNotPropagated")<{
  readonly url: string;
}> {}

/** The Worker never answered ready `consecutive` times in a row before the timeout. */
export class WorkerNotStable extends Data.TaggedError("WorkerNotStable")<{
  readonly label: string;
  readonly consecutive: number;
}> {}

const isWorkerPlaceholder = (status: number, body: string) =>
  (status === 404 &&
    body.includes("<title>Page not found</title>") &&
    body.includes("There is nothing here yet")) ||
  (status === 500 &&
    body.includes("<title>Script not found |") &&
    body.includes(" | Cloudflare</title>") &&
    body.includes("/cdn-cgi/styles/cf.errors.css"));

/** Retry only Cloudflare's pre-invocation placeholder, never application errors. */
export const requestWorker = (
  request: HttpClientRequest.HttpClientRequest,
  options: { retryDelay?: Duration.Input } = {},
) =>
  HttpClient.execute(request).pipe(
    Effect.flatMap((response) =>
      response.status !== 404 && response.status !== 500
        ? Effect.succeed(response)
        : response.text.pipe(
            Effect.flatMap((body) =>
              isWorkerPlaceholder(response.status, body)
                ? Effect.fail(new WorkerNotPropagated({ url: request.url }))
                : Effect.succeed(response),
            ),
          ),
    ),
    Effect.retry({
      while: (error) => error._tag === "WorkerNotPropagated",
      schedule: Schedule.spaced(options.retryDelay ?? "1 second"),
      times: 8,
    }),
  );

/**
 * Wait until a freshly deployed Worker answers `check` as ready `consecutive`
 * times in a row.
 *
 * Cloudflare rolls a new script version out host by host and exposes no
 * propagation API, so one ready response only proves that one host has it;
 * the next request can still land on a host serving the placeholder or the
 * previous version. `check` returns `false` while the Worker is still
 * propagating (any not-ready answer resets the streak) and fails on a real
 * error, which is never retried.
 */
export const waitUntilStable = <E, R>(
  label: string,
  check: Effect.Effect<boolean, E, R>,
  options: {
    readonly consecutive?: number;
    readonly spacing?: Duration.Input;
    readonly timeout?: Duration.Input;
  } = {},
): Effect.Effect<void, E | WorkerNotStable, R> => {
  const consecutive = options.consecutive ?? 3;
  return Effect.suspend(() => {
    let streak = 0;
    return check.pipe(
      Effect.map((ready) => {
        streak = ready ? streak + 1 : 0;
        return streak >= consecutive;
      }),
      Effect.repeat({
        schedule: Schedule.spaced(options.spacing ?? "1 second"),
        until: (stable) => stable,
      }),
      Effect.asVoid,
      Effect.timeoutOrElse({
        duration: options.timeout ?? "90 seconds",
        orElse: () => Effect.fail(new WorkerNotStable({ label, consecutive })),
      }),
    );
  });
};
