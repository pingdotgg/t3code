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

// Outgoing zone transfers are an Enterprise feature. On the testing
// account, `POST /zones/{id}/secondary_dns/outgoing` fails with HTTP
// 401 — result "Not authorized to setup outgoing zone transfers" —
// surfaced as the typed `OutgoingZoneTransfersNotAllowed` error. The
// full lifecycle test below is gated behind an entitled zone supplied
// via env.
const outgoingEntitled = !!process.env.CLOUDFLARE_TEST_OUTGOING_ZONE_TRANSFER;

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

test.provider.skipIf(outgoingEntitled)(
  "surfaces the typed OutgoingZoneTransfersNotAllowed error on unentitled zones",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const zoneId = yield* resolveZoneId;

      yield* stack.destroy();

      // Need a peer to attempt the link with — peers themselves are
      // available on this account.
      const peer = yield* retryForbidden(
        dns.createZoneTransferPeer({
          accountId,
          name: "alchemy-dnszt-outgoing-probe-peer",
        }),
      );

      const error = yield* retryForbidden(
        dns.createZoneTransferOutgoing({
          zoneId,
          name: `${zoneName}.`,
          peers: [peer.id],
        }),
      ).pipe(
        Effect.flip,
        Effect.ensuring(
          dns
            .deleteZoneTransferPeer({ accountId, peerId: peer.id })
            .pipe(Effect.ignore),
        ),
      );
      expect(error._tag).toEqual("OutgoingZoneTransfersNotAllowed");
    }).pipe(logLevel),
  { timeout: 120_000 },
);

test.provider.skipIf(!outgoingEntitled)(
  "create, sync peers and enabled state, and delete the outgoing config",
  (stack) =>
    Effect.gen(function* () {
      const zoneId = yield* resolveZoneId;

      yield* stack.destroy();

      const { outgoing, peer } = yield* stack.deploy(
        Effect.gen(function* () {
          const peer = yield* Cloudflare.DNS.ZoneTransferPeer("OutgoingPeer", {
            name: "alchemy-dnszt-outgoing-peer",
            ip: "192.0.2.53",
            port: 53,
          });
          const outgoing = yield* Cloudflare.DNS.ZoneTransferOutgoing(
            "Outgoing",
            {
              zoneId,
              name: `${zoneName}.`,
              peers: [peer.peerId],
            },
          );
          return { outgoing, peer };
        }),
      );
      expect(outgoing.zoneId).toEqual(zoneId);
      expect(outgoing.peers).toEqual([peer.peerId]);
      expect(outgoing.enabled).toEqual(true);

      // Disable in place — toggled via the dedicated endpoint. Keep the
      // peer deployed across the update (engine constraint: never drop a
      // dependency in the same deploy that changes its dependent).
      const disabled = yield* stack.deploy(
        Effect.gen(function* () {
          const peer = yield* Cloudflare.DNS.ZoneTransferPeer("OutgoingPeer", {
            name: "alchemy-dnszt-outgoing-peer",
            ip: "192.0.2.53",
            port: 53,
          });
          const outgoing = yield* Cloudflare.DNS.ZoneTransferOutgoing(
            "Outgoing",
            {
              zoneId,
              name: `${zoneName}.`,
              peers: [peer.peerId],
              enabled: false,
            },
          );
          return outgoing;
        }),
      );
      expect(disabled.enabled).toEqual(false);

      yield* stack.destroy();

      // Once deleted, the GET reports the typed not-found tag.
      const gone = yield* retryForbidden(
        dns.getZoneTransferOutgoing({ zoneId }),
      ).pipe(Effect.flip);
      expect(gone._tag).toEqual("OutgoingZoneTransferNotFound");

      // Re-running destroy is idempotent.
      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 300_000 },
);

// Canonical `list()` test (zone-scoped singleton): there is no account-wide
// API for the outgoing transfer config, so `list()` enumerates every zone
// via `listAllZones` and reads the singleton in each, skipping zones that
// have no config or lack the Secondary DNS entitlement (typed
// OutgoingZoneTransferNotFound / OutgoingZoneTransfersNotAllowed tags). The
// read-only assertion (well-typed Attributes[]) always runs; on the
// unentitled testing account no zone returns a config, so the deployed-
// presence assertion is gated behind an entitled zone.
test.provider(
  "list enumerates the outgoing transfer config per zone",
  (stack) =>
    Effect.gen(function* () {
      const zoneId = yield* resolveZoneId;

      const provider = yield* Provider.findProvider(
        Cloudflare.DNS.ZoneTransferOutgoing,
      );
      const all = yield* provider.list();

      // Always-on assertion: list() returns a well-typed Attributes[] and
      // never throws even when every zone is unconfigured/unentitled.
      expect(Array.isArray(all)).toBe(true);
      for (const item of all) {
        expect(typeof item.zoneId).toBe("string");
        expect(Array.isArray(item.peers)).toBe(true);
        expect(typeof item.enabled).toBe("boolean");
      }

      // Only an entitled+configured zone appears in the enumeration.
      if (outgoingEntitled) {
        expect(all.some((o) => o.zoneId === zoneId)).toBe(true);
      }

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 120_000 },
);
