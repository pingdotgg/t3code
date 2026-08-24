import * as AWS from "@/AWS";
import { FHIRDatastore } from "@/AWS/HealthLake";
import * as Test from "@/Test/Alchemy";
import * as healthlake from "@distilled.cloud/aws/healthlake";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: AWS.providers() });

// Ungated typed-error probe: prove the distilled error union carries the
// not-found tag this provider's read/delete paths depend on. Runs in every
// CI pass at near-zero cost, unlike the gated lifecycle below.
test.provider(
  "describeFHIRDatastore on a nonexistent datastore fails with ResourceNotFoundException",
  () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        healthlake.describeFHIRDatastore({
          DatastoreId: "0123456789abcdef0123456789abcdef",
        }),
      );
      expect(error._tag).toBe("ResourceNotFoundException");
    }),
);

// The provider's delete already waits until the data store is gone; this
// out-of-band check confirms it (gone, or terminal DELETED status).
const assertDatastoreGone = (datastoreId: string) =>
  Effect.gen(function* () {
    const status = yield* healthlake
      .describeFHIRDatastore({ DatastoreId: datastoreId })
      .pipe(
        Effect.map((r) => r.DatastoreProperties.DatastoreStatus),
        Effect.catchTag("ResourceNotFoundException", () =>
          Effect.succeed("gone" as const),
        ),
      );
    if (status !== "gone" && status !== "DELETED") {
      return yield* Effect.fail(
        new Error(
          `datastore '${datastoreId}' still exists (status: ${status})`,
        ),
      );
    }
  }).pipe(
    Effect.retry({
      schedule: Schedule.max([
        Schedule.fixed("10 seconds"),
        Schedule.recurs(8),
      ]),
    }),
  );

// A HealthLake FHIR data store takes ~15-30 minutes to provision (and
// several more to delete) and bills while it exists. The full lifecycle is
// gated behind AWS_TEST_HEALTHLAKE=1 and always destroys what it created.
test.provider.skipIf(!process.env.AWS_TEST_HEALTHLAKE)(
  "create FHIR R4 datastore, verify, update tags, destroy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { datastore } = yield* stack.deploy(
        Effect.gen(function* () {
          const datastore = yield* FHIRDatastore("Records", {
            tags: { fixture: "healthlake-datastore" },
          });
          return { datastore };
        }),
      );

      expect(datastore.datastoreId).toBeDefined();
      expect(datastore.datastoreArn).toContain(":datastore/fhir/");
      expect(datastore.datastoreStatus).toBe("ACTIVE");
      expect(datastore.datastoreTypeVersion).toBe("R4");
      expect(datastore.datastoreEndpoint).toContain("healthlake");
      expect(datastore.tags.fixture).toBe("healthlake-datastore");

      // Out-of-band verification via distilled.
      const described = yield* healthlake.describeFHIRDatastore({
        DatastoreId: datastore.datastoreId,
      });
      expect(described.DatastoreProperties.DatastoreStatus).toBe("ACTIVE");
      expect(described.DatastoreProperties.DatastoreTypeVersion).toBe("R4");
      expect(described.DatastoreProperties.DatastoreName).toBe(
        datastore.datastoreName,
      );

      // Idempotent re-deploy with a tag change syncs in place (no replace,
      // no second 15-30min provisioning wait — the datastore is ACTIVE).
      const { datastore: updated } = yield* stack.deploy(
        Effect.gen(function* () {
          const datastore = yield* FHIRDatastore("Records", {
            tags: { fixture: "healthlake-datastore", updated: "true" },
          });
          return { datastore };
        }),
      );
      expect(updated.datastoreId).toBe(datastore.datastoreId);
      expect(updated.tags.updated).toBe("true");

      // Destroy — datastores bill while they exist — and verify deletion
      // out-of-band. The provider waits until the datastore is gone.
      yield* stack.destroy();
      yield* assertDatastoreGone(datastore.datastoreId);
    }),
  // create (~15-30 min) + tag sync + delete wait-until-gone, one test.
  { timeout: 5_400_000 },
);
