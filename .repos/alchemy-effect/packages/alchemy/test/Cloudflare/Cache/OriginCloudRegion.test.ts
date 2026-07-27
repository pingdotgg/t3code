import * as Cloudflare from "@/Cloudflare";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import { findZoneByName } from "@/Cloudflare/Zone/lookup";
import * as Test from "@/Test/Alchemy";
import * as cache from "@distilled.cloud/cloudflare/cache";
import { expect } from "alchemy-test";
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
// consistently across Cloudflare's edge — a fresh token intermittently 403s.
const forbiddenRetrySchedule = Schedule.exponential("500 millis");

/**
 * Probe the origin_cloud_regions API. As of 2026-06 the endpoint exists in
 * the Cloudflare TypeScript SDK spec but is not yet routed on the public
 * API — every call answers HTTP 400 with codes 7003/7000 ("No route for
 * that URI"), surfaced as the typed `InvalidRoute` error. The probe maps
 * that to "unreleased" so the lifecycle test self-enables the moment
 * Cloudflare ships the route.
 */
const probeAvailability = (zoneId: string) =>
  cache.listOriginCloudRegions({ zoneId }).pipe(
    Effect.map(() => "available" as const),
    Effect.catchTag("InvalidRoute", () =>
      Effect.succeed("unreleased" as const),
    ),
    Effect.retry({
      while: (e) => e._tag === "Forbidden",
      schedule: forbiddenRetrySchedule,
      times: 8,
    }),
  );

/** Observe a single mapping out-of-band, `undefined` when gone (typed). */
const getMapping = (zoneId: string, ip: string) =>
  cache.getOriginCloudRegion({ zoneId, originIP: ip }).pipe(
    Effect.catchTag("OriginCloudRegionNotFound", () =>
      Effect.succeed(undefined),
    ),
    Effect.retry({
      while: (e) => e._tag === "Forbidden",
      schedule: forbiddenRetrySchedule,
      times: 8,
    }),
  );

test.provider(
  "creates, updates in place, replaces on ip change, and deletes the mapping",
  (stack) =>
    Effect.gen(function* () {
      const zoneId = yield* resolveZoneId;

      // The endpoint is in the vendor spec but not yet deployed on the
      // public API. When unreleased, the typed `InvalidRoute` is the whole
      // observable behavior — assert it and stop. The lifecycle below runs
      // automatically once Cloudflare routes the endpoint.
      const availability = yield* probeAvailability(zoneId);
      if (availability === "unreleased") {
        yield* Effect.logInfo(
          "origin_cloud_regions API not yet routed (typed InvalidRoute) — skipping lifecycle",
        );
        return;
      }

      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.Cache.OriginCloudRegion("ApiOrigin", {
            zoneId,
            ip: "192.0.2.10",
            vendor: "aws",
            region: "us-east-1",
          });
        }),
      );
      expect(created.zoneId).toEqual(zoneId);
      expect(created.originIp).toEqual("192.0.2.10");
      expect(created.vendor).toEqual("aws");
      expect(created.region).toEqual("us-east-1");

      // Out-of-band verification via the distilled API.
      const live = yield* getMapping(zoneId, "192.0.2.10");
      expect(live).toBeDefined();
      expect(live!.vendor).toEqual("aws");
      expect(live!.region).toEqual("us-east-1");

      // Update in place — vendor/region are mutable; the IP identity holds.
      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.Cache.OriginCloudRegion("ApiOrigin", {
            zoneId,
            ip: "192.0.2.10",
            vendor: "aws",
            region: "eu-west-1",
          });
        }),
      );
      expect(updated.originIp).toEqual("192.0.2.10");
      expect(updated.region).toEqual("eu-west-1");

      const liveUpdated = yield* getMapping(zoneId, "192.0.2.10");
      expect(liveUpdated!.region).toEqual("eu-west-1");

      // Replacement — the IP is the mapping's identity; the old mapping
      // must be gone and the new one present.
      const replaced = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.Cache.OriginCloudRegion("ApiOrigin", {
            zoneId,
            ip: "192.0.2.20",
            vendor: "aws",
            region: "eu-west-1",
          });
        }),
      );
      expect(replaced.originIp).toEqual("192.0.2.20");

      const oldGone = yield* getMapping(zoneId, "192.0.2.10");
      expect(oldGone).toBeUndefined();
      const newLive = yield* getMapping(zoneId, "192.0.2.20");
      expect(newLive).toBeDefined();

      yield* stack.destroy();

      // Destroy removed the mapping — observed via the typed
      // `OriginCloudRegionNotFound` error (mapped to `undefined`).
      const gone = yield* getMapping(zoneId, "192.0.2.20");
      expect(gone).toBeUndefined();
    }).pipe(logLevel),
  { timeout: 120_000 },
);
