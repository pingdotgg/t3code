import * as Cloudflare from "@/Cloudflare";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import * as dns from "@distilled.cloud/cloudflare/dns";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: Cloudflare.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

// Deterministic key material (this is test-only, not a real secret).
const TSIG_SECRET =
  "kyTZf6QHTPVdpDjLWWbYO7DI3Z6f3wWvECDCtMHEOSomCnq0db4DBzowg4QH51jJZUw5n4nGYNGmkJhCfn+9Ag==";

// Ride out fresh-token 403 blips on out-of-band calls.
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

const getPeer = (accountId: string, peerId: string) =>
  retryForbidden(dns.getZoneTransferPeer({ accountId, peerId }));

// A deleted peer surfaces as the typed `PeerNotFound` (HTTP 404).
const expectGone = (accountId: string, peerId: string) =>
  getPeer(accountId, peerId).pipe(
    Effect.flatMap(() => Effect.fail({ _tag: "PeerNotDeleted" } as const)),
    Effect.catchTag("PeerNotFound", () => Effect.void),
    Effect.retry({
      while: (e) => e._tag === "PeerNotDeleted",
      schedule: Schedule.max([
        Schedule.exponential("500 millis"),
        Schedule.recurs(10),
      ]),
    }),
  );

test.provider(
  "create with connection settings, update in place, and delete a peer",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;

      yield* stack.destroy();

      // Create applies name-only POST followed by a PUT with the
      // connection settings.
      const created = yield* stack.deploy(
        Cloudflare.DNS.ZoneTransferPeer("TestPeer", {
          name: "alchemy-dnszt-peer-test",
          ip: "192.0.2.53",
          port: 53,
        }),
      );
      expect(created.peerId).toBeDefined();
      expect(created.accountId).toEqual(accountId);
      expect(created.name).toEqual("alchemy-dnszt-peer-test");
      expect(created.ip).toEqual("192.0.2.53");
      expect(created.port).toEqual(53);

      // Out-of-band verify via the SDK.
      const live = yield* getPeer(accountId, created.peerId);
      expect(live.name).toEqual("alchemy-dnszt-peer-test");
      expect(live.ip).toEqual("192.0.2.53");
      expect(live.port).toEqual(53);

      // Update the connection settings in place — same physical peer.
      const updated = yield* stack.deploy(
        Cloudflare.DNS.ZoneTransferPeer("TestPeer", {
          name: "alchemy-dnszt-peer-test-renamed",
          ip: "198.51.100.53",
          port: 5353,
        }),
      );
      expect(updated.peerId).toEqual(created.peerId);
      expect(updated.name).toEqual("alchemy-dnszt-peer-test-renamed");
      expect(updated.ip).toEqual("198.51.100.53");
      expect(updated.port).toEqual(5353);

      const liveUpdated = yield* getPeer(accountId, created.peerId);
      expect(liveUpdated.ip).toEqual("198.51.100.53");
      expect(liveUpdated.port).toEqual(5353);

      yield* stack.destroy();
      yield* expectGone(accountId, created.peerId);

      // Re-running destroy is idempotent.
      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 120_000 },
);

test.provider(
  "wires a TSIG reference through to the peer",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;

      yield* stack.destroy();

      const { peer, tsig } = yield* stack.deploy(
        Effect.gen(function* () {
          const tsig = yield* Cloudflare.DNS.ZoneTransferTsig("PeerTsig", {
            name: "alchemy-dnszt-peer-tsig-test.",
            algo: "hmac-sha512.",
            secret: Redacted.make(TSIG_SECRET),
          });
          const peer = yield* Cloudflare.DNS.ZoneTransferPeer("TsigPeer", {
            name: "alchemy-dnszt-peer-tsig-peer",
            ip: "192.0.2.54",
            tsigId: tsig.tsigId,
          });
          return { peer, tsig };
        }),
      );
      expect(peer.tsigId).toEqual(tsig.tsigId);

      const live = yield* getPeer(accountId, peer.peerId);
      expect(live.tsigId).toEqual(tsig.tsigId);

      yield* stack.destroy();
      yield* expectGone(accountId, peer.peerId);
    }).pipe(logLevel),
  { timeout: 120_000 },
);

test.provider(
  "list enumerates the deployed peer",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deployed = yield* stack.deploy(
        Cloudflare.DNS.ZoneTransferPeer("ListPeer", {
          name: "alchemy-dnszt-peer-list",
          ip: "192.0.2.55",
          port: 53,
        }),
      );

      const provider = yield* Provider.findProvider(
        Cloudflare.DNS.ZoneTransferPeer,
      );
      const all = yield* provider.list();

      expect(all.some((p) => p.peerId === deployed.peerId)).toBe(true);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 120_000 },
);
