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

// Magic WAN sites (and their LANs / ACLs) are entitlement-gated. On the
// standard testing account every site call fails with the typed
// `MagicWanUnauthorized` error (Cloudflare code 1025) or `Forbidden` (403)
// depending on token scope. The deploy path below is gated behind an
// explicit opt-in env flag for entitled accounts; the read-only `list()`
// assertion always runs because the provider maps those typed tags to `[]`.
const entitled = !!process.env.CLOUDFLARE_TEST_MAGIC_WAN;

// `list()` is a parent fan-out: it enumerates every Magic site (account
// scope) then lists each site's ACLs. On an unentitled account both
// `listSites` and `listSiteAcls` reject with the typed
// `MagicWanUnauthorized` / `Forbidden` tags, which the provider swallows to
// `[]` — so the read-only assertion is safe to run unconditionally. On an
// entitled account (CLOUDFLARE_TEST_MAGIC_WAN=1) we deploy a site with two
// LANs and an ACL, then assert the ACL shows up in the result.
test.provider(
  "list enumerates the deployed site ACLs",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;

      yield* stack.destroy();

      const provider = yield* Provider.findProvider(
        Cloudflare.MagicTransit.MagicSiteAcl,
      );

      if (!entitled) {
        // Unentitled: list() swallows the typed entitlement tag and yields [].
        const all = yield* provider.list();
        expect(Array.isArray(all)).toBe(true);
        return;
      }

      const site = yield* stack.deploy(
        Cloudflare.MagicTransit.MagicSite("ListSite", {
          name: "alch-acl-list-site",
          description: "alchemy site acl list test",
        }),
      );
      const lan1 = yield* stack.deploy(
        Cloudflare.MagicTransit.MagicSiteLan("ListLan1", {
          siteId: site.siteId,
          physport: 2,
          name: "alch-acl-list-lan1",
          vlanTag: 10,
          staticAddressing: { address: "192.168.30.1/24" },
        }),
      );
      const lan2 = yield* stack.deploy(
        Cloudflare.MagicTransit.MagicSiteLan("ListLan2", {
          siteId: site.siteId,
          physport: 3,
          name: "alch-acl-list-lan2",
          vlanTag: 20,
          staticAddressing: { address: "192.168.40.1/24" },
        }),
      );
      const acl = yield* stack.deploy(
        Cloudflare.MagicTransit.MagicSiteAcl("ListAcl", {
          siteId: site.siteId,
          name: "alch-acl-list",
          lan1: { lanId: lan1.lanId, ports: [443] },
          lan2: { lanId: lan2.lanId },
          protocols: ["tcp"],
        }),
      );

      const all = yield* provider.list();
      expect(all.some((a) => a.aclId === acl.aclId)).toBe(true);
      expect(
        all.some((a) => a.name === "alch-acl-list" && a.siteId === site.siteId),
      ).toBe(true);
      // Every hydrated row carries the ambient account scope.
      expect(all.every((a) => a.accountId === accountId)).toBe(true);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 180_000 },
);

test.provider(
  "unentitled accounts surface the typed Magic WAN error for ACL listing",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;

      yield* stack.destroy();

      const canList = yield* magicTransit.listSites({ accountId }).pipe(
        Effect.as(true),
        Effect.catchTag(["MagicWanUnauthorized", "Forbidden"], () =>
          Effect.succeed(false),
        ),
      );
      if (canList) {
        // Entitled account — the list test above covers real behavior.
        yield* Effect.logInfo(
          "account is Magic WAN-entitled; probe test is a no-op",
        );
        return;
      }

      // The typed tag — not UnknownCloudflareError, not a status check.
      const error = yield* magicTransit
        .listSites({ accountId })
        .pipe(Effect.flip);
      expect(["MagicWanUnauthorized", "Forbidden"]).toContain(error._tag);

      // Despite the gating, list() degrades to an empty array.
      const provider = yield* Provider.findProvider(
        Cloudflare.MagicTransit.MagicSiteAcl,
      );
      expect(yield* provider.list()).toEqual([]);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 120_000 },
);
