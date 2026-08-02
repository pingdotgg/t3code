import * as Cloudflare from "@/Cloudflare";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import { findZoneByName } from "@/Cloudflare/Zone/lookup";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import * as addressing from "@distilled.cloud/cloudflare/addressing";
import * as dns from "@distilled.cloud/cloudflare/dns";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";

const { test } = Test.make({ providers: Cloudflare.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const zoneName =
  process.env.CLOUDFLARE_TEST_DNS_ZONE_NAME ?? "alchemy-test-2.us";

// Deterministic per-test hostname (never derive from Date.now()/random).
const HOSTNAME = `alchemy-regional.${zoneName}`;

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

// A freshly minted scoped token propagates eventually-consistently across
// Cloudflare's edge — retry the typed `Forbidden` blips on out-of-band calls.
const forbiddenRetrySchedule = Schedule.exponential("500 millis");

const retryForbidden = <A, E extends { _tag: string }, R>(
  effect: Effect.Effect<A, E, R>,
) =>
  effect.pipe(
    Effect.retry({
      while: (e) => e._tag === "Forbidden",
      schedule: forbiddenRetrySchedule,
      times: 8,
    }),
  );

const getRegionalHostname = (zoneId: string, hostname: string) =>
  retryForbidden(addressing.getRegionalHostname({ zoneId, hostname })).pipe(
    Effect.catchTag(["RegionalHostnameNotFound", "RegionalHostnameEmpty"], () =>
      Effect.succeed(undefined),
    ),
  );

const deleteRegionalHostname = (zoneId: string, hostname: string) =>
  retryForbidden(addressing.deleteRegionalHostname({ zoneId, hostname })).pipe(
    Effect.catchTag(
      ["RegionalHostnameNotFound", "RegionalHostnameEmpty"],
      () => Effect.void,
    ),
  );

// Regionalization only takes effect for hostnames with a DNS record — and
// creation rejects hostnames without one. Ensure an A record exists for the
// test hostname (idempotently) before exercising the resource.
const ensureDnsRecord = (zoneId: string) =>
  Effect.gen(function* () {
    const existing = yield* retryForbidden(
      dns.listRecords
        .items({ zoneId, name: { exact: HOSTNAME }, type: "A" })
        .pipe(
          Stream.runCollect,
          Effect.map((c) => Array.from(c)),
        ),
    );
    if (existing.length === 0) {
      yield* retryForbidden(
        dns.createRecord({
          zoneId,
          name: HOSTNAME,
          type: "A",
          content: "203.0.113.77",
          ttl: 300,
          proxied: true,
        }),
      );
    }
  });

const purgeDnsRecord = (zoneId: string) =>
  retryForbidden(
    dns.listRecords
      .items({ zoneId, name: { exact: HOSTNAME }, type: "A" })
      .pipe(
        Stream.runCollect,
        Effect.map((c) => Array.from(c)),
      ),
  ).pipe(
    Effect.flatMap(
      Effect.forEach((r) =>
        dns
          .deleteRecord({ zoneId, dnsRecordId: r.id })
          .pipe(Effect.catch(() => Effect.void)),
      ),
    ),
  );

// Regional Hostnames require the Data Localization Suite / Regional Services
// entitlement on the zone. The test probes a raw create once: unentitled
// zones assert the typed error tag; entitled zones run the full lifecycle
// (create, patch regionKey in place, destroy, verify gone).
test.provider(
  "regional hostname lifecycle (typed error on unentitled zones)",
  (stack) =>
    Effect.gen(function* () {
      const zoneId = yield* resolveZoneId;

      yield* stack.destroy();
      yield* ensureDnsRecord(zoneId);
      // Purge leftovers from interrupted runs.
      yield* deleteRegionalHostname(zoneId, HOSTNAME);

      const probe = yield* retryForbidden(
        addressing.createRegionalHostname({
          zoneId,
          hostname: HOSTNAME,
          regionKey: "eu",
        }),
      ).pipe(Effect.result);

      if (Result.isFailure(probe)) {
        // Unentitled — must surface as a typed tag from the operation's
        // error union, never an untyped catch-all.
        expect(["InvalidHostname", "RegionalHostnameEmpty"]).toContain(
          probe.failure._tag,
        );
        yield* purgeDnsRecord(zoneId);
        yield* stack.destroy();
        return;
      }

      // Entitled — remove the probe hostname and run the full lifecycle.
      yield* deleteRegionalHostname(zoneId, HOSTNAME);

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.RegionalHostname.RegionalHostname(
            "Regional",
            {
              zoneId,
              hostname: HOSTNAME,
              regionKey: "eu",
            },
          );
        }),
      );
      expect(created.zoneId).toEqual(zoneId);
      expect(created.hostname).toEqual(HOSTNAME);
      expect(created.regionKey).toEqual("eu");
      expect(created.createdOn).toBeDefined();

      // Out-of-band verification via the distilled API.
      const live = yield* getRegionalHostname(zoneId, HOSTNAME);
      expect(live?.regionKey).toEqual("eu");

      // Move the hostname to another region in place — same identifier.
      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.RegionalHostname.RegionalHostname(
            "Regional",
            {
              zoneId,
              hostname: HOSTNAME,
              regionKey: "us",
            },
          );
        }),
      );
      expect(updated.hostname).toEqual(HOSTNAME);
      expect(updated.regionKey).toEqual("us");

      const patched = yield* getRegionalHostname(zoneId, HOSTNAME);
      expect(patched?.regionKey).toEqual("us");

      // Destroy and verify the hostname is gone (typed not-found read).
      yield* stack.destroy();
      const gone = yield* getRegionalHostname(zoneId, HOSTNAME);
      expect(gone).toBeUndefined();

      yield* purgeDnsRecord(zoneId);
    }).pipe(logLevel),
  { timeout: 120_000 },
);

// Canonical `list()` test (zone-scoped collection): `list()` fans out over
// every zone via `listAllZones` and exhaustively paginates each zone's
// regional hostnames. Data Localization is entitlement-gated, so the deploy
// is probe-gated: when the zone is entitled we assert the deployed hostname
// appears in the result; otherwise we still assert `list()` returns a
// well-typed (possibly empty) array.
//
// SKIP-GATED: `list()` fans out over EVERY zone in the account, but the
// scoped test token can only access `alchemy-test-2.us`. Listing regional
// hostnames on any other zone returns a 403:
//   Forbidden: forbidden  (GET /zones/{zone_id}/addressing/regional_hostnames)
// `listRegionalHostnames` types its error union as `DefaultErrors` only, so
// `Forbidden` cannot be `catchTag`ed/skipped yet. Needed distilled patch:
//   distilled/packages/cloudflare/patches/addressing/listRegionalHostnames.json
//   -> { "errors": { "Forbidden": [{ "status": 403 }] } }
// then regenerate addressing and add "Forbidden" to the catch in list().
// Gate the live run behind CLOUDFLARE_TEST_REGIONAL_HOSTNAME_LIST=1 (run on
// an account whose token can read every zone, or a single-zone account).
test.provider.skipIf(!process.env.CLOUDFLARE_TEST_REGIONAL_HOSTNAME_LIST)(
  "list enumerates regional hostnames across zones",
  (stack) =>
    Effect.gen(function* () {
      const zoneId = yield* resolveZoneId;

      yield* stack.destroy();
      yield* ensureDnsRecord(zoneId);
      yield* deleteRegionalHostname(zoneId, HOSTNAME);

      // Probe entitlement once: unentitled zones reject create with a typed tag.
      const probe = yield* retryForbidden(
        addressing.createRegionalHostname({
          zoneId,
          hostname: HOSTNAME,
          regionKey: "eu",
        }),
      ).pipe(Effect.result);

      const entitled = Result.isSuccess(probe);
      if (!entitled) {
        expect(["InvalidHostname", "RegionalHostnameEmpty"]).toContain(
          probe.failure._tag,
        );
      } else {
        // Remove the raw probe so the resource owns the hostname.
        yield* deleteRegionalHostname(zoneId, HOSTNAME);
        yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Cloudflare.RegionalHostname.RegionalHostname(
              "Regional",
              {
                zoneId,
                hostname: HOSTNAME,
                regionKey: "eu",
              },
            );
          }),
        );
      }

      const provider = yield* Provider.findProvider(
        Cloudflare.RegionalHostname.RegionalHostname,
      );
      const all = yield* provider.list();

      // `list()` always returns the full Attributes shape for each item.
      expect(Array.isArray(all)).toBe(true);
      for (const item of all) {
        expect(typeof item.zoneId).toBe("string");
        expect(typeof item.hostname).toBe("string");
        expect(typeof item.regionKey).toBe("string");
      }

      if (entitled) {
        // The deployed hostname must appear in the exhaustively-paginated result.
        expect(
          all.some(
            (item) => item.zoneId === zoneId && item.hostname === HOSTNAME,
          ),
        ).toBe(true);
      }

      yield* stack.destroy();
      yield* deleteRegionalHostname(zoneId, HOSTNAME);
      yield* purgeDnsRecord(zoneId);
    }).pipe(logLevel),
  { timeout: 120_000 },
);
