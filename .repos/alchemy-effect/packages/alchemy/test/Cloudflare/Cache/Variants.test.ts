import * as Cloudflare from "@/Cloudflare";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import { findZoneByName } from "@/Cloudflare/Zone/lookup";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import * as cache from "@distilled.cloud/cloudflare/cache";
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
// consistently across Cloudflare's edge — a fresh token intermittently rejects
// requests with `403 Forbidden` OR `401 Unauthorized` until it has propagated.
// Ride out the blips on the test's own out-of-band calls by retrying both typed
// auth errors (part of each cache operation's error union via distilled patches).
const tokenPropagationRetrySchedule = Schedule.exponential("500 millis");
const isTokenPropagationError = (e: { _tag: string }) =>
  e._tag === "Forbidden" || e._tag === "Unauthorized";

/**
 * Observe the live setting: the configured value, or `undefined` when the
 * setting does not exist (typed `VariantsNotConfigured`).
 */
const getVariants = (zoneId: string) =>
  cache.getVariant({ zoneId }).pipe(
    Effect.catchTag("VariantsNotConfigured", () => Effect.succeed(undefined)),
    Effect.retry({
      while: isTokenPropagationError,
      schedule: tokenPropagationRetrySchedule,
      times: 8,
    }),
  );

// Normalize to a known baseline: the setting deleted (zone default).
const resetBaseline = (zoneId: string) =>
  cache.deleteVariant({ zoneId }).pipe(
    Effect.catchTag("VariantsNotConfigured", () => Effect.succeed(undefined)),
    Effect.retry({
      while: isTokenPropagationError,
      schedule: tokenPropagationRetrySchedule,
      times: 8,
    }),
  );

describe.sequential("Variants", () => {
  test.provider(
    "creates, updates in place, and deletes the variants setting",
    (stack) =>
      Effect.gen(function* () {
        const zoneId = yield* resolveZoneId;

        yield* stack.destroy();
        // Known baseline: the setting does not exist.
        yield* resetBaseline(zoneId);

        const created = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Cloudflare.Cache.Variants("ImageVariants", {
              zoneId,
              jpeg: ["image/webp"],
            });
          }),
        );

        expect(created.zoneId).toEqual(zoneId);
        expect(created.value).toEqual({ jpeg: ["image/webp"] });
        expect(created.editable).toEqual(true);

        // Out-of-band verification via the distilled API.
        const live = yield* getVariants(zoneId);
        expect(live).toBeDefined();
        expect(live!.value.jpeg).toEqual(["image/webp"]);

        // Update in place — PATCH replaces the full value object.
        const updated = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Cloudflare.Cache.Variants("ImageVariants", {
              zoneId,
              jpeg: ["image/webp", "image/avif"],
              png: ["image/webp"],
            });
          }),
        );

        expect(updated.value).toEqual({
          jpeg: ["image/webp", "image/avif"],
          png: ["image/webp"],
        });

        const liveUpdated = yield* getVariants(zoneId);
        expect(liveUpdated!.value.jpeg).toEqual(["image/webp", "image/avif"]);
        expect(liveUpdated!.value.png).toEqual(["image/webp"]);

        // Removing an extension from props unsets it (full replace).
        const narrowed = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Cloudflare.Cache.Variants("ImageVariants", {
              zoneId,
              png: ["image/avif"],
            });
          }),
        );

        expect(narrowed.value).toEqual({ png: ["image/avif"] });
        const liveNarrowed = yield* getVariants(zoneId);
        expect(liveNarrowed!.value.jpeg ?? undefined).toBeUndefined();
        expect(liveNarrowed!.value.png).toEqual(["image/avif"]);

        yield* stack.destroy();

        // Destroy removed the setting entirely — observed via the typed
        // `VariantsNotConfigured` error (mapped to `undefined`).
        const gone = yield* getVariants(zoneId);
        expect(gone).toBeUndefined();
      }).pipe(logLevel),
  );

  test.provider(
    "deploy is idempotent and converges out-of-band drift",
    (stack) =>
      Effect.gen(function* () {
        const zoneId = yield* resolveZoneId;

        yield* stack.destroy();
        yield* resetBaseline(zoneId);

        const created = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Cloudflare.Cache.Variants("ImageVariants", {
              zoneId,
              webp: ["image/avif"],
            });
          }),
        );
        expect(created.value).toEqual({ webp: ["image/avif"] });

        // Drift the setting out-of-band. The next reconcile (triggered by a
        // prop change) observes the live cloud state and replaces the full
        // value — the drifted `gif` entry must not survive.
        yield* cache
          .patchVariant({ zoneId, value: { gif: ["image/webp"] } })
          .pipe(
            Effect.retry({
              while: isTokenPropagationError,
              schedule: tokenPropagationRetrySchedule,
              times: 8,
            }),
          );

        const converged = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Cloudflare.Cache.Variants("ImageVariants", {
              zoneId,
              webp: ["image/avif"],
              tiff: ["image/webp"],
            });
          }),
        );
        expect(converged.value).toEqual({
          tiff: ["image/webp"],
          webp: ["image/avif"],
        });

        const live = yield* getVariants(zoneId);
        expect(live!.value.webp).toEqual(["image/avif"]);
        expect(live!.value.tiff).toEqual(["image/webp"]);
        expect(live!.value.gif ?? undefined).toBeUndefined();

        yield* stack.destroy();

        const gone = yield* getVariants(zoneId);
        expect(gone).toBeUndefined();
      }).pipe(logLevel),
  );

  // Canonical `list()` test (zone-scoped singleton with create/delete
  // semantics): there is no account-wide API, so `list()` enumerates every
  // zone via `listAllZones` and reads the setting in each, skipping zones
  // where it was never configured. Deploy the setting on the standing test
  // zone first so it appears in the enumeration, then assert it is present.
  test.provider("list enumerates the configured variants settings", (stack) =>
    Effect.gen(function* () {
      const zoneId = yield* resolveZoneId;

      yield* stack.destroy();
      yield* resetBaseline(zoneId);

      yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.Cache.Variants("ImageVariants", {
            zoneId,
            jpeg: ["image/webp"],
          });
        }),
      );

      const provider = yield* Provider.findProvider(Cloudflare.Cache.Variants);
      // `list()` enumerates every zone with the freshly-minted scoped token,
      // which propagates eventually-consistently and intermittently returns
      // `401 Unauthorized` / `403 Forbidden` — ride those blips out too.
      const all = yield* provider.list().pipe(
        Effect.retry({
          while: isTokenPropagationError,
          schedule: tokenPropagationRetrySchedule,
          times: 8,
        }),
      );

      expect(all.length).toBeGreaterThan(0);
      const entry = all.find((v) => v.zoneId === zoneId);
      expect(entry).toBeDefined();
      expect(entry!.value.jpeg).toEqual(["image/webp"]);

      yield* stack.destroy();
    }).pipe(logLevel),
  );
});
