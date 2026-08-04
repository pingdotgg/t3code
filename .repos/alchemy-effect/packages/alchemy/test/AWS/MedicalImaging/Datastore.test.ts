import * as AWS from "@/AWS";
import { Datastore } from "@/AWS/MedicalImaging";
import * as Test from "@/Test/Alchemy";
import * as medicalimaging from "@distilled.cloud/aws/medical-imaging";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: AWS.providers() });

// Ungated typed-error probe: prove the distilled error union carries the
// not-found tag this provider's read/delete paths depend on. Runs in every
// CI pass at near-zero cost, unlike the gated lifecycle below.
test.provider(
  "getDatastore on a nonexistent id fails with ResourceNotFoundException",
  () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        // well-formed (32 hex chars) but nonexistent datastore id
        medicalimaging.getDatastore({
          datastoreId: "00000000000000000000000000000000",
        }),
      );
      expect(error._tag).toBe("ResourceNotFoundException");
    }),
);

// Deletion is async (DELETING → gone); poll bounded until the store no
// longer resolves (or reports DELETED).
const assertDatastoreGone = (datastoreId: string) =>
  Effect.gen(function* () {
    const status = yield* medicalimaging.getDatastore({ datastoreId }).pipe(
      Effect.map(
        (r) => r.datastoreProperties.datastoreStatus as string | "gone",
      ),
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
        Schedule.recurs(30),
      ]),
    }),
  );

// A HealthImaging data store provisions asynchronously (CREATING → ACTIVE,
// typically a few minutes) and deletes asynchronously too — the full
// lifecycle is gated behind AWS_TEST_MEDICAL_IMAGING=1 and always destroys
// what it created.
test.provider.skipIf(!process.env.AWS_TEST_MEDICAL_IMAGING)(
  "create data store, update tags, destroy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { datastore } = yield* stack.deploy(
        Effect.gen(function* () {
          const datastore = yield* Datastore("Store", {
            tags: { fixture: "medical-imaging" },
          });
          return { datastore };
        }),
      );

      expect(datastore.datastoreId).toBeDefined();
      expect(datastore.datastoreArn).toContain(":datastore/");
      expect(datastore.datastoreStatus).toBe("ACTIVE");
      expect(datastore.tags.fixture).toBe("medical-imaging");

      // Out-of-band verification via distilled.
      const observed = yield* medicalimaging.getDatastore({
        datastoreId: datastore.datastoreId,
      });
      expect(observed.datastoreProperties.datastoreStatus).toBe("ACTIVE");
      expect(observed.datastoreProperties.datastoreName).toBe(
        datastore.datastoreName,
      );

      // Update path: tags are the only mutable aspect (HealthImaging has no
      // UpdateDatastore); the same physical store must be reused.
      const { datastore: updated } = yield* stack.deploy(
        Effect.gen(function* () {
          const datastore = yield* Datastore("Store", {
            tags: { fixture: "medical-imaging", extra: "added" },
          });
          return { datastore };
        }),
      );
      expect(updated.datastoreId).toBe(datastore.datastoreId);
      expect(updated.tags.extra).toBe("added");

      const observedTags = yield* medicalimaging.listTagsForResource({
        resourceArn: datastore.datastoreArn,
      });
      expect(observedTags.tags?.extra).toBe("added");

      // Destroy and verify deletion completes out-of-band (DELETING → gone).
      yield* stack.destroy();
      yield* assertDatastoreGone(datastore.datastoreId);
    }),
  // async create (a few minutes) + tag update + async delete, one test.
  { timeout: 1_200_000 },
);
