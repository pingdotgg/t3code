import { cacheUntilExpiry } from "@/Cloudflare/Credentials";
import {
  apiTokenCredentials,
  oauthCredentials,
  type ResolvedCredentials,
} from "@distilled.cloud/cloudflare/Credentials";
import { describe, expect, it } from "alchemy-test";
import * as Effect from "effect/Effect";

/**
 * Regression spec for "alchemy dev breaks once the Cloudflare OAuth access
 * token expires": `fromAuthProvider` used to memoize the first credential
 * resolution forever (`Effect.cached`), so when the remote-bindings preview
 * session needed refreshing hours into a dev session, the preview-session
 * API was called with the long-dead access token and every remote binding
 * failed until the process was restarted.
 *
 * `cacheUntilExpiry` is the replacement: cache while valid, re-resolve
 * (which refreshes + persists the token) once the refresh window is
 * reached, single-flight under concurrency.
 */

const MINUTE_MS = 60_000;

const makeOAuthResolver = (clock: { now: number }) => {
  let resolutions = 0;
  const resolve = Effect.sync(() => {
    resolutions++;
    return oauthCredentials({
      accessToken: `token-${resolutions}`,
      // each freshly resolved token is valid for 1 hour from "now"
      expiresAt: clock.now + 60 * MINUTE_MS,
    }) as ResolvedCredentials;
  });
  return { resolve, count: () => resolutions };
};

describe("Cloudflare Credentials cacheUntilExpiry", () => {
  it.effect("caches OAuth credentials while they are valid", () =>
    Effect.gen(function* () {
      const clock = { now: 0 };
      const resolver = makeOAuthResolver(clock);
      const credentials = cacheUntilExpiry(resolver.resolve, () => clock.now);

      const first = yield* credentials;
      clock.now += 10 * MINUTE_MS;
      const second = yield* credentials;

      expect(resolver.count()).toBe(1);
      expect(second).toBe(first);
    }),
  );

  it.effect(
    "re-resolves OAuth credentials once the refresh window is reached",
    () =>
      Effect.gen(function* () {
        const clock = { now: 0 };
        const resolver = makeOAuthResolver(clock);
        const credentials = cacheUntilExpiry(resolver.resolve, () => clock.now);

        const first = yield* credentials;
        expect(first.type).toBe("oauth");

        // 56 minutes in: inside the 5-minute refresh window of the 1h token.
        clock.now += 56 * MINUTE_MS;
        const second = yield* credentials;

        expect(resolver.count()).toBe(2);
        expect(second).not.toBe(first);

        // The re-resolved token is cached again in turn.
        clock.now += 10 * MINUTE_MS;
        const third = yield* credentials;
        expect(resolver.count()).toBe(2);
        expect(third).toBe(second);
      }),
  );

  it.effect(
    "re-resolves OAuth credentials that are already fully expired",
    () =>
      Effect.gen(function* () {
        const clock = { now: 0 };
        const resolver = makeOAuthResolver(clock);
        const credentials = cacheUntilExpiry(resolver.resolve, () => clock.now);

        yield* credentials;
        // The machine slept through the token's entire lifetime.
        clock.now += 6 * 60 * MINUTE_MS;
        yield* credentials;

        expect(resolver.count()).toBe(2);
      }),
  );

  it.effect("caches non-expiring credentials (api tokens) forever", () =>
    Effect.gen(function* () {
      const clock = { now: 0 };
      let resolutions = 0;
      const resolve = Effect.sync(() => {
        resolutions++;
        return apiTokenCredentials({
          apiToken: "static",
        }) as ResolvedCredentials;
      });
      const credentials = cacheUntilExpiry(resolve, () => clock.now);

      yield* credentials;
      clock.now += 365 * 24 * 60 * MINUTE_MS;
      yield* credentials;

      expect(resolutions).toBe(1);
    }),
  );

  it.live("concurrent cold-cache resolutions are single-flight", () =>
    Effect.gen(function* () {
      const clock = { now: 0 };
      let resolutions = 0;
      const resolve = Effect.sleep("20 millis").pipe(
        Effect.map(() => {
          resolutions++;
          return oauthCredentials({
            accessToken: `token-${resolutions}`,
            expiresAt: clock.now + 60 * MINUTE_MS,
          }) as ResolvedCredentials;
        }),
      );
      const credentials = cacheUntilExpiry(resolve, () => clock.now);

      const results = yield* Effect.all(
        [credentials, credentials, credentials, credentials],
        { concurrency: "unbounded" },
      );

      expect(resolutions).toBe(1);
      for (const result of results) {
        expect(result).toBe(results[0]);
      }
    }),
  );
});
