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

// Incoming zone transfers require a SECONDARY zone, and secondary zone
// signup is not allowed on the testing account (`POST /zones` with
// `type: "secondary"` fails with "Secondary zone signup not allowed").
// On a regular (full) zone the incoming POST superficially succeeds but
// the configuration does not persist — the follow-up GET reports the
// typed `IncomingZoneTransferNotFound`. The full lifecycle test below
// is gated behind a real secondary zone supplied via env.
const secondaryZoneId = process.env.CLOUDFLARE_TEST_SECONDARY_ZONE_ID;

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

// Canonical `list()` test (zone-scoped singleton): there is no
// account-wide API for this per-zone config, so `list()` enumerates every
// zone via `listAllZones` and reads the incoming transfer config in each,
// skipping zones that have none (`IncomingZoneTransferNotFound`). The
// read-only assertion always runs and proves the result is a well-typed
// `Attributes[]`; if a real secondary zone is supplied, assert it appears.
test.provider(
  "list enumerates incoming configs across all zones",
  (stack) =>
    Effect.gen(function* () {
      const provider = yield* Provider.findProvider(
        Cloudflare.DNS.ZoneTransferIncoming,
      );
      const all = yield* provider.list();

      expect(Array.isArray(all)).toBe(true);
      for (const row of all) {
        expect(typeof row.zoneId).toBe("string");
        expect(Array.isArray(row.peers)).toBe(true);
      }
      if (secondaryZoneId) {
        expect(all.some((c) => c.zoneId === secondaryZoneId)).toBe(true);
      }

      // `stack` is unused (list is a read-only account enumeration); keep the
      // destroy bookend so the harness state stays clean.
      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 120_000 },
);

test.provider.skipIf(!!secondaryZoneId)(
  "incoming config does not persist on non-secondary zones (typed not-found)",
  (stack) =>
    Effect.gen(function* () {
      const zoneId = yield* resolveZoneId;

      yield* stack.destroy();

      // The GET on a zone that was never linked reports the typed tag.
      const error = yield* retryForbidden(
        dns.getZoneTransferIncoming({ zoneId }),
      ).pipe(Effect.flip);
      expect(error._tag).toEqual("IncomingZoneTransferNotFound");
    }).pipe(logLevel),
  { timeout: 120_000 },
);

test.provider.skipIf(!secondaryZoneId)(
  "create, update autoRefreshSeconds in place, and delete the incoming config",
  (stack) =>
    Effect.gen(function* () {
      const zoneId = secondaryZoneId!;

      yield* stack.destroy();

      const { incoming, peer } = yield* stack.deploy(
        Effect.gen(function* () {
          const peer = yield* Cloudflare.DNS.ZoneTransferPeer("IncomingPeer", {
            name: "alchemy-dnszt-incoming-peer",
            ip: "192.0.2.53",
            port: 53,
          });
          const incoming = yield* Cloudflare.DNS.ZoneTransferIncoming(
            "Incoming",
            {
              zoneId,
              name: `${zoneName}.`,
              peers: [peer.peerId],
              autoRefreshSeconds: 86400,
            },
          );
          return { incoming, peer };
        }),
      );
      expect(incoming.zoneId).toEqual(zoneId);
      expect(incoming.peers).toEqual([peer.peerId]);
      expect(incoming.autoRefreshSeconds).toEqual(86400);

      // Update the refresh interval in place. Keep the peer deployed
      // across the update (engine constraint: never drop a dependency
      // in the same deploy that changes its dependent).
      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const peer = yield* Cloudflare.DNS.ZoneTransferPeer("IncomingPeer", {
            name: "alchemy-dnszt-incoming-peer",
            ip: "192.0.2.53",
            port: 53,
          });
          const incoming = yield* Cloudflare.DNS.ZoneTransferIncoming(
            "Incoming",
            {
              zoneId,
              name: `${zoneName}.`,
              peers: [peer.peerId],
              autoRefreshSeconds: 43200,
            },
          );
          return incoming;
        }),
      );
      expect(updated.autoRefreshSeconds).toEqual(43200);

      yield* stack.destroy();

      // Once deleted, the GET reports the typed not-found tag.
      const gone = yield* retryForbidden(
        dns.getZoneTransferIncoming({ zoneId }),
      ).pipe(Effect.flip);
      expect(gone._tag).toEqual("IncomingZoneTransferNotFound");

      // Re-running destroy is idempotent.
      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 300_000 },
);
