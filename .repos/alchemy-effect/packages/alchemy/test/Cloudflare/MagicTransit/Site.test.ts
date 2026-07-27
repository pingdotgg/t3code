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

// Magic WAN sites (and their LANs / WANs / ACLs) are entitlement-gated.
// On the standard testing account every site call fails with the typed
// `MagicWanUnauthorized` error (Cloudflare code 1025) or `Forbidden`
// (403) depending on token scope. The lifecycle test below is gated
// behind an explicit opt-in env flag for entitled accounts; the probe
// test always runs and pins the typed tag.
const entitled = !!process.env.CLOUDFLARE_TEST_MAGIC_WAN;

const getSite = (accountId: string, siteId: string) =>
  magicTransit.getSite({ accountId, siteId });

// Poll until the site is gone after destroy. Cloudflare answers GET for
// a missing site with the typed `SiteNotFound` (404).
const expectGone = (accountId: string, siteId: string) =>
  getSite(accountId, siteId).pipe(
    Effect.flatMap(() => Effect.fail({ _tag: "SiteNotDeleted" } as const)),
    Effect.catchTag("SiteNotFound", () => Effect.void),
    Effect.retry({
      while: (e) => e._tag === "SiteNotDeleted",
      schedule: Schedule.max([
        Schedule.exponential("500 millis"),
        Schedule.recurs(10),
      ]),
    }),
  );

test.provider(
  "unentitled accounts surface the typed MagicWanUnauthorized error",
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
        // Entitled account — the gated lifecycle test covers real behavior.
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

      const createError = yield* magicTransit
        .createSite({ accountId, name: "alchemy-site-probe" })
        .pipe(Effect.flip);
      expect(["MagicWanUnauthorized", "Forbidden"]).toContain(createError._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 120_000 },
);

// Canonical `list()` test (account collection): Magic WAN sites are
// account-scoped, so `list()` paginates the account-wide sites API and
// hydrates each into the `read` Attributes shape. On unentitled accounts
// enumeration is rejected with the typed `MagicWanUnauthorized` (1025) or
// `Forbidden` (403) and `list()` returns a well-typed `[]`. On entitled
// accounts (CLOUDFLARE_TEST_MAGIC_WAN=1) we deploy a site and assert it
// appears in the exhaustively-paginated result.
test.provider(
  "list enumerates account Magic WAN sites",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const provider = yield* Provider.findProvider(
        Cloudflare.MagicTransit.MagicSite,
      );

      if (!entitled) {
        // Unentitled account — `list()` swallows the typed entitlement /
        // permission rejection and yields an empty, well-typed array.
        const all = yield* provider.list();
        expect(all).toEqual([]);
        yield* stack.destroy();
        return;
      }

      const site = yield* stack.deploy(
        Cloudflare.MagicTransit.MagicSite("ListSite", {
          name: "alchemy-magic-site-list",
          description: "alchemy magic site list test",
        }),
      );
      expect(site.siteId).toBeTruthy();

      const all = yield* provider.list();
      expect(all.some((s) => s.siteId === site.siteId)).toBe(true);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 180_000 },
);

test.provider.skipIf(!entitled)(
  "creates a site with WAN, LAN, and ACL, updates in place, and destroys",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;

      yield* stack.destroy();

      const site = yield* stack.deploy(
        Cloudflare.MagicTransit.MagicSite("Site", {
          name: "alchemy-magic-site",
          description: "alchemy magic site test",
          location: { lat: "37.7749", lon: "-122.4194" },
        }),
      );

      expect(site.siteId).toBeTruthy();
      expect(site.accountId).toEqual(accountId);
      expect(site.name).toEqual("alchemy-magic-site");
      expect(site.description).toEqual("alchemy magic site test");

      // Out-of-band verification via the distilled API.
      const live = yield* getSite(accountId, site.siteId);
      expect(live.name).toEqual("alchemy-magic-site");

      const wan = yield* stack.deploy(
        Cloudflare.MagicTransit.MagicSiteWan("Wan", {
          siteId: site.siteId,
          physport: 1,
          name: "alchemy-site-wan",
          priority: 10,
        }),
      );
      expect(wan.wanId).toBeTruthy();
      expect(wan.siteId).toEqual(site.siteId);

      const lan1 = yield* stack.deploy(
        Cloudflare.MagicTransit.MagicSiteLan("Lan1", {
          siteId: site.siteId,
          physport: 2,
          name: "alchemy-site-lan1",
          vlanTag: 10,
          staticAddressing: { address: "192.168.10.1/24" },
        }),
      );
      const lan2 = yield* stack.deploy(
        Cloudflare.MagicTransit.MagicSiteLan("Lan2", {
          siteId: site.siteId,
          physport: 3,
          name: "alchemy-site-lan2",
          vlanTag: 20,
          staticAddressing: { address: "192.168.20.1/24" },
        }),
      );
      expect(lan1.lanId).toBeTruthy();
      expect(lan2.lanId).toBeTruthy();

      const acl = yield* stack.deploy(
        Cloudflare.MagicTransit.MagicSiteAcl("Acl", {
          siteId: site.siteId,
          name: "alchemy-site-acl",
          lan1: { lanId: lan1.lanId, ports: [443] },
          lan2: { lanId: lan2.lanId },
          protocols: ["tcp"],
        }),
      );
      expect(acl.aclId).toBeTruthy();
      expect(acl.siteId).toEqual(site.siteId);
      expect(acl.name).toEqual("alchemy-site-acl");

      // Update the site description in place — same siteId.
      const updated = yield* stack.deploy(
        Cloudflare.MagicTransit.MagicSite("Site", {
          name: "alchemy-magic-site",
          description: "alchemy magic site test v2",
          location: { lat: "37.7749", lon: "-122.4194" },
        }),
      );
      expect(updated.siteId).toEqual(site.siteId);
      expect(updated.description).toEqual("alchemy magic site test v2");

      yield* stack.destroy();

      yield* expectGone(accountId, site.siteId);
    }).pipe(logLevel),
  { timeout: 180_000 },
);
