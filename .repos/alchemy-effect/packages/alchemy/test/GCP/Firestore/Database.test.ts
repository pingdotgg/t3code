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

const waitUntilGone = (name: string) =>
  firestore.getProjectsDatabases({ name }).pipe(
    Effect.map((database) =>
      database.deleteTime !== undefined
        ? ("gone" as const)
        : ("found" as const),
    ),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "getProjectsDatabases on a missing database fails with NotFound",
  () =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;

      const error = yield* Effect.flip(
        firestore.getProjectsDatabases({
          name: `projects/${project}/databases/alchemy-missing-xxxx`,
        }),
      );
      expect(error._tag).toBe("NotFound");

      const page = yield* firestore.listProjectsDatabases({
        parent: `projects/${project}`,
      });
      expect(
        (page.databases ?? []).map((database) => database.name),
      ).not.toContain(`projects/${project}/databases/alchemy-missing-xxxx`);
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:firestore", "live"], timeout: 90_000 },
);

test.provider.skipIf(!!process.env.FAST)(
  "create, update, and delete a firestore database",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Firestore.Database("App", {
            location: "us-central1",
            type: "FIRESTORE_NATIVE",
          });
        }),
      );

      expect(created.name).toContain("/databases/");
      expect(created.databaseId).toEqual(expect.any(String));
      expect(created.databaseId.length).toBeGreaterThanOrEqual(4);
      expect(created.location).toEqual("us-central1");
      expect(created.type).toEqual("FIRESTORE_NATIVE");
      expect(created.deleteProtectionState).toEqual(
        "DELETE_PROTECTION_DISABLED",
      );

      const fetched = yield* firestore.getProjectsDatabases({
        name: created.name,
      });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.locationId).toEqual("us-central1");
      expect(fetched.type).toEqual("FIRESTORE_NATIVE");

      // Alchemy writes no data into the database.
      const collections =
        yield* firestore.listCollectionIdsProjectsDatabasesDocuments({
          parent: `${created.name}/documents`,
          body: {},
        });
      expect(collections.collectionIds ?? []).toEqual([]);

      yield* firestore.patchProjectsDatabasesDocuments({
        name: `${created.name}/documents/users/alice`,
        body: { fields: { name: { stringValue: "Alice" } } },
      });
      const alice = yield* firestore.getProjectsDatabasesDocuments({
        name: `${created.name}/documents/users/alice`,
      });
      expect(alice.fields?.name?.stringValue).toEqual("Alice");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Firestore.Database("App", {
            databaseId: created.databaseId,
            location: "us-central1",
            type: "FIRESTORE_NATIVE",
            concurrencyMode: "OPTIMISTIC",
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.concurrencyMode).toEqual("OPTIMISTIC");

      const refetched = yield* firestore.getProjectsDatabases({
        name: created.name,
      });
      expect(refetched.concurrencyMode).toEqual("OPTIMISTIC");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:firestore", "live"],
    timeout: 180_000,
  },
);
