import * as Cloudflare from "@/Cloudflare";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import * as magicTransit from "@distilled.cloud/cloudflare/magic-transit";
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

// Magic Transit is an entitlement-gated product — see GreTunnel.test.ts.
// The probe test always runs and pins the typed gate tag; the lifecycle
// test is opt-in for entitled accounts.
const entitled = !!process.env.CLOUDFLARE_TEST_MAGIC_TRANSIT;

const cfEndpoint = process.env.CLOUDFLARE_TEST_MT_CF_ENDPOINT ?? "203.0.113.1";

const getTunnel = (accountId: string, ipsecTunnelId: string) =>
  magicTransit.getIpsecTunnel({
    accountId,
    ipsecTunnelId,
    xMagicNewHcTarget: true,
  });

// Poll until the tunnel is gone after destroy. Cloudflare answers GET for
// a missing tunnel with the typed `IpsecTunnelNotFound` (code 1032).
const expectGone = (accountId: string, ipsecTunnelId: string) =>
  getTunnel(accountId, ipsecTunnelId).pipe(
    Effect.flatMap(() => Effect.fail({ _tag: "TunnelNotDeleted" } as const)),
    Effect.catchTag("IpsecTunnelNotFound", () => Effect.void),
    Effect.retry({
      while: (e) => e._tag === "TunnelNotDeleted",
      schedule: Schedule.max([
        Schedule.exponential("500 millis"),
        Schedule.recurs(10),
      ]),
    }),
  );

test.provider(
  "unentitled accounts surface the typed MagicTransitNotOnboarded error",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;

      yield* stack.destroy();

      const canList = yield* magicTransit
        .listIpsecTunnels({ accountId, xMagicNewHcTarget: true })
        .pipe(
          Effect.as(true),
          Effect.catchTag(["MagicTransitNotOnboarded", "Forbidden"], () =>
            Effect.succeed(false),
          ),
        );
      if (canList) {
        yield* Effect.logInfo(
          "account is Magic Transit-entitled; probe test is a no-op",
        );
        return;
      }

      // The typed tag — not UnknownCloudflareError, not a status check.
      const error = yield* magicTransit
        .listIpsecTunnels({ accountId, xMagicNewHcTarget: true })
        .pipe(Effect.flip);
      expect(["MagicTransitNotOnboarded", "Forbidden"]).toContain(error._tag);

      const createError = yield* magicTransit
        .createIpsecTunnel({
          accountId,
          xMagicNewHcTarget: true,
          name: "alch-ipsec-probe",
          cloudflareEndpoint: cfEndpoint,
          interfaceAddress: "10.213.11.10/31",
        })
        .pipe(Effect.flip);
      expect(["MagicTransitNotOnboarded", "Forbidden"]).toContain(
        createError._tag,
      );

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 120_000 },
);

test.provider(
  "list enumerates account IPsec tunnels (read-only [] when unentitled)",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const provider = yield* Provider.findProvider(
        Cloudflare.MagicTransit.IpsecTunnel,
      );

      if (!entitled) {
        // Unentitled accounts can't enumerate tunnels — list() swallows the
        // typed MagicTransitNotOnboarded/Forbidden gate and returns [].
        const all = yield* provider.list();
        expect(Array.isArray(all)).toBe(true);
        return;
      }

      const tunnel = yield* stack.deploy(
        Cloudflare.MagicTransit.IpsecTunnel("ListIpsec", {
          name: "alch-ipsec-list1",
          cloudflareEndpoint: cfEndpoint,
          interfaceAddress: "10.213.12.10/31",
          psk: Redacted.make("alchemy-test-psk-list"),
        }),
      );

      const all = yield* provider.list();
      expect(all.some((t) => t.tunnelId === tunnel.tunnelId)).toBe(true);
      const found = all.find((t) => t.tunnelId === tunnel.tunnelId)!;
      expect(found.name).toEqual("alch-ipsec-list1");
      expect(found.accountId).toEqual(tunnel.accountId);
      // PSK is write-only — list never reads it back.
      expect(found.psk).toBeUndefined();

      yield* stack.destroy();
      yield* expectGone(tunnel.accountId, tunnel.tunnelId);
    }).pipe(logLevel),
  { timeout: 120_000 },
);

test.provider.skipIf(!entitled)(
  "creates an IPsec tunnel, updates mutable props in place, and destroys it",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;

      yield* stack.destroy();

      const tunnel = yield* stack.deploy(
        Cloudflare.MagicTransit.IpsecTunnel("Ipsec", {
          name: "alch-ipsec-test1",
          cloudflareEndpoint: cfEndpoint,
          customerEndpoint: "198.51.100.20",
          interfaceAddress: "10.213.11.10/31",
          description: "alchemy ipsec tunnel test",
          psk: Redacted.make("alchemy-test-psk-1"),
        }),
      );

      expect(tunnel.tunnelId).toBeTruthy();
      expect(tunnel.accountId).toEqual(accountId);
      expect(tunnel.name).toEqual("alch-ipsec-test1");
      expect(tunnel.cloudflareEndpoint).toEqual(cfEndpoint);
      // The PSK is write-only — it is carried in state, never read back.
      expect(tunnel.psk && Redacted.value(tunnel.psk)).toEqual(
        "alchemy-test-psk-1",
      );

      // Out-of-band verification via the distilled API.
      const live = yield* getTunnel(accountId, tunnel.tunnelId);
      expect(live.ipsecTunnel?.name).toEqual("alch-ipsec-test1");
      expect(live.ipsecTunnel?.description).toEqual(
        "alchemy ipsec tunnel test",
      );

      // Update mutable props in place — same tunnelId.
      const updated = yield* stack.deploy(
        Cloudflare.MagicTransit.IpsecTunnel("Ipsec", {
          name: "alch-ipsec-test1",
          cloudflareEndpoint: cfEndpoint,
          customerEndpoint: "198.51.100.20",
          interfaceAddress: "10.213.11.10/31",
          description: "alchemy ipsec tunnel test v2",
          replayProtection: true,
          psk: Redacted.make("alchemy-test-psk-1"),
        }),
      );

      expect(updated.tunnelId).toEqual(tunnel.tunnelId);
      expect(updated.description).toEqual("alchemy ipsec tunnel test v2");
      expect(updated.replayProtection).toEqual(true);

      // The tunnel name is unique routing identity — changing it replaces.
      const replaced = yield* stack.deploy(
        Cloudflare.MagicTransit.IpsecTunnel("Ipsec", {
          name: "alch-ipsec-test2",
          cloudflareEndpoint: cfEndpoint,
          interfaceAddress: "10.213.11.10/31",
          psk: Redacted.make("alchemy-test-psk-1"),
        }),
      );

      expect(replaced.tunnelId).not.toEqual(tunnel.tunnelId);
      expect(replaced.name).toEqual("alch-ipsec-test2");
      yield* expectGone(accountId, tunnel.tunnelId);

      yield* stack.destroy();

      yield* expectGone(accountId, replaced.tunnelId);
    }).pipe(logLevel),
  { timeout: 120_000 },
);
