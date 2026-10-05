import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as firestore from "@distilled.cloud/gcp/firestore_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import { GcpEnvironment } from "@/GCP/Environment";

const { test } = Test.make({ providers: GCP.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const runLifecycle = !process.env.FAST;

const waitUntilGone = (name: string) =>
  firestore.getProjectsDatabasesCollectionGroupsIndexes({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "getProjectsDatabasesCollectionGroupsIndexes on a missing index fails with NotFound",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;

      yield* stack.destroy();

      const error = yield* Effect.flip(
        firestore.getProjectsDatabasesCollectionGroupsIndexes({
          name: `projects/${project}/databases/alchemy-missing-xxxx/collectionGroups/users/indexes/alchemy-missing`,
        }),
      );
      expect(error._tag).toBe("NotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:firestore", "live"], timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create, replace, and delete a firestore composite index",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const database = yield* GCP.Firestore.Database("App", {
            location: "us-central1",
            type: "FIRESTORE_NATIVE",
          });
          const index = yield* GCP.Firestore.DatabasesCollectionGroupsIndex(
            "UsersByName",
            {
              database: database.name,
              collectionGroup: "users",
              queryScope: "COLLECTION",
              fields: [
                { fieldPath: "name", order: "ASCENDING" },
                { fieldPath: "created", order: "DESCENDING" },
              ],
            },
          );
          return { database, index };
        }),
      );

      expect(created.index.name).toContain("/indexes/");
      expect(created.index.databaseId).toEqual(created.database.databaseId);
      expect(created.index.collectionGroupId).toEqual("users");
      expect(created.index.queryScope).toEqual("COLLECTION");

      const fetched =
        yield* firestore.getProjectsDatabasesCollectionGroupsIndexes({
          name: created.index.name,
        });
      expect(fetched.name).toEqual(created.index.name);
      expect(fetched.queryScope).toEqual("COLLECTION");
      expect(
        (fetched.fields ?? []).some((field) => field.fieldPath === "name"),
      ).toEqual(true);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const database = yield* GCP.Firestore.Database("App", {
            databaseId: created.database.databaseId,
            location: "us-central1",
            type: "FIRESTORE_NATIVE",
          });
          const index = yield* GCP.Firestore.DatabasesCollectionGroupsIndex(
            "UsersByName",
            {
              database: database.name,
              collectionGroup: "users",
              queryScope: "COLLECTION",
              fields: [
                { fieldPath: "email", order: "ASCENDING" },
                { fieldPath: "created", order: "DESCENDING" },
              ],
            },
          );
          return { database, index };
        }),
      );

      expect(updated.index.collectionGroupId).toEqual("users");
      expect(
        updated.index.fields.some((field) => field.fieldPath === "email"),
      ).toEqual(true);

      const refetched =
        yield* firestore.getProjectsDatabasesCollectionGroupsIndexes({
          name: updated.index.name,
        });
      expect(
        (refetched.fields ?? []).some((field) => field.fieldPath === "email"),
      ).toEqual(true);

      yield* stack.destroy();

      const gone = yield* waitUntilGone(updated.index.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:firestore", "live"],
    timeout: 180_000,
  },
);
