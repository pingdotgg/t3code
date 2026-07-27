import * as Cloudflare from "@/Cloudflare";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import { findZoneByName } from "@/Cloudflare/Zone/lookup";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import * as rum from "@distilled.cloud/cloudflare/rum";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: Cloudflare.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const zoneName = "alchemy-test-2.us";

// The scoped API token the test harness mints propagates eventually-
// consistently across Cloudflare's edge — ride out 403 blips
// (`Forbidden`, declared in the distilled error union) on the test's
// own out-of-band verification calls.
const getSite = (accountId: string, siteTag: string) =>
  rum.getSiteInfo({ accountId, siteId: siteTag }).pipe(
    Effect.retry({
      while: (e) => e._tag === "Forbidden",
      schedule: Schedule.exponential("500 millis"),
      times: 8,
    }),
  );

const expectGone = (accountId: string, siteTag: string) =>
  getSite(accountId, siteTag).pipe(
    Effect.flatMap(() => Effect.fail({ _tag: "SiteNotDeleted" } as const)),
    // A missing site surfaces as `SiteNotFound` (Cloudflare error code
    // 10015) — that's the success condition here.
    Effect.catchTag("SiteNotFound", () => Effect.void),
    Effect.retry({
      while: (e) => e._tag === "SiteNotDeleted",
      schedule: Schedule.max([
        Schedule.exponential("500 millis"),
        Schedule.recurs(10),
      ]),
    }),
  );

test.provider("create and delete a host (gray-clouded) site", (stack) =>
  Effect.gen(function* () {
    const { accountId } = yield* yield* CloudflareEnvironment;

    yield* stack.destroy();

    const site = yield* stack.deploy(
      Cloudflare.Rum.Site("HostSite", {
        host: `create.${zoneName}`,
      }),
    );

    expect(site.siteTag).toBeTruthy();
    expect(site.siteToken).toBeTruthy();
    expect(site.snippet).toContain(site.siteToken);
    expect(site.accountId).toEqual(accountId);
    expect(site.host).toEqual(`create.${zoneName}`);
    expect(site.autoInstall).toEqual(false);

    // Verify out-of-band against the live API.
    const live = yield* getSite(accountId, site.siteTag);
    expect(live.siteTag).toEqual(site.siteTag);
    expect(live.host).toEqual(`create.${zoneName}`);

    yield* stack.destroy();

    yield* expectGone(accountId, site.siteTag);
  }).pipe(logLevel),
);

test.provider("update mutable props in place (same siteTag)", (stack) =>
  Effect.gen(function* () {
    const { accountId } = yield* yield* CloudflareEnvironment;

    yield* stack.destroy();

    const initial = yield* stack.deploy(
      Cloudflare.Rum.Site("UpdateSite", {
        host: `update.${zoneName}`,
      }),
    );

    expect(initial.host).toEqual(`update.${zoneName}`);
    expect(initial.autoInstall).toEqual(false);

    // Changing the hostname is an in-place update of the same site.
    const updated = yield* stack.deploy(
      Cloudflare.Rum.Site("UpdateSite", {
        host: `update-v2.${zoneName}`,
      }),
    );

    expect(updated.siteTag).toEqual(initial.siteTag);
    expect(updated.siteToken).toEqual(initial.siteToken);
    expect(updated.host).toEqual(`update-v2.${zoneName}`);

    const live = yield* getSite(accountId, updated.siteTag);
    expect(live.host).toEqual(`update-v2.${zoneName}`);

    // Redeploying identical props is a no-op (still the same site).
    const noop = yield* stack.deploy(
      Cloudflare.Rum.Site("UpdateSite", {
        host: `update-v2.${zoneName}`,
      }),
    );
    expect(noop.siteTag).toEqual(initial.siteTag);

    yield* stack.destroy();

    yield* expectGone(accountId, initial.siteTag);
  }).pipe(logLevel),
);

test.provider(
  "zone (orange-clouded) site with autoInstall, replaced on identity flip",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const zone = yield* findZoneByName({ accountId, name: zoneName });
      if (!zone) {
        return yield* Effect.die(
          new Error(`zone "${zoneName}" not found in account`),
        );
      }

      yield* stack.destroy();

      const zoneSite = yield* stack.deploy(
        Cloudflare.Rum.Site("FlipSite", {
          zoneTag: zone.id,
          autoInstall: true,
        }),
      );

      expect(zoneSite.siteTag).toBeTruthy();
      expect(zoneSite.zoneTag).toEqual(zone.id);
      expect(zoneSite.autoInstall).toEqual(true);
      // Zone-based sites get an implicit ruleset.
      expect(zoneSite.rulesetId).toBeTruthy();

      // Toggle autoInstall in place — same site.
      const toggled = yield* stack.deploy(
        Cloudflare.Rum.Site("FlipSite", {
          zoneTag: zone.id,
          autoInstall: false,
        }),
      );
      expect(toggled.siteTag).toEqual(zoneSite.siteTag);
      expect(toggled.autoInstall).toEqual(false);

      // Switching to host-based measurement changes the identity model —
      // the site must be replaced (new siteTag) and the old one deleted.
      const replaced = yield* stack.deploy(
        Cloudflare.Rum.Site("FlipSite", {
          host: `flip.${zoneName}`,
        }),
      );
      expect(replaced.siteTag).not.toEqual(zoneSite.siteTag);
      expect(replaced.host).toEqual(`flip.${zoneName}`);

      yield* expectGone(accountId, zoneSite.siteTag);

      yield* stack.destroy();

      yield* expectGone(accountId, replaced.siteTag);
    }).pipe(logLevel),
);

test.provider("list enumerates the deployed RUM site", (stack) =>
  Effect.gen(function* () {
    yield* stack.destroy();

    const deployed = yield* stack.deploy(
      Cloudflare.Rum.Site("ListSite", {
        host: `list.${zoneName}`,
      }),
    );

    const provider = yield* Provider.findProvider(Cloudflare.Rum.Site);
    const all = yield* provider.list();

    expect(all.some((s) => s.siteTag === deployed.siteTag)).toBe(true);

    yield* stack.destroy();
  }).pipe(logLevel),
);

test.provider("recreates after out-of-band delete", (stack) =>
  Effect.gen(function* () {
    const { accountId } = yield* yield* CloudflareEnvironment;

    yield* stack.destroy();

    const site = yield* stack.deploy(
      Cloudflare.Rum.Site("HealSite", {
        host: `heal.${zoneName}`,
      }),
    );

    // Delete the site out-of-band. A redeploy with identical props is a
    // planner no-op, so change a prop to force reconcile — it must observe
    // the site as missing and recreate it instead of failing on a 404.
    yield* rum.deleteSiteInfo({ accountId, siteId: site.siteTag }).pipe(
      Effect.retry({
        while: (e) => e._tag === "Forbidden",
        schedule: Schedule.exponential("500 millis"),
        times: 8,
      }),
    );

    const healed = yield* stack.deploy(
      Cloudflare.Rum.Site("HealSite", {
        host: `heal-v2.${zoneName}`,
      }),
    );

    expect(healed.siteTag).not.toEqual(site.siteTag);
    expect(healed.host).toEqual(`heal-v2.${zoneName}`);
    const live = yield* getSite(accountId, healed.siteTag);
    expect(live.host).toEqual(`heal-v2.${zoneName}`);

    yield* stack.destroy();

    yield* expectGone(accountId, healed.siteTag);
  }).pipe(logLevel),
);
