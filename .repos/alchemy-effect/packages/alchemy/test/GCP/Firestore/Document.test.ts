import * as GCP from "@/GCP";
import { Document, DocumentProvider } from "@/GCP/Firestore/Document.ts";
import * as Test from "@/Test/Alchemy";
import * as firestore from "@distilled.cloud/gcp/firestore_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import { GcpEnvironment } from "@/GCP/Environment";

const { test } = Test.make({
  providers: DocumentProvider().pipe(Layer.provideMerge(GCP.providers())),
});

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);
const defaultDocOf = (project: string) =>
  `projects/${project}/databases/(default)/documents/_alchemy/alchemy-missing`;

const waitUntilGone = (name: string) =>
  firestore.getProjectsDatabasesDocuments({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "getProjectsDatabasesDocuments on the Datastore-mode (default) database fails with DatastoreModeDatabase",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;

      yield* stack.destroy();

      const error = yield* Effect.flip(
        firestore.getProjectsDatabasesDocuments({
          name: defaultDocOf(project),
        }),
      );
      expect(error._tag).toEqual("DatastoreModeDatabase");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:firestore", "live"], timeout: 90_000 },
);

test.provider(
  "createDocumentProjectsDatabasesDocuments on the Datastore-mode (default) database fails with DatastoreModeDatabase",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;

      yield* stack.destroy();

      const error = yield* Effect.flip(
        firestore.createDocumentProjectsDatabasesDocuments({
          parent: `projects/${project}/databases/(default)/documents`,
          collectionId: "_alchemy",
          documentId: "alchemy-probe",
          body: { fields: { env: { stringValue: "probe" } } },
        }),
      );
      expect(error._tag).toEqual("DatastoreModeDatabase");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:firestore", "live"], timeout: 90_000 },
);

// The testing project's (default) database is Datastore mode, which rejects
// the Firestore API, so the lifecycle provisions its own Native database.
test.provider(
  "create, update, and delete a firestore document",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const database = yield* GCP.Firestore.Database("DocDb", {
            location: "us-central1",
            type: "FIRESTORE_NATIVE",
          });
          return yield* Document("Flag", {
            database: database.databaseId,
            collectionId: "_alchemy",
            fields: { env: { stringValue: "test" } },
          });
        }),
      );

      expect(created.name).toContain("/documents/");
      expect(created.collectionId).toEqual("_alchemy");
      expect(created.fields.env?.stringValue).toEqual("test");

      const fetched = yield* firestore.getProjectsDatabasesDocuments({
        name: created.name,
      });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.fields?.env?.stringValue).toEqual("test");
      expect(Object.keys(fetched.fields ?? {})).toEqual(["env"]);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const database = yield* GCP.Firestore.Database("DocDb", {
            location: "us-central1",
            type: "FIRESTORE_NATIVE",
          });
          return yield* Document("Flag", {
            database: database.databaseId,
            collectionId: "_alchemy",
            documentId: created.documentId,
            fields: {
              env: { stringValue: "prod" },
              role: { stringValue: "flag" },
            },
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.fields.env?.stringValue).toEqual("prod");
      expect(updated.fields.role?.stringValue).toEqual("flag");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:firestore", "live"], timeout: 90_000 },
);
