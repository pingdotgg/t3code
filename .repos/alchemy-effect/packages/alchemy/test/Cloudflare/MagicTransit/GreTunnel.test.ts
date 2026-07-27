import * as Cloudflare from "@/Cloudflare";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import * as magicTransit from "@distilled.cloud/cloudflare/magic-transit";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: Cloudflare.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

// Magic Transit is an entitlement-gated product. On the standard testing
// account every Magic tunnel/route call fails with the typed
// `MagicTransitNotOnboarded` error (Cloudflare code 1012, "Magic Transit
// is not onboarded for this account") or `Forbidden` (403) depending on
// token scope. The lifecycle tests below are gated behind an explicit
// opt-in env flag for entitled accounts; the probe test always runs and
// pins the typed tag.
const entitled = !!process.env.CLOUDFLARE_TEST_MAGIC_TRANSIT;

// Entitled accounts must supply a real Cloudflare anycast endpoint that is
// allocated to the account — there is no way to derive one.
const cfEndpoint = process.env.CLOUDFLARE_TEST_MT_CF_ENDPOINT ?? "203.0.113.1";

const getTunnel = (accountId: string, greTunnelId: string) =>
  magicTransit.getGreTunnel({
    accountId,
    greTunnelId,
    xMagicNewHcTarget: true,
  });

// Poll until the tunnel is gone after destroy. Cloudflare answers GET for
// a missing tunnel with the typed `GreTunnelNotFound` (code 1029).
const expectGone = (accountId: string, greTunnelId: string) =>
  getTunnel(accountId, greTunnelId).pipe(
    Effect.flatMap(() => Effect.fail({ _tag: "TunnelNotDeleted" } as const)),
    Effect.catchTag("GreTunnelNotFound", () => Effect.void),
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
        .listGreTunnels({ accountId, xMagicNewHcTarget: true })
        .pipe(
          Effect.as(true),
          Effect.catchTag(["MagicTransitNotOnboarded", "Forbidden"], () =>
            Effect.succeed(false),
          ),
        );
      if (canList) {
        // Entitled account — the gated lifecycle test covers real behavior.
        yield* Effect.logInfo(
          "account is Magic Transit-entitled; probe test is a no-op",
        );
        return;
      }

      // The typed tag — not UnknownCloudflareError, not a status check.
      const error = yield* magicTransit
        .listGreTunnels({ accountId, xMagicNewHcTarget: true })
        .pipe(Effect.flip);
      expect(["MagicTransitNotOnboarded", "Forbidden"]).toContain(error._tag);

      const createError = yield* magicTransit
        .createGreTunnel({
          accountId,
          xMagicNewHcTarget: true,
          name: "alch-gre-probe",
          cloudflareGreEndpoint: cfEndpoint,
          customerGreEndpoint: "198.51.100.10",
          interfaceAddress: "10.213.10.10/31",
        })
        .pipe(Effect.flip);
      expect(["MagicTransitNotOnboarded", "Forbidden"]).toContain(
        createError._tag,
      );

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 120_000 },
);

// `list()` enumerates every GRE tunnel in the account. On an unentitled
// account the underlying `listGreTunnels` rejects with the typed
// `MagicTransitNotOnboarded` / `Forbidden` tags, which the provider maps to
// `[]` — so the read-only assertion is safe to run unconditionally. On an
// entitled account (CLOUDFLARE_TEST_MAGIC_TRANSIT=1) we deploy a tunnel and
// assert it shows up in the exhaustively-enumerated result.
test.provider(
  "list enumerates the deployed GRE tunnels",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const provider = yield* Provider.findProvider(
        Cloudflare.MagicTransit.GreTunnel,
      );

      if (!entitled) {
        // Unentitled: list() swallows the typed entitlement tag and yields [].
        const all = yield* provider.list();
        expect(Array.isArray(all)).toBe(true);
        return;
      }

      const tunnel = yield* stack.deploy(
        Cloudflare.MagicTransit.GreTunnel("ListGre", {
          name: "alch-gre-list",
          cloudflareGreEndpoint: cfEndpoint,
          customerGreEndpoint: "198.51.100.20",
          interfaceAddress: "10.213.20.20/31",
        }),
      );

      const all = yield* provider.list();
      expect(all.some((t) => t.tunnelId === tunnel.tunnelId)).toBe(true);
      expect(all.some((t) => t.name === "alch-gre-list")).toBe(true);

      yield* stack.destroy();
      yield* expectGone(tunnel.accountId, tunnel.tunnelId);
    }).pipe(logLevel),
  { timeout: 120_000 },
);

test.provider.skipIf(!entitled)(
  "creates a GRE tunnel, updates mutable props in place, and destroys it",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;

      yield* stack.destroy();

      const tunnel = yield* stack.deploy(
        Cloudflare.MagicTransit.GreTunnel("Gre", {
          name: "alch-gre-test1",
          cloudflareGreEndpoint: cfEndpoint,
          customerGreEndpoint: "198.51.100.10",
          interfaceAddress: "10.213.10.10/31",
          description: "alchemy gre tunnel test",
          ttl: 64,
          mtu: 1476,
        }),
      );

      expect(tunnel.tunnelId).toBeTruthy();
      expect(tunnel.accountId).toEqual(accountId);
      expect(tunnel.name).toEqual("alch-gre-test1");
      expect(tunnel.cloudflareGreEndpoint).toEqual(cfEndpoint);
      expect(tunnel.customerGreEndpoint).toEqual("198.51.100.10");
      expect(tunnel.interfaceAddress).toEqual("10.213.10.10/31");

      // Out-of-band verification via the distilled API.
      const live = yield* getTunnel(accountId, tunnel.tunnelId);
      expect(live.greTunnel?.name).toEqual("alch-gre-test1");
      expect(live.greTunnel?.description).toEqual("alchemy gre tunnel test");

      // Update mutable props in place — same tunnelId.
      const updated = yield* stack.deploy(
        Cloudflare.MagicTransit.GreTunnel("Gre", {
          name: "alch-gre-test1",
          cloudflareGreEndpoint: cfEndpoint,
          customerGreEndpoint: "198.51.100.10",
          interfaceAddress: "10.213.10.10/31",
          description: "alchemy gre tunnel test v2",
          ttl: 60,
          mtu: 1400,
        }),
      );

      expect(updated.tunnelId).toEqual(tunnel.tunnelId);
      expect(updated.description).toEqual("alchemy gre tunnel test v2");
      expect(updated.ttl).toEqual(60);
      expect(updated.mtu).toEqual(1400);

      // The tunnel name is its routing identity — changing it replaces.
      const replaced = yield* stack.deploy(
        Cloudflare.MagicTransit.GreTunnel("Gre", {
          name: "alch-gre-test2",
          cloudflareGreEndpoint: cfEndpoint,
          customerGreEndpoint: "198.51.100.10",
          interfaceAddress: "10.213.10.10/31",
        }),
      );

      expect(replaced.tunnelId).not.toEqual(tunnel.tunnelId);
      expect(replaced.name).toEqual("alch-gre-test2");
      yield* expectGone(accountId, tunnel.tunnelId);

      yield* stack.destroy();

      yield* expectGone(accountId, replaced.tunnelId);
    }).pipe(logLevel),
  { timeout: 120_000 },
);
