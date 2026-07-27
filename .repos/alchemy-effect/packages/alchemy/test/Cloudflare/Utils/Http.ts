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

export class HttpMarkerPresent extends Data.TaggedError("HttpMarkerPresent")<{
  url: string;
  marker: string;
  bodyExcerpt: string;
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
      schedule: Schedule.min([
        Schedule.exponential(initial, 1.5),
        Schedule.spaced("8 seconds"),
      ]),
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

export class HttpResponseMismatch extends Data.TaggedError(
  "HttpResponseMismatch",
)<{
  url: string;
  expected: string;
  actual: string;
}> {}

const fetchOnceResponse = (
  url: string,
  check: (res: Response) => HttpResponseMismatch | undefined,
) =>
  Effect.tryPromise({
    try: async (signal) => {
      const u = new URL(url);
      u.searchParams.set("__alchemy_cb", String(Date.now()));
      const res = await fetch(u, {
        signal,
        cache: "no-store",
        redirect: "manual",
        headers: {
          "cache-control": "no-cache",
          pragma: "no-cache",
          accept: "*/*",
        },
      });
      const mismatch = check(res);
      if (mismatch) {
        throw mismatch;
      }
      return res;
    },
    catch: (e) =>
      e instanceof HttpResponseMismatch
        ? e
        : new HttpFetchFailed({
            url,
            message: e instanceof Error ? e.message : String(e),
          }),
  });

const retryResponse = (
  url: string,
  expected: string,
  effect: Effect.Effect<Response, HttpResponseMismatch | HttpFetchFailed>,
  options: ExpectUrlContainsOptions,
) => {
  const totalTimeout = Duration.fromInputUnsafe(
    options.timeout ?? "90 seconds",
  );
  const initial = options.initialBackoff ?? "750 millis";
  const label = options.label ?? "url";
  return effect.pipe(
    Effect.retry({
      schedule: Schedule.min([
        Schedule.exponential(initial, 1.5),
        Schedule.spaced("8 seconds"),
      ]),
    }),
    Effect.timeoutOrElse({
      duration: totalTimeout,
      orElse: () =>
        Effect.fail(
          new HttpResponseMismatch({
            url,
            expected,
            actual: `[timed out after ${Duration.toMillis(totalTimeout)}ms waiting for ${expected}]`,
          }),
        ),
    }),
    Effect.tapError((error) =>
      Effect.logError(`expect response (${label}) failed`, error),
    ),
  );
};

/**
 * Fetch `url` without following redirects and assert the response is a
 * redirect to `location` (with `status`, default 301). Retries through
 * deploy propagation like {@link expectUrlContains}.
 */
export const expectUrlRedirect = (
  url: string,
  location: string,
  options: ExpectUrlContainsOptions & { status?: number } = {},
) => {
  const status = options.status ?? 301;
  const expected = `${status} -> ${location}`;
  return retryResponse(
    url,
    expected,
    fetchOnceResponse(url, (res) => {
      // Cloudflare appends the request's query string to the Location
      // header, so compare pathnames rather than the raw value.
      const actual = res.headers.get("location");
      const actualPath = actual === null ? null : new URL(actual, url).pathname;
      return res.status === status && actualPath === location
        ? undefined
        : new HttpResponseMismatch({
            url,
            expected,
            actual: `${res.status} -> ${actual}`,
          });
    }),
    options,
  );
};

/**
 * Fetch `url` and assert response header `header` equals `value`.
 * Retries through deploy propagation like {@link expectUrlContains}.
 */
export const expectUrlHeader = (
  url: string,
  header: string,
  value: string,
  options: ExpectUrlContainsOptions = {},
) => {
  const expected = `${header}: ${value}`;
  return retryResponse(
    url,
    expected,
    fetchOnceResponse(url, (res) =>
      res.headers.get(header) === value
        ? undefined
        : new HttpResponseMismatch({
            url,
            expected,
            actual: `${res.status} ${header}: ${res.headers.get(header)}`,
          }),
    ),
    options,
  );
};

const fetchOnceAbsent = (url: string, marker: string) =>
  Effect.tryPromise({
    try: async (signal) => {
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
      if (body.includes(marker)) {
        throw new HttpMarkerPresent({
          url,
          marker,
          bodyExcerpt: body.slice(0, 240),
        });
      }
      return body;
    },
    catch: (e) =>
      e instanceof HttpMarkerPresent
        ? e
        : new HttpFetchFailed({
            url,
            message: e instanceof Error ? e.message : String(e),
          }),
  });

/**
 * Fetch `url` and assert the response body does *not* contain `marker`.
 * Retries while the marker is still present so a briefly-overbroad route
 * fails loudly instead of slipping through on the first fetch.
 */
export const expectUrlAbsent = (
  url: string,
  marker: string,
  options: ExpectUrlContainsOptions = {},
) => {
  const totalTimeout = Duration.fromInputUnsafe(
    options.timeout ?? "90 seconds",
  );
  const initial = options.initialBackoff ?? "750 millis";
  const label = options.label ?? "url";

  return fetchOnceAbsent(url, marker).pipe(
    Effect.retry({
      schedule: Schedule.min([
        Schedule.exponential(initial, 1.5),
        Schedule.spaced("8 seconds"),
      ]),
    }),
    Effect.timeoutOrElse({
      duration: totalTimeout,
      orElse: () =>
        Effect.fail(
          new HttpMarkerPresent({
            url,
            marker,
            bodyExcerpt: `[timed out after ${Duration.toMillis(totalTimeout)}ms waiting for marker "${marker}" to disappear]`,
          }),
        ),
    }),
    Effect.tapError((error) =>
      Effect.logError(`expectUrlAbsent(${label}) failed`, error),
    ),
  );
};
