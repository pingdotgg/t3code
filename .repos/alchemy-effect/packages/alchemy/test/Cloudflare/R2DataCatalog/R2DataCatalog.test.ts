import * as Cloudflare from "@/Cloudflare";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import * as rdc from "@distilled.cloud/cloudflare/r2-data-catalog";
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

interface CatalogOpts {
  compaction?: Cloudflare.R2.Compaction;
  snapshotExpiration?: Cloudflare.R2.SnapshotExpiration;
  token?: Redacted.Redacted<string>;
}

// One program deploying both the R2 bucket and the catalog enabled on it.
// `bucketName` references the bucket's output attribute, so the engine
// orders catalog-after-bucket on deploy (and the reverse on destroy).
const program = (opts: CatalogOpts = {}) =>
  Effect.gen(function* () {
    const bucket = yield* Cloudflare.R2.Bucket("CatalogBucket", {});
    const catalog = yield* Cloudflare.R2.DataCatalog("Catalog", {
      bucketName: bucket.bucketName,
      ...opts,
    });
    return { bucket, catalog };
  });

// The scoped API token the test harness mints propagates eventually-
// consistently across Cloudflare's edge — ride out 403 blips (`Forbidden`,
// declared in the distilled error union) on out-of-band verification calls.
const getCatalog = (accountId: string, bucketName: string) =>
  rdc.getR2DataCatalog({ accountId, bucketName }).pipe(
    Effect.retry({
      while: (e) => e._tag === "Forbidden",
      schedule: Schedule.exponential("500 millis"),
      times: 8,
    }),
  );

// After destroy the bucket is deleted along with the catalog, so a missing
// warehouse surfaces as `WarehouseNotFound` (code 40401) — the success
// condition here. An `inactive` status (bucket lingering) also counts as
// disabled.
const expectGone = (accountId: string, bucketName: string) =>
  getCatalog(accountId, bucketName).pipe(
    Effect.flatMap((catalog) =>
      catalog.status === "active"
        ? Effect.fail({ _tag: "CatalogStillActive" } as const)
        : Effect.void,
    ),
    Effect.catchTag("WarehouseNotFound", () => Effect.void),
    Effect.retry({
      while: (e) => e._tag === "CatalogStillActive",
      schedule: Schedule.max([
        Schedule.exponential("500 millis"),
        Schedule.recurs(10),
      ]),
    }),
  );

test.provider(
  "enable, sync maintenance config, register credential, destroy",
  (stack) =>
    Effect.gen(function* () {
      const env = yield* yield* CloudflareEnvironment;
      const { accountId } = env;

      yield* stack.destroy();

      // Create — enable the catalog on a fresh bucket.
      const initial = yield* stack.deploy(program());

      expect(initial.catalog.catalogId).toBeTruthy();
      expect(initial.catalog.bucketName).toEqual(initial.bucket.bucketName);
      expect(initial.catalog.accountId).toEqual(accountId);
      expect(initial.catalog.status).toEqual("active");
      expect(initial.catalog.name).toEqual(
        `${accountId}_${initial.bucket.bucketName}`,
      );
      expect(initial.catalog.catalogUri).toEqual(
        `https://catalog.cloudflarestorage.com/${accountId}/${initial.bucket.bucketName}`,
      );
      expect(initial.catalog.credentialStatus).toEqual("absent");

      const live = yield* getCatalog(accountId, initial.bucket.bucketName);
      expect(live.id).toEqual(initial.catalog.catalogId);
      expect(live.status).toEqual("active");

      // Update — sync maintenance config in place (same catalog id).
      const updated = yield* stack.deploy(
        program({
          compaction: { state: "disabled", targetSizeMb: "256" },
          snapshotExpiration: {
            state: "disabled",
            maxSnapshotAge: "3d",
            minSnapshotsToKeep: 5,
          },
        }),
      );

      expect(updated.catalog.catalogId).toEqual(initial.catalog.catalogId);
      expect(updated.catalog.compaction).toEqual({
        state: "disabled",
        targetSizeMb: "256",
      });
      expect(updated.catalog.snapshotExpiration).toEqual({
        state: "disabled",
        maxSnapshotAge: "3d",
        minSnapshotsToKeep: 5,
      });

      const liveUpdated = yield* getCatalog(
        accountId,
        initial.bucket.bucketName,
      );
      expect(liveUpdated.maintenanceConfig?.compaction).toEqual({
        state: "disabled",
        targetSizeMb: "256",
      });
      expect(liveUpdated.maintenanceConfig?.snapshotExpiration).toEqual({
        state: "disabled",
        maxSnapshotAge: "3d",
        minSnapshotsToKeep: 5,
      });

      // Update — register a maintenance credential (write-only; observable
      // only as credential_status flipping to "present").
      if (env.type === "apiToken") {
        const withCredential = yield* stack.deploy(
          program({
            compaction: { state: "disabled", targetSizeMb: "256" },
            snapshotExpiration: {
              state: "disabled",
              maxSnapshotAge: "3d",
              minSnapshotsToKeep: 5,
            },
            token: env.apiToken,
          }),
        );
        expect(withCredential.catalog.catalogId).toEqual(
          initial.catalog.catalogId,
        );
        expect(withCredential.catalog.credentialStatus).toEqual("present");

        const liveCredential = yield* getCatalog(
          accountId,
          initial.bucket.bucketName,
        );
        expect(liveCredential.credentialStatus).toEqual("present");
      }

      yield* stack.destroy();

      yield* expectGone(accountId, initial.bucket.bucketName);
    }).pipe(logLevel),
  { timeout: 240_000 },
);

test.provider(
  "list enumerates the deployed catalog",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;

      yield* stack.destroy();

      const deployed = yield* stack.deploy(program());
      expect(deployed.catalog.status).toEqual("active");

      const provider = yield* Provider.findProvider(Cloudflare.R2.DataCatalog);
      const all = yield* provider.list();

      // The freshly-enabled catalog is present in the account-wide listing,
      // hydrated into the exact `read` Attributes shape.
      const found = all.find((c) => c.catalogId === deployed.catalog.catalogId);
      expect(found).toBeDefined();
      expect(found?.bucketName).toEqual(deployed.bucket.bucketName);
      expect(found?.accountId).toEqual(deployed.catalog.accountId);
      expect(found?.name).toEqual(deployed.catalog.name);
      expect(found?.catalogUri).toEqual(deployed.catalog.catalogUri);
      expect(found?.status).toEqual("active");
      // Every entry is an active warehouse mapped to full Attributes.
      expect(all.every((c) => c.status === "active")).toBe(true);

      yield* stack.destroy();

      yield* expectGone(accountId, deployed.bucket.bucketName);
    }).pipe(logLevel),
  { timeout: 240_000 },
);

test.provider(
  "re-enables after out-of-band disable",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;

      yield* stack.destroy();

      const initial = yield* stack.deploy(
        program({ compaction: { targetSizeMb: "128" } }),
      );
      expect(initial.catalog.status).toEqual("active");

      // Disable the catalog out-of-band. A redeploy with identical props is a
      // planner no-op, so change a prop to force reconcile — it must observe
      // the catalog as inactive and re-enable it instead of failing.
      yield* rdc
        .disableR2DataCatalog({
          accountId,
          bucketName: initial.bucket.bucketName,
        })
        .pipe(
          Effect.retry({
            while: (e) => e._tag === "Forbidden",
            schedule: Schedule.exponential("500 millis"),
            times: 8,
          }),
        );

      const healed = yield* stack.deploy(
        program({ compaction: { targetSizeMb: "64" } }),
      );

      // The warehouse id is stable across disable/enable cycles — this is a
      // re-enable of the same catalog, not a replacement.
      expect(healed.catalog.catalogId).toEqual(initial.catalog.catalogId);
      expect(healed.catalog.status).toEqual("active");
      expect(healed.catalog.compaction?.targetSizeMb).toEqual("64");

      const live = yield* getCatalog(accountId, initial.bucket.bucketName);
      expect(live.status).toEqual("active");
      expect(live.maintenanceConfig?.compaction?.targetSizeMb).toEqual("64");

      yield* stack.destroy();

      yield* expectGone(accountId, initial.bucket.bucketName);
    }).pipe(logLevel),
  { timeout: 240_000 },
);
