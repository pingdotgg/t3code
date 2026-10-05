import * as Data from "effect/Data";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/http/HttpClient";
import type * as HttpClientRequest from "effect/http/HttpClientRequest";

class WorkerNotPropagated extends Data.TaggedError("WorkerNotPropagated")<{
  readonly url: string;
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
