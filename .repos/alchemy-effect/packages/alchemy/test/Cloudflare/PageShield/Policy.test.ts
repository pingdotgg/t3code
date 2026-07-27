import * as Cloudflare from "@/Cloudflare";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import { findZoneByName } from "@/Cloudflare/Zone/lookup";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import * as pageShield from "@distilled.cloud/cloudflare/page-shield";
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

// Page Shield CSP policies are an Enterprise add-on. On the testing
// account's zone every create fails with "exceeded the maximum number of
// rules in the phase http_response_page_shield: 1 out of 0", surfaced as
// the typed `PolicyQuotaExceeded` error. The full lifecycle test below is
// gated behind an entitled zone id supplied via env.
const entitledZoneId = process.env.CLOUDFLARE_TEST_PAGE_SHIELD_POLICY_ZONE_ID;

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

// Fresh scoped tokens propagate eventually-consistently across Cloudflare's
// edge — retry the typed `Forbidden` error on out-of-band calls.
const forbiddenRetrySchedule = Schedule.exponential("500 millis");

const getPolicy = (zoneId: string, policyId: string) =>
  pageShield.getPolicy({ zoneId, policyId }).pipe(
    Effect.retry({
      while: (e) => e._tag === "Forbidden",
      schedule: forbiddenRetrySchedule,
      times: 8,
    }),
  );

const findPolicyByDescription = (zoneId: string, description: string) =>
  pageShield.listPolicies({ zoneId }).pipe(
    Effect.map((list) =>
      list.result.find((p) => p.description === description),
    ),
    Effect.retry({
      while: (e) => e._tag === "Forbidden",
      schedule: forbiddenRetrySchedule,
      times: 8,
    }),
  );

test.provider(
  "surfaces the typed PolicyQuotaExceeded error on unentitled zones",
  (stack) =>
    Effect.gen(function* () {
      const zoneId = yield* resolveZoneId;

      yield* stack.destroy();

      // The standard testing zone lacks the Enterprise CSP entitlement —
      // the distilled call must fail with the typed quota tag.
      const error = yield* pageShield
        .createPolicy({
          zoneId,
          action: "log",
          description: "alchemy-pageshield-quota-probe",
          enabled: true,
          expression: `http.host eq "${zoneName}"`,
          value: "script-src 'self'",
        })
        .pipe(
          Effect.retry({
            while: (e) => e._tag === "Forbidden",
            schedule: forbiddenRetrySchedule,
            times: 8,
          }),
          Effect.flip,
        );
      expect(error._tag).toEqual("PolicyQuotaExceeded");

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 120_000 },
);

test.provider(
  "list enumerates Page Shield policies across all zones",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const provider = yield* Provider.findProvider(
        Cloudflare.PageShield.Policy,
      );

      // Page Shield CSP policies are an Enterprise add-on; the testing
      // account has a zero rule quota, so we cannot deploy a policy to
      // observe. Enumeration must still succeed (fanning out across every
      // zone, skipping unentitled `Forbidden` zones) and return a
      // well-typed array — empty when no policies exist.
      if (entitledZoneId) {
        const description = "alchemy-pageshield-list";
        const deployed = yield* stack.deploy(
          Effect.gen(function* () {
            yield* Cloudflare.PageShield.Settings("PageShield", {
              zoneId: entitledZoneId,
            });
            return yield* Cloudflare.PageShield.Policy("ListPolicy", {
              zoneId: entitledZoneId,
              description,
              action: "log",
              expression: `http.host eq "${zoneName}"`,
              value: "script-src 'self'",
            });
          }),
        );

        const all = yield* provider.list();
        expect(Array.isArray(all)).toBe(true);
        expect(all.some((p) => p.policyId === deployed.policyId)).toBe(true);
      } else {
        const all = yield* provider.list();
        expect(Array.isArray(all)).toBe(true);
      }

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 180_000 },
);

// Requires the Enterprise Page Shield CSP entitlement — unentitled zones have a zero
// rule quota and fail with the typed PolicyQuotaExceeded. Unlock with CLOUDFLARE_TEST_PAGE_SHIELD_POLICY_ZONE_ID=<zone id>.
test.provider.skipIf(!entitledZoneId)(
  "creates, updates in place, and deletes a CSP policy",
  (stack) =>
    Effect.gen(function* () {
      const zoneId = entitledZoneId!;
      const description = "alchemy-pageshield-policy-lifecycle";

      yield* stack.destroy();

      // Create — log-only CSP policy (Page Shield itself is enabled by
      // the Settings singleton in the same stack).
      const created = yield* stack.deploy(
        Effect.gen(function* () {
          yield* Cloudflare.PageShield.Settings("PageShield", {
            zoneId,
          });
          return yield* Cloudflare.PageShield.Policy("CspPolicy", {
            zoneId,
            description,
            action: "log",
            expression: `http.host eq "${zoneName}"`,
            value: "script-src 'self'",
          });
        }),
      );

      expect(created.policyId).toBeDefined();
      expect(created.zoneId).toEqual(zoneId);
      expect(created.action).toEqual("log");
      expect(created.description).toEqual(description);
      expect(created.enabled).toEqual(true);

      // Out-of-band verification via the distilled API.
      const live = yield* getPolicy(zoneId, created.policyId);
      expect(live.action).toEqual("log");
      expect(live.value).toEqual("script-src 'self'");

      // Update in place — action and value are mutable, same policy id.
      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          yield* Cloudflare.PageShield.Settings("PageShield", {
            zoneId,
          });
          return yield* Cloudflare.PageShield.Policy("CspPolicy", {
            zoneId,
            description,
            action: "allow",
            expression: `http.host eq "${zoneName}"`,
            value: "script-src 'self' 'unsafe-inline'",
          });
        }),
      );
      expect(updated.policyId).toEqual(created.policyId);
      expect(updated.action).toEqual("allow");
      expect(updated.value).toEqual("script-src 'self' 'unsafe-inline'");

      const liveUpdated = yield* getPolicy(zoneId, updated.policyId);
      expect(liveUpdated.action).toEqual("allow");

      yield* stack.destroy();

      // The policy is gone (delete is idempotent — Cloudflare answers a
      // 204 even for already-deleted policies).
      const gone = yield* findPolicyByDescription(zoneId, description);
      expect(gone).toBeUndefined();
    }).pipe(logLevel),
  { timeout: 120_000 },
);
