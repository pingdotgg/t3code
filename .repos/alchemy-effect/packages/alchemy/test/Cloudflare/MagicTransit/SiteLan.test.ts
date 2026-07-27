import * as Cloudflare from "@/Cloudflare";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import * as magicTransit from "@distilled.cloud/cloudflare/magic-transit";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";

const { test } = Test.make({ providers: Cloudflare.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

// Magic WAN sites (and their LANs) are entitlement-gated. On the standard
// testing account every Magic Transit call fails with the typed
// `MagicWanUnauthorized` error (Cloudflare code 1025) or `Forbidden` (403)
// depending on token scope. `list()` catches `MagicWanUnauthorized` and
// returns `[]`, so the read-only list assertion below always runs; the live
// deploy+enumerate case is gated behind an explicit opt-in env flag for
// entitled accounts.
const entitled = !!process.env.CLOUDFLARE_TEST_MAGIC_WAN;

test.provider(
  "list returns a well-typed array (empty on unentitled accounts)",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const provider = yield* Provider.findProvider(
        Cloudflare.MagicTransit.MagicSiteLan,
      );
      const all = yield* provider.list();

      // Either the exhaustively-paginated LANs (entitled) or [] (unentitled).
      expect(Array.isArray(all)).toBe(true);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 120_000 },
);

test.provider.skipIf(!entitled)(
  "list enumerates the deployed Magic WAN site LANs",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;

      yield* stack.destroy();

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          const site = yield* Cloudflare.MagicTransit.MagicSite("Site", {
            name: "alchemy-magic-site-lanlist",
            description: "alchemy magic site list test",
          });
          const lan = yield* Cloudflare.MagicTransit.MagicSiteLan("ListLan", {
            siteId: site.siteId,
            physport: 2,
            name: "alchemy-site-lan-list",
            vlanTag: 30,
            staticAddressing: { address: "192.168.30.1/24" },
          });
          return { site, lan };
        }),
      );

      expect(deployed.lan.lanId).toBeTruthy();

      const provider = yield* Provider.findProvider(
        Cloudflare.MagicTransit.MagicSiteLan,
      );
      const all = yield* provider.list();

      // The deployed LAN is present in the exhaustively-paginated result,
      // hydrated into the same Attributes shape `read` produces.
      const found = all.find((l) => l.lanId === deployed.lan.lanId);
      expect(found).toBeDefined();
      expect(found?.siteId).toEqual(deployed.site.siteId);
      expect(found?.accountId).toEqual(accountId);
      expect(found?.name).toEqual("alchemy-site-lan-list");

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 180_000 },
);
