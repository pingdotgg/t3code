import * as Cloudflare from "@/Cloudflare";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import { findZoneByName } from "@/Cloudflare/Zone/lookup";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import * as dns from "@distilled.cloud/cloudflare/dns";
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

// Internal DNS views require the Enterprise Internal DNS entitlement.
// On the testing account, `POST /accounts/{id}/dns_settings/views` fails
// with code 1029 — "Internal DNS is not available to this account.
// Contact support for more information." — surfaced as the typed
// `InternalDnsNotAvailable` error. The full lifecycle test below is
// gated behind an entitled account supplied via env.
const internalDnsEntitled = !!process.env.CLOUDFLARE_TEST_INTERNAL_DNS;

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

const retryForbidden = <A, E extends { _tag: string }, R>(
  eff: Effect.Effect<A, E, R>,
) =>
  eff.pipe(
    Effect.retry({
      while: (e) => e._tag === "Forbidden",
      schedule: Schedule.exponential("500 millis"),
      times: 8,
    }),
  );

test.provider.skipIf(internalDnsEntitled)(
  "surfaces the typed InternalDnsNotAvailable error on unentitled accounts",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const zoneId = yield* resolveZoneId;

      yield* stack.destroy();

      // The testing account lacks the Internal DNS entitlement — the
      // distilled call must fail with the typed tag (code 1029).
      const error = yield* retryForbidden(
        dns.createSettingAccountView({
          accountId,
          name: "alchemy-dns-view-test",
          zones: [zoneId],
        }),
      ).pipe(Effect.flip);
      expect(error._tag).toEqual("InternalDnsNotAvailable");
    }).pipe(logLevel),
  { timeout: 120_000 },
);

// The list endpoint (GET) is enumerable on any account; on unentitled
// accounts it simply returns no views. We can therefore always assert a
// well-typed array, and only assert presence of a deployed view when the
// account carries the Internal DNS entitlement.
test.provider(
  "list returns a well-typed array of internal DNS views",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const provider = yield* Provider.findProvider(Cloudflare.DNS.View);
      const all = yield* provider.list();
      expect(Array.isArray(all)).toBe(true);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 120_000 },
);

test.provider.skipIf(!internalDnsEntitled)(
  "list enumerates a deployed internal DNS view",
  (stack) =>
    Effect.gen(function* () {
      const zoneId = yield* resolveZoneId;

      yield* stack.destroy();

      const deployed = yield* stack.deploy(
        Cloudflare.DNS.View("ListView", {
          name: "alchemy-dns-view-list",
          zones: [zoneId],
        }),
      );

      const provider = yield* Provider.findProvider(Cloudflare.DNS.View);
      const all = yield* provider.list();
      expect(all.some((v) => v.viewId === deployed.viewId)).toBe(true);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 120_000 },
);

test.provider.skipIf(!internalDnsEntitled)(
  "create, update zones in place, and delete an internal DNS view",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const zoneId = yield* resolveZoneId;

      yield* stack.destroy();

      const created = yield* stack.deploy(
        Cloudflare.DNS.View("TestView", {
          name: "alchemy-dns-view-test",
          zones: [zoneId],
        }),
      );
      expect(created.viewId).toBeDefined();
      expect(created.name).toEqual("alchemy-dns-view-test");
      expect(created.zones).toEqual([zoneId]);

      // Out-of-band verify via the SDK.
      const live = yield* retryForbidden(
        dns.getSettingAccountView({ accountId, viewId: created.viewId }),
      );
      expect(live.name).toEqual("alchemy-dns-view-test");

      // Rename in place — same physical view.
      const renamed = yield* stack.deploy(
        Cloudflare.DNS.View("TestView", {
          name: "alchemy-dns-view-test-renamed",
          zones: [zoneId],
        }),
      );
      expect(renamed.viewId).toEqual(created.viewId);
      expect(renamed.name).toEqual("alchemy-dns-view-test-renamed");

      yield* stack.destroy();

      // A deleted view surfaces as the typed `ViewNotFound` (code 1015).
      const gone = yield* retryForbidden(
        dns.getSettingAccountView({ accountId, viewId: created.viewId }),
      ).pipe(Effect.flip);
      expect(gone._tag).toEqual("ViewNotFound");

      // Re-running destroy is idempotent.
      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 120_000 },
);
