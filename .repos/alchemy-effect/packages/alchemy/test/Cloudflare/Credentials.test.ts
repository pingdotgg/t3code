import { cacheUntilExpiry } from "@/Cloudflare/Credentials";
import {
  apiTokenCredentials,
  oauthCredentials,
  type ResolvedCredentials,
} from "@distilled.cloud/cloudflare/Credentials";
import { describe, expect, it } from "alchemy-test";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";

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

const makeOAuthResolver = () => {
  let resolutions = 0;
  const resolve = Effect.gen(function* () {
    resolutions++;
    const now = yield* Clock.currentTimeMillis;
    return oauthCredentials({
      accessToken: `token-${resolutions}`,
      // each freshly resolved token is valid for 1 hour from "now"
      expiresAt: now + 60 * MINUTE_MS,
    }) as ResolvedCredentials;
  });
  return { resolve, count: () => resolutions };
};

describe("Cloudflare Credentials cacheUntilExpiry", () => {
  it.effect("caches OAuth credentials while they are valid", () =>
    Effect.gen(function* () {
      const resolver = makeOAuthResolver();
      const credentials = yield* cacheUntilExpiry(resolver.resolve);

      const first = yield* credentials;
      yield* TestClock.adjust(Duration.minutes(10));
      const second = yield* credentials;

      expect(resolver.count()).toBe(1);
      expect(second).toBe(first);
    }),
  );

  it.effect(
    "re-resolves OAuth credentials once the refresh window is reached",
    () =>
      Effect.gen(function* () {
        const resolver = makeOAuthResolver();
        const credentials = yield* cacheUntilExpiry(resolver.resolve);

        const first = yield* credentials;
        expect(first.type).toBe("oauth");

        // 56 minutes in: inside the 5-minute refresh window of the 1h token.
        yield* TestClock.adjust(Duration.minutes(56));
        const second = yield* credentials;

        expect(resolver.count()).toBe(2);
        expect(second).not.toBe(first);

        // The re-resolved token is cached again in turn.
        yield* TestClock.adjust(Duration.minutes(10));
        const third = yield* credentials;
        expect(resolver.count()).toBe(2);
        expect(third).toBe(second);
      }),
  );

  it.effect(
    "re-resolves OAuth credentials that are already fully expired",
    () =>
      Effect.gen(function* () {
        const resolver = makeOAuthResolver();
        const credentials = yield* cacheUntilExpiry(resolver.resolve);

        yield* credentials;
        // The machine slept through the token's entire lifetime.
        yield* TestClock.adjust(Duration.hours(6));
        yield* credentials;

        expect(resolver.count()).toBe(2);
      }),
  );

  it.effect("caches non-expiring credentials (api tokens) forever", () =>
    Effect.gen(function* () {
      let resolutions = 0;
      const resolve = Effect.sync(() => {
        resolutions++;
        return apiTokenCredentials({
          apiToken: "static",
        }) as ResolvedCredentials;
      });
      const credentials = yield* cacheUntilExpiry(resolve);

      yield* credentials;
      yield* TestClock.adjust(Duration.days(365));
      yield* credentials;

      expect(resolutions).toBe(1);
    }),
  );

  it.live("concurrent cold-cache resolutions are single-flight", () =>
    Effect.gen(function* () {
      let resolutions = 0;
      const resolve = Effect.sleep("20 millis").pipe(
        Effect.map(() => {
          resolutions++;
          return oauthCredentials({
            accessToken: `token-${resolutions}`,
            expiresAt: Date.now() + 60 * MINUTE_MS,
          }) as ResolvedCredentials;
        }),
      );
      const credentials = yield* cacheUntilExpiry(resolve);

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
