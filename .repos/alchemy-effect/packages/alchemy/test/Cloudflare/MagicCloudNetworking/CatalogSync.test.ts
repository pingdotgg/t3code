import * as Cloudflare from "@/Cloudflare";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import * as mcn from "@distilled.cloud/cloudflare/magic-cloud-networking";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: Cloudflare.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

// Magic Cloud Networking is an entitlement-gated add-on (Magic WAN family).
// On the standard testing account every MCN call fails with the typed
// `FeatureNotEnabled` error (HTTP 403, Cloudflare code 1012 "feature not
// enabled"). The full lifecycle tests below are gated behind an explicit
// opt-in env flag for entitled accounts; the probe test always runs and
// pins the typed tag.
const entitled = !!process.env.CLOUDFLARE_TEST_MAGIC_CLOUD_NETWORKING;

// The scoped API token the test harness mints propagates eventually-
// consistently across Cloudflare's edge — ride out 403 blips (`Forbidden`,
// declared in the distilled error union) on out-of-band calls. The retry
// is bounded so an unentitled account fails fast with the typed tag.
const getSync = (accountId: string, syncId: string) =>
  mcn.getCatalogSync({ accountId, syncId }).pipe(
    Effect.retry({
      while: (e) => e._tag === "Forbidden",
      schedule: Schedule.exponential("500 millis"),
      times: 5,
    }),
  );

// Poll until the sync is gone after destroy. Cloudflare answers GET for a
// missing sync with the typed `CatalogSyncNotFound` (404).
const expectGone = (accountId: string, syncId: string) =>
  getSync(accountId, syncId).pipe(
    Effect.flatMap(() => Effect.fail({ _tag: "SyncNotDeleted" } as const)),
    Effect.catchTag("CatalogSyncNotFound", () => Effect.void),
    Effect.retry({
      while: (e) => e._tag === "SyncNotDeleted",
      schedule: Schedule.max([
        Schedule.exponential("500 millis"),
        Schedule.recurs(10),
      ]),
    }),
  );

test.provider(
  "unentitled accounts surface the typed FeatureNotEnabled error",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;

      yield* stack.destroy();

      const canList = yield* mcn.listCatalogSyncs({ accountId }).pipe(
        Effect.as(true),
        Effect.catchTag("FeatureNotEnabled", () => Effect.succeed(false)),
      );
      if (canList) {
        // Entitled account — the gated lifecycle test covers real behavior.
        yield* Effect.logInfo("account is MCN-entitled; probe test is a no-op");
        return;
      }

      // The typed tag — not UnknownCloudflareError, not a status check.
      const error = yield* mcn
        .listCatalogSyncs({ accountId })
        .pipe(Effect.flip);
      expect(error._tag).toEqual("FeatureNotEnabled");

      const createError = yield* mcn
        .createCatalogSync({
          accountId,
          name: "alchemy-mcn-probe",
          destinationType: "NONE",
          updateMode: "MANUAL",
        })
        .pipe(Effect.flip);
      expect(createError._tag).toEqual("FeatureNotEnabled");

      yield* stack.destroy();
    }).pipe(logLevel),
);

test.provider.skipIf(!entitled)(
  "creates a sync, updates mutable props in place, and destroys it",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;

      yield* stack.destroy();

      const sync = yield* stack.deploy(
        Cloudflare.MagicCloudNetworking.CatalogSync("Sync", {
          name: "alchemy-mcn-catalog-sync",
          destinationType: "NONE",
          updateMode: "MANUAL",
          description: "alchemy catalog sync test",
        }),
      );

      expect(sync.syncId).toBeDefined();
      expect(sync.accountId).toEqual(accountId);
      expect(sync.name).toEqual("alchemy-mcn-catalog-sync");
      expect(sync.destinationType).toEqual("NONE");
      expect(sync.updateMode).toEqual("MANUAL");
      expect(sync.description).toEqual("alchemy catalog sync test");

      // Out-of-band verification via the distilled API.
      const live = yield* getSync(accountId, sync.syncId);
      expect(live.name).toEqual("alchemy-mcn-catalog-sync");
      expect(live.updateMode).toEqual("MANUAL");

      // Update mutable props in place — same syncId.
      const updated = yield* stack.deploy(
        Cloudflare.MagicCloudNetworking.CatalogSync("Sync", {
          name: "alchemy-mcn-catalog-sync-v2",
          destinationType: "NONE",
          updateMode: "AUTO",
          description: "alchemy catalog sync test v2",
        }),
      );

      expect(updated.syncId).toEqual(sync.syncId);
      expect(updated.name).toEqual("alchemy-mcn-catalog-sync-v2");
      expect(updated.updateMode).toEqual("AUTO");
      expect(updated.description).toEqual("alchemy catalog sync test v2");

      const liveUpdated = yield* getSync(accountId, sync.syncId);
      expect(liveUpdated.name).toEqual("alchemy-mcn-catalog-sync-v2");
      expect(liveUpdated.updateMode).toEqual("AUTO");

      yield* stack.destroy();

      yield* expectGone(accountId, sync.syncId);
    }).pipe(logLevel),
  { timeout: 120_000 },
);

// On unentitled accounts `list()` swallows the typed `FeatureNotEnabled`
// error and returns `[]`, so the read-only assertion runs everywhere. On an
// entitled account we additionally deploy a sync and assert it shows up in
// the exhaustively-paginated result.
test.provider(
  "list enumerates account catalog syncs",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const provider = yield* Provider.findProvider(
        Cloudflare.MagicCloudNetworking.CatalogSync,
      );

      const before = yield* provider.list();
      expect(Array.isArray(before)).toBe(true);

      if (!entitled) {
        // Unentitled — FeatureNotEnabled is caught and mapped to [].
        expect(before).toEqual([]);
        yield* stack.destroy();
        return;
      }

      const deployed = yield* stack.deploy(
        Cloudflare.MagicCloudNetworking.CatalogSync("ListSync", {
          name: "alchemy-mcn-catalog-sync-list",
          destinationType: "NONE",
          updateMode: "MANUAL",
        }),
      );

      const all = yield* provider.list();
      expect(all.some((s) => s.syncId === deployed.syncId)).toBe(true);

      yield* stack.destroy();

      yield* expectGone(deployed.accountId, deployed.syncId);
    }).pipe(logLevel),
  { timeout: 120_000 },
);

test.provider.skipIf(!entitled)(
  "replaces the sync when destinationType changes",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;

      yield* stack.destroy();

      const initial = yield* stack.deploy(
        Cloudflare.MagicCloudNetworking.CatalogSync("ReplaceSync", {
          name: "alchemy-mcn-catalog-sync-replace",
          destinationType: "NONE",
          updateMode: "MANUAL",
        }),
      );

      // destinationType is provisioned at create time — changing it must
      // produce a brand-new sync (new syncId).
      const replaced = yield* stack.deploy(
        Cloudflare.MagicCloudNetworking.CatalogSync("ReplaceSync", {
          name: "alchemy-mcn-catalog-sync-replace",
          destinationType: "ZERO_TRUST_LIST",
          updateMode: "MANUAL",
        }),
      );

      expect(replaced.syncId).not.toEqual(initial.syncId);
      expect(replaced.destinationType).toEqual("ZERO_TRUST_LIST");
      expect(replaced.destinationId).toBeTruthy();

      yield* expectGone(accountId, initial.syncId);

      yield* stack.destroy();

      yield* expectGone(accountId, replaced.syncId);
    }).pipe(logLevel),
  { timeout: 120_000 },
);
