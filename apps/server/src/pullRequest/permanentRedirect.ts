import { parseChangeRequestUrl } from "@t3tools/shared/changeRequestUrl";
import * as Effect from "effect/Effect";
import { FetchHttpClient, HttpClient } from "effect/http";

/** Resolve only permanent PR/MR moves, without following sign-in redirects or sending credentials. */
export const resolvePermanentPullRequestRedirect = Effect.fn("resolvePermanentPullRequestRedirect")(
  function* (url: string) {
    if (parseChangeRequestUrl(url) === null) return url;
    const client = yield* HttpClient.HttpClient;
    let current = url;
    const seen = new Set([url]);
    for (let hop = 0; hop < 5; hop++) {
      const response = yield* client.head(current);
      const location = response.headers.location;
      if ((response.status !== 301 && response.status !== 308) || location === undefined) break;
      const next = yield* Effect.try(() => new URL(location, current));
      if (
        next.username ||
        next.password ||
        parseChangeRequestUrl(next.href) === null ||
        seen.has(next.href)
      )
        break;
      seen.add(next.href);
      current = next.href;
    }
    return current;
  },
  Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual", credentials: "omit" }),
  Effect.provide(FetchHttpClient.layer),
  Effect.timeout("5 seconds"),
  (effect, url) => effect.pipe(Effect.catch(() => Effect.succeed(url))),
);
