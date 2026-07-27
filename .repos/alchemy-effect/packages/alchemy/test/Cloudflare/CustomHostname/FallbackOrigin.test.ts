import { adopt } from "@/AdoptPolicy";
import * as Cloudflare from "@/Cloudflare";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import { findZoneByName } from "@/Cloudflare/Zone/lookup";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import * as customHostnames from "@distilled.cloud/cloudflare/custom-hostnames";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: Cloudflare.providers() });

// Cloudflare for SaaS (SSL for SaaS) is NOT provisioned on the test account:
// every fallback-origin API call fails with `SaasAccessNotGranted`
//   (code 1456): "Access to configure this resource has not been granted for
//   this zone. This feature is available with SSL for SaaS."
// Enabling Cloudflare for SaaS is a one-time dashboard action (SSL/TLS →
// Custom Hostnames → Enable) with no public API — verified directly against
// the API: PUT /custom_hostnames/fallback_origin is rejected with the same
// entitlement error. Set CLOUDFLARE_SAAS_ENABLED=1 once the zone is
// provisioned to run these tests.
const saasEnabled = !!process.env.CLOUDFLARE_SAAS_ENABLED;
const testSaas = test.provider.skipIf(!saasEnabled);

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const zoneName =
  process.env.CLOUDFLARE_TEST_DNS_ZONE_NAME ?? "alchemy-test-2.us";

// Deterministic record names for the origin DNS records the fallback origin
// points at (the API requires the origin to be a DNS record in the zone).
const ORIGIN_A = `alchemy-fallback-origin-a.${zoneName}`;
const ORIGIN_B = `alchemy-fallback-origin-b.${zoneName}`;

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
// (typed as `Forbidden` in the distilled unions). Ride out the blips on the
// test's own out-of-band verification calls.
const forbiddenBlips = Schedule.exponential("500 millis");

// Observe the zone's fallback origin out-of-band; `undefined` when it is not
// configured (`FallbackOriginNotFound`) or is mid-deletion.
const observeFallbackOrigin = (zoneId: string) =>
  customHostnames.getFallbackOrigin({ zoneId }).pipe(
    Effect.retry({
      while: (e) => e._tag === "Forbidden",
      schedule: forbiddenBlips,
      times: 8,
    }),
    Effect.map((r) => ({
      origin: r.origin ?? undefined,
      status: r.status ?? undefined,
    })),
    Effect.catchTag("FallbackOriginNotFound", () => Effect.succeed(undefined)),
  );

// Typed entitlement probe: every fallback-origin call on an unprovisioned
// zone is rejected with `SaasAccessNotGranted` (code 1456). When the suite
// is enabled but the zone still lacks the entitlement, fail fast with a
// clear message instead of surfacing raw entitlement errors mid-deploy.
const probeSaasEntitlement = (zoneId: string) =>
  customHostnames.getFallbackOrigin({ zoneId }).pipe(
    Effect.asVoid,
    Effect.retry({
      while: (e) => e._tag === "Forbidden",
      schedule: forbiddenBlips,
      times: 8,
    }),
    Effect.catchTag("FallbackOriginNotFound", () => Effect.void),
    Effect.catchTag("SaasAccessNotGranted", (e) =>
      Effect.die(
        new Error(
          `Cloudflare for SaaS is not provisioned on zone "${zoneName}" — ` +
            `unset CLOUDFLARE_SAAS_ENABLED or enable SSL for SaaS first: ${e.message}`,
        ),
      ),
    ),
  );

const isGone = (
  observed:
    | { origin: string | undefined; status: string | undefined }
    | undefined,
): boolean =>
  observed === undefined ||
  observed.origin === undefined ||
  observed.status === "pending_deletion" ||
  observed.status === "deletion_timed_out";

// Canonical `list()` test (zone-scoped singleton): there is no account-wide
// API for the fallback origin, so `list()` enumerates every zone via
// `listAllZones` and reads the singleton in each, skipping zones without
// Cloudflare for SaaS (`SaasAccessNotGranted` / `Forbidden`). This read-only
// assertion ALWAYS runs — on an unentitled account every zone is skipped and
// the result is a well-typed empty `FallbackOriginAttributes[]`.
test.provider("list enumerates fallback origins across all zones", (stack) =>
  Effect.gen(function* () {
    yield* stack.destroy();

    const provider = yield* Provider.findProvider(
      Cloudflare.CustomHostname.FallbackOrigin,
    );
    const all = yield* provider.list();

    // Well-typed `FallbackOriginAttributes[]`: each element matches the
    // shape `read` produces.
    expect(Array.isArray(all)).toBe(true);
    for (const item of all) {
      expect(typeof item.zoneId).toBe("string");
      expect(typeof item.origin).toBe("string");
    }

    yield* stack.destroy();
  }).pipe(logLevel),
);

// Entitlement-gated: when Cloudflare for SaaS is provisioned, deploy a
// fallback origin and assert `list()` surfaces it. Skipped on the standing
// test account, where every fallback-origin call returns
// `SaasAccessNotGranted` (code 1456).
testSaas(
  "list surfaces a deployed fallback origin",
  (stack) =>
    Effect.gen(function* () {
      const zoneId = yield* resolveZoneId;
      yield* probeSaasEntitlement(zoneId);

      yield* stack.destroy();

      yield* stack.deploy(
        Effect.gen(function* () {
          const record = yield* Cloudflare.DNS.Record("OriginA", {
            zoneId,
            name: ORIGIN_A,
            type: "A",
            content: "203.0.113.50",
            proxied: true,
          }).pipe(adopt(true));
          return yield* Cloudflare.CustomHostname.FallbackOrigin("Fallback", {
            zoneId,
            origin: record.name,
          }).pipe(adopt(true));
        }),
      );

      const provider = yield* Provider.findProvider(
        Cloudflare.CustomHostname.FallbackOrigin,
      );
      const all = yield* provider.list();
      expect(
        all.some((o) => o.zoneId === zoneId && o.origin === ORIGIN_A),
      ).toBe(true);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 300_000 },
);

testSaas(
  "set, update and delete the zone fallback origin",
  (stack) =>
    Effect.gen(function* () {
      const zoneId = yield* resolveZoneId;
      yield* probeSaasEntitlement(zoneId);

      yield* stack.destroy();

      // Create: an origin DNS record plus the fallback origin pointing at it.
      const initial = yield* stack.deploy(
        Effect.gen(function* () {
          const record = yield* Cloudflare.DNS.Record("OriginA", {
            zoneId,
            name: ORIGIN_A,
            type: "A",
            content: "203.0.113.50",
            proxied: true,
          }).pipe(adopt(true));
          const fallback = yield* Cloudflare.CustomHostname.FallbackOrigin(
            "Fallback",
            {
              zoneId,
              origin: record.name,
            },
          ).pipe(adopt(true));
          return { record, fallback };
        }),
      );

      expect(initial.fallback.zoneId).toEqual(zoneId);
      expect(initial.fallback.origin).toEqual(ORIGIN_A);
      expect(initial.fallback.status).toBeDefined();

      const liveA = yield* observeFallbackOrigin(zoneId);
      expect(liveA?.origin).toEqual(ORIGIN_A);

      // Re-deploying the same desired state is a no-op.
      const again = yield* stack.deploy(
        Effect.gen(function* () {
          const record = yield* Cloudflare.DNS.Record("OriginA", {
            zoneId,
            name: ORIGIN_A,
            type: "A",
            content: "203.0.113.50",
            proxied: true,
          }).pipe(adopt(true));
          const fallback = yield* Cloudflare.CustomHostname.FallbackOrigin(
            "Fallback",
            {
              zoneId,
              origin: record.name,
            },
          ).pipe(adopt(true));
          return { record, fallback };
        }),
      );
      expect(again.fallback.origin).toEqual(ORIGIN_A);

      // Update: point at a different origin record (PUT is an upsert — the
      // singleton is updated in place).
      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const record = yield* Cloudflare.DNS.Record("OriginB", {
            zoneId,
            name: ORIGIN_B,
            type: "A",
            content: "203.0.113.51",
            proxied: true,
          }).pipe(adopt(true));
          const fallback = yield* Cloudflare.CustomHostname.FallbackOrigin(
            "Fallback",
            {
              zoneId,
              origin: record.name,
            },
          ).pipe(adopt(true));
          return { record, fallback };
        }),
      );

      expect(updated.fallback.origin).toEqual(ORIGIN_B);

      const liveB = yield* observeFallbackOrigin(zoneId);
      expect(liveB?.origin).toEqual(ORIGIN_B);

      yield* stack.destroy();

      // Deletion is asynchronous — poll (bounded) until the fallback origin
      // is gone or mid-deletion.
      const gone = yield* observeFallbackOrigin(zoneId).pipe(
        Effect.repeat({
          schedule: Schedule.spaced("3 seconds"),
          until: isGone,
          times: 20,
        }),
      );
      expect(isGone(gone)).toBe(true);
    }).pipe(logLevel),
  { timeout: 300_000 },
);
