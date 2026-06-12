import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

/**
 * HTTP assertion helpers tuned for Cloudflare's "deploy → propagate →
 * serve" pipeline.
 *
 * Newly-deployed workers.dev URLs commonly:
 *  - Return Cloudflare's "There is nothing here yet" placeholder page
 *    while the workers.dev subdomain is enabling for the first time.
 *  - Serve a stale cached body for a few seconds after the version flip.
 *  - Briefly 522 / 530 while the edge fetches the new version.
 *
 * The helpers here retry through all of those failure modes with an
 * exponential backoff capped by an explicit total `timeout`, while
 * still surfacing a precise, actionable error if the budget is
 * exhausted.
 */

export class HttpAssertionFailed extends Data.TaggedError(
  "HttpAssertionFailed",
)<{
  url: string;
  marker: string;
  status: number;
  bodyExcerpt: string;
}> {}

export class HttpFetchFailed extends Data.TaggedError("HttpFetchFailed")<{
  url: string;
  message: string;
}> {}

export interface ExpectUrlContainsOptions {
  /** Maximum total time to retry before failing. Default 90s. */
  timeout?: Duration.Input;
  /** Initial backoff between attempts. Default 750ms. */
  initialBackoff?: Duration.Input;
  /** Description used in error messages. */
  label?: string;
}

const looksLikeCloudflarePlaceholder = (body: string) =>
  // Cloudflare's "no worker / not propagated" landing page.
  body.includes("There is nothing here yet") ||
  // The blue 522 / 1xxx error page family.
  /Error\s+\d{3,4}/i.test(body);

const fetchOnce = (url: string, marker: string) =>
  Effect.tryPromise({
    try: async (signal) => {
      // Cache-busting query string defeats both edge caches and any
      // intermediate proxy that ignores `cache-control: no-cache`.
      const u = new URL(url);
      u.searchParams.set("__alchemy_cb", String(Date.now()));
      const res = await fetch(u, {
        signal,
        cache: "no-store",
        headers: {
          "cache-control": "no-cache",
          pragma: "no-cache",
          accept: "*/*",
        },
      });
      const body = await res.text();
      if (
        !res.ok ||
        looksLikeCloudflarePlaceholder(body) ||
        !body.includes(marker)
      ) {
        throw new HttpAssertionFailed({
          url,
          marker,
          status: res.status,
          bodyExcerpt: body.slice(0, 240),
        });
      }
      return body;
    },
    catch: (e) =>
      e instanceof HttpAssertionFailed
        ? e
        : new HttpFetchFailed({
            url,
            message: e instanceof Error ? e.message : String(e),
          }),
  });

/**
 * Fetch `url` and assert the response body contains `marker`. Retries
 * the fetch on transient failures (network errors, 5xx, Cloudflare
 * placeholders, missing marker) until the marker appears or the
 * `timeout` elapses. Each attempt uses a fresh cache-busting query
 * param and `cache: "no-store"` so we don't sit on a CDN-cached body.
 *
 * The hash assertions in the deploy tests prove the *intent* to
 * publish; this helper proves the assets actually serve over HTTP.
 */
export const expectUrlContains = (
  url: string,
  marker: string,
  options: ExpectUrlContainsOptions = {},
) => {
  const totalTimeout = Duration.fromInputUnsafe(
    options.timeout ?? "90 seconds",
  );
  const initial = options.initialBackoff ?? "750 millis";
  const label = options.label ?? "url";

  return fetchOnce(url, marker).pipe(
    Effect.retry({
      // Cap individual sleeps at 8s so very long timeouts still
      // sample at a reasonable rate near the end of the budget.
      schedule: Schedule.exponential(initial, 1.5).pipe(
        Schedule.either(Schedule.spaced("8 seconds")),
      ),
    }),
    // Bound the *total* retry budget. `Effect.retry` on its own would
    // back off forever; the timeout guarantees the test fails loudly
    // instead of stalling out the suite. We swap the default
    // `TimeoutException` for a typed assertion error so the failure
    // message says *what* we were waiting for, not just "timed out".
    Effect.timeoutOrElse({
      duration: totalTimeout,
      orElse: () =>
        Effect.fail(
          new HttpAssertionFailed({
            url,
            marker,
            status: 0,
            bodyExcerpt: `[timed out after ${Duration.toMillis(totalTimeout)}ms waiting for marker "${marker}"]`,
          }),
        ),
    }),
    Effect.tapError((error) =>
      Effect.logError(`expectUrlContains(${label}) failed`, error),
    ),
  );
};
