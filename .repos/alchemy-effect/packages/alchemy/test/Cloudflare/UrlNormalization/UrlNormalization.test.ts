import * as Cloudflare from "@/Cloudflare";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import { findZoneByName } from "@/Cloudflare/Zone/lookup";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import * as urlNormalization from "@distilled.cloud/cloudflare/url-normalization";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
const { test } = Test.make({ providers: Cloudflare.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const zoneName =
  process.env.CLOUDFLARE_TEST_DNS_ZONE_NAME ?? "alchemy-test-2.us";

const resolveZoneId = Effect.gen(function* () {
  const { accountId } = yield* yield* CloudflareEnvironment;
  const zone = yield* findZoneByName({ accountId, name: zoneName });
  if (!zone) {
    return yield* Effect.die(
      new Error(`zone "${zoneName}" not found in account`),
    );
  }
  return zone.id;
});

// The scoped API token the test harness mints propagates eventually-
// consistently across Cloudflare's edge — a fresh token intermittently 403s
// with "Unable to authenticate request". Ride out the blips on the test's
// own out-of-band calls by retrying the typed `Forbidden` error (part of
// each url-normalization operation's error union via distilled patches).
const forbiddenRetrySchedule = Schedule.exponential("500 millis");

const getUrlNormalization = (zoneId: string) =>
  urlNormalization.getUrlNormalization({ zoneId }).pipe(
    Effect.retry({
      while: (e) => e._tag === "Forbidden",
      schedule: forbiddenRetrySchedule,
      times: 8,
    }),
  );

// Normalize the singleton to Cloudflare defaults so each run starts from
// the same cloud state regardless of what a previous (possibly interrupted)
// run left behind. DELETE is the API's true reset operation.
const resetToDefaults = (zoneId: string) =>
  urlNormalization.deleteUrlNormalization({ zoneId }).pipe(
    Effect.retry({
      while: (e) => e._tag === "Forbidden",
      schedule: forbiddenRetrySchedule,
      times: 8,
    }),
  );

describe.sequential("UrlNormalization", () => {
  test.provider(
    "configures URL normalization and resets to defaults on destroy",
    (stack) =>
      Effect.gen(function* () {
        const zoneId = yield* resolveZoneId;

        yield* stack.destroy();
        yield* resetToDefaults(zoneId);

        const created = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Cloudflare.UrlNormalization.UrlNormalization(
              "UrlNormalization",
              {
                zoneId,
                scope: "both",
                type: "rfc3986",
              },
            );
          }),
        );

        expect(created.zoneId).toEqual(zoneId);
        expect(created.scope).toEqual("both");
        expect(created.type).toEqual("rfc3986");

        // Out-of-band verification against the live API.
        const live = yield* getUrlNormalization(zoneId);
        expect(live.scope).toEqual("both");
        expect(live.type).toEqual("rfc3986");

        yield* stack.destroy();

        // Destroy issued the true reset op — the zone is back to Cloudflare
        // defaults.
        const reset = yield* getUrlNormalization(zoneId);
        expect(reset.scope).toEqual("incoming");
        expect(reset.type).toEqual("cloudflare");
      }).pipe(logLevel),
  );

  test.provider("updates scope and type in place", (stack) =>
    Effect.gen(function* () {
      const zoneId = yield* resolveZoneId;

      yield* stack.destroy();
      yield* resetToDefaults(zoneId);

      const initial = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.UrlNormalization.UrlNormalization(
            "UrlNormalization",
            {
              zoneId,
              scope: "both",
              type: "rfc3986",
            },
          );
        }),
      );

      expect(initial.scope).toEqual("both");
      expect(initial.type).toEqual("rfc3986");

      // Same singleton updated in place via a full-replace PUT.
      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.UrlNormalization.UrlNormalization(
            "UrlNormalization",
            {
              zoneId,
              scope: "incoming",
              type: "cloudflare",
            },
          );
        }),
      );

      expect(updated.scope).toEqual("incoming");
      expect(updated.type).toEqual("cloudflare");

      const live = yield* getUrlNormalization(zoneId);
      expect(live.scope).toEqual("incoming");
      expect(live.type).toEqual("cloudflare");

      yield* stack.destroy();

      const reset = yield* getUrlNormalization(zoneId);
      expect(reset.scope).toEqual("incoming");
      expect(reset.type).toEqual("cloudflare");
    }).pipe(logLevel),
  );

  test.provider(
    "applies Cloudflare defaults when scope and type are omitted",
    (stack) =>
      Effect.gen(function* () {
        const zoneId = yield* resolveZoneId;

        yield* stack.destroy();
        // Start from a non-default state so the deploy has to converge.
        yield* urlNormalization
          .putUrlNormalization({ zoneId, scope: "none", type: "rfc3986" })
          .pipe(
            Effect.retry({
              while: (e) => e._tag === "Forbidden",
              schedule: forbiddenRetrySchedule,
              times: 8,
            }),
          );

        const created = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Cloudflare.UrlNormalization.UrlNormalization(
              "UrlNormalization",
              {
                zoneId,
              },
            );
          }),
        );

        // Omitted props fall back to Cloudflare's documented defaults.
        expect(created.scope).toEqual("incoming");
        expect(created.type).toEqual("cloudflare");

        const live = yield* getUrlNormalization(zoneId);
        expect(live.scope).toEqual("incoming");
        expect(live.type).toEqual("cloudflare");

        yield* stack.destroy();

        const reset = yield* getUrlNormalization(zoneId);
        expect(reset.scope).toEqual("incoming");
        expect(reset.type).toEqual("cloudflare");
      }).pipe(logLevel),
  );

  // Canonical `list()` test (zone-scoped singleton): there is no account-wide
  // API for this per-zone setting, so `list()` enumerates every zone via
  // `listAllZones` and reads the singleton in each. Assert the result is
  // non-empty and contains the standing test zone.
  test.provider("list enumerates URL normalization across all zones", (stack) =>
    Effect.gen(function* () {
      const zoneId = yield* resolveZoneId;

      const provider = yield* Provider.findProvider(
        Cloudflare.UrlNormalization.UrlNormalization,
      );
      const all = yield* provider.list();

      expect(all.length).toBeGreaterThan(0);
      expect(all.some((s) => s.zoneId === zoneId)).toBe(true);

      // `stack` is unused here (the singleton always exists on every zone),
      // but keep the destroy bookend so the harness state stays clean.
      yield* stack.destroy();
    }).pipe(logLevel),
  );
});
