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
import * as Stream from "effect/Stream";

const { test } = Test.make({ providers: Cloudflare.providers() });

// Cloudflare for SaaS (SSL for SaaS) is NOT provisioned on the test account:
// every custom-hostnames API call fails with `SaasQuotaNotAllocated`
//   (code 1404): "No quota has been allocated for this zone or for this
//   account. If you're already a paid SSL for SaaS customer, please contact
//   your Customer Success Manager for additional provisioning. ..."
// Enabling Cloudflare for SaaS is a one-time dashboard action (SSL/TLS →
// Custom Hostnames → Enable) with no public API — verified directly against
// the API: POST /custom_hostnames and PUT /custom_hostnames/fallback_origin
// are both rejected with the same entitlement errors. Set
// CLOUDFLARE_SAAS_ENABLED=1 once the zone is provisioned to run these tests.
const saasEnabled = !!process.env.CLOUDFLARE_SAAS_ENABLED;
const testSaas = test.provider.skipIf(!saasEnabled);

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const zoneName =
  process.env.CLOUDFLARE_TEST_DNS_ZONE_NAME ?? "alchemy-test-2.us";

// Deterministic per-test hostnames on a domain we do not control — the
// hostnames stay `pending` forever, which is fine: CRUD is still fully
// exercisable. Each test owns a disjoint hostname so reruns and parallel
// runs never collide (never derive names from Date.now()/random).
const HOST_DEFAULT = "alchemy-ch-default.alchemy-saas-example.com";
const HOST_UPDATE = "alchemy-ch-update.alchemy-saas-example.com";
const HOST_REPLACE_A = "alchemy-ch-replace-a.alchemy-saas-example.com";
const HOST_REPLACE_B = "alchemy-ch-replace-b.alchemy-saas-example.com";

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
// test's own out-of-band verification calls. Inlined at each call site so the
// retry predicate is checked against the operation's inferred error union.
const forbiddenBlips = Schedule.exponential("500 millis");

const findByHostname = (zoneId: string, hostname: string) =>
  customHostnames.listCustomHostnames
    .items({ zoneId, hostname: { contain: hostname } })
    .pipe(
      Stream.filter((h) => h.hostname === hostname),
      Stream.runCollect,
      Effect.map((chunk) => Array.from(chunk)[0]),
      Effect.retry({
        while: (e) => e._tag === "Forbidden",
        schedule: forbiddenBlips,
        times: 8,
      }),
    );

const getHostname = (zoneId: string, customHostnameId: string) =>
  customHostnames.getCustomHostname({ zoneId, customHostnameId }).pipe(
    Effect.retry({
      while: (e) => e._tag === "Forbidden",
      schedule: forbiddenBlips,
      times: 8,
    }),
  );

// Typed entitlement probe: every custom-hostnames call on an unprovisioned
// zone is rejected with `SaasQuotaNotAllocated` (code 1404). When the suite
// is enabled but the zone still lacks the entitlement, fail fast with a
// clear message instead of surfacing raw entitlement errors mid-deploy.
const probeSaasEntitlement = (zoneId: string) =>
  customHostnames.listCustomHostnames.items({ zoneId }).pipe(
    Stream.runDrain,
    Effect.retry({
      while: (e) => e._tag === "Forbidden",
      schedule: forbiddenBlips,
      times: 8,
    }),
    Effect.catchTag("SaasQuotaNotAllocated", (e) =>
      Effect.die(
        new Error(
          `Cloudflare for SaaS is not provisioned on zone "${zoneName}" — ` +
            `unset CLOUDFLARE_SAAS_ENABLED or enable SSL for SaaS first: ${e.message}`,
        ),
      ),
    ),
  );

testSaas(
  "create and delete a custom hostname with default ssl",
  (stack) =>
    Effect.gen(function* () {
      const zoneId = yield* resolveZoneId;
      yield* probeSaasEntitlement(zoneId);

      yield* stack.destroy();

      const hostname = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.CustomHostname.CustomHostname("Default", {
            zoneId,
            hostname: HOST_DEFAULT,
          }).pipe(adopt(true));
        }),
      );

      expect(hostname.customHostnameId).toBeDefined();
      expect(hostname.zoneId).toEqual(zoneId);
      expect(hostname.hostname).toEqual(HOST_DEFAULT);
      // We don't control the domain, so activation never completes.
      expect(hostname.status).toBeDefined();

      const live = yield* getHostname(zoneId, hostname.customHostnameId);
      expect(live.id).toEqual(hostname.customHostnameId);
      expect(live.hostname).toEqual(HOST_DEFAULT);
      expect(live.ssl?.method).toEqual("txt");
      expect(live.ssl?.type).toEqual("dv");

      yield* stack.destroy();

      const gone = yield* findByHostname(zoneId, HOST_DEFAULT);
      expect(gone).toBeUndefined();
    }).pipe(logLevel),
  { timeout: 120_000 },
);

testSaas(
  "updating ssl method patches in place",
  (stack) =>
    Effect.gen(function* () {
      const zoneId = yield* resolveZoneId;
      yield* probeSaasEntitlement(zoneId);

      yield* stack.destroy();

      const initial = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.CustomHostname.CustomHostname("Update", {
            zoneId,
            hostname: HOST_UPDATE,
            ssl: { method: "txt", type: "dv" },
          }).pipe(adopt(true));
        }),
      );

      expect(initial.customHostnameId).toBeDefined();

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.CustomHostname.CustomHostname("Update", {
            zoneId,
            hostname: HOST_UPDATE,
            ssl: { method: "http", type: "dv" },
          }).pipe(adopt(true));
        }),
      );

      // Same custom hostname patched in place — not a replacement.
      expect(updated.customHostnameId).toEqual(initial.customHostnameId);

      const live = yield* getHostname(zoneId, updated.customHostnameId);
      expect(live.ssl?.method).toEqual("http");

      // Re-deploying the same desired state is a no-op (does not error or
      // trigger reissuance).
      const again = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.CustomHostname.CustomHostname("Update", {
            zoneId,
            hostname: HOST_UPDATE,
            ssl: { method: "http", type: "dv" },
          }).pipe(adopt(true));
        }),
      );
      expect(again.customHostnameId).toEqual(initial.customHostnameId);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 120_000 },
);

// `list()` fans out over every zone in the account and skips zones without
// the SaaS entitlement (typed `SaasQuotaNotAllocated`/`Forbidden`). Without
// the entitlement on any zone the result is a well-typed empty array — this
// read-only assertion runs ungated and proves the per-zone skip path.
test.provider("list returns a well-typed array of custom hostnames", (stack) =>
  Effect.gen(function* () {
    yield* stack.destroy();

    const provider = yield* Provider.findProvider(
      Cloudflare.CustomHostname.CustomHostname,
    );
    const all = yield* provider.list();

    expect(Array.isArray(all)).toBe(true);
    for (const item of all) {
      expect(typeof item.customHostnameId).toBe("string");
      expect(typeof item.zoneId).toBe("string");
      expect(typeof item.hostname).toBe("string");
    }

    yield* stack.destroy();
  }).pipe(logLevel),
);

// Entitlement-gated: deploy a custom hostname and assert `list()` enumerates
// it. Skipped unless CLOUDFLARE_SAAS_ENABLED=1 because Cloudflare for SaaS is
// not provisioned on the test account (every create is rejected with
// `SaasQuotaNotAllocated`, code 1404).
testSaas(
  "list enumerates the deployed custom hostname",
  (stack) =>
    Effect.gen(function* () {
      const zoneId = yield* resolveZoneId;
      yield* probeSaasEntitlement(zoneId);

      yield* stack.destroy();

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.CustomHostname.CustomHostname(
            "ListResource",
            {
              zoneId,
              hostname: HOST_DEFAULT,
            },
          ).pipe(adopt(true));
        }),
      );

      const provider = yield* Provider.findProvider(
        Cloudflare.CustomHostname.CustomHostname,
      );
      const all = yield* provider.list();

      expect(
        all.some((h) => h.customHostnameId === deployed.customHostnameId),
      ).toBe(true);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 120_000 },
);

testSaas(
  "changing the hostname triggers replacement",
  (stack) =>
    Effect.gen(function* () {
      const zoneId = yield* resolveZoneId;
      yield* probeSaasEntitlement(zoneId);

      yield* stack.destroy();

      const initial = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.CustomHostname.CustomHostname("Replace", {
            zoneId,
            hostname: HOST_REPLACE_A,
          }).pipe(adopt(true));
        }),
      );

      expect(initial.hostname).toEqual(HOST_REPLACE_A);

      const replaced = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.CustomHostname.CustomHostname("Replace", {
            zoneId,
            hostname: HOST_REPLACE_B,
          }).pipe(adopt(true));
        }),
      );

      // hostname is the resource's identity — a new physical hostname exists.
      expect(replaced.customHostnameId).not.toEqual(initial.customHostnameId);
      expect(replaced.hostname).toEqual(HOST_REPLACE_B);

      // The old hostname was deleted as part of the replacement.
      const oldHostname = yield* findByHostname(zoneId, HOST_REPLACE_A);
      expect(oldHostname).toBeUndefined();

      const live = yield* getHostname(zoneId, replaced.customHostnameId);
      expect(live.hostname).toEqual(HOST_REPLACE_B);

      yield* stack.destroy();

      const gone = yield* findByHostname(zoneId, HOST_REPLACE_B);
      expect(gone).toBeUndefined();
    }).pipe(logLevel),
  { timeout: 180_000 },
);
