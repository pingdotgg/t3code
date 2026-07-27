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

// Magic WAN sites (and their WANs) are entitlement-gated. On the standard
// testing account every site call fails with the typed `MagicWanUnauthorized`
// error (Cloudflare code 1025) or `Forbidden` (403) depending on token scope.
// The deploy+list lifecycle test below is gated behind an explicit opt-in env
// flag for entitled accounts; the read-only list probe always runs and asserts
// a well-typed array (empty on unentitled accounts).
const entitled = !!process.env.CLOUDFLARE_TEST_MAGIC_WAN;

test.provider(
  "list returns a well-typed array of site WANs",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const provider = yield* Provider.findProvider(
        Cloudflare.MagicTransit.MagicSiteWan,
      );
      const all = yield* provider.list();

      // Unentitled accounts surface MagicWanUnauthorized/Forbidden, which list()
      // maps to []. Either way the result is a well-typed array, never a throw.
      expect(Array.isArray(all)).toBe(true);
      for (const wan of all) {
        expect(typeof wan.wanId).toBe("string");
        expect(typeof wan.siteId).toBe("string");
        expect(typeof wan.accountId).toBe("string");
      }

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 120_000 },
);

test.provider.skipIf(!entitled)(
  "list enumerates the deployed site WAN",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;

      yield* stack.destroy();

      const site = yield* stack.deploy(
        Cloudflare.MagicTransit.MagicSite("Site", {
          name: "alchemy-wan-list-site",
          description: "alchemy magic site wan list test",
        }),
      );

      const wan = yield* stack.deploy(
        Cloudflare.MagicTransit.MagicSiteWan("Wan", {
          siteId: site.siteId,
          physport: 1,
          name: "alchemy-wan-list",
          priority: 10,
        }),
      );
      expect(wan.wanId).toBeTruthy();

      // Out-of-band sanity check via the distilled API.
      const live = yield* magicTransit.listSiteWans({
        accountId,
        siteId: site.siteId,
      });
      expect(live.result.some((w) => w.id === wan.wanId)).toBe(true);

      const provider = yield* Provider.findProvider(
        Cloudflare.MagicTransit.MagicSiteWan,
      );
      const all = yield* provider.list();

      expect(all.some((w) => w.wanId === wan.wanId)).toBe(true);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 180_000 },
);
