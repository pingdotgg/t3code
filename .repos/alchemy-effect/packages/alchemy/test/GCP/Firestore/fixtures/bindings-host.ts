import * as GCP from "@/GCP";
import * as Effect from "effect/Effect";
import { serveProbes } from "../../bindingHost.ts";

const nativeDatabase = (id: string) =>
  GCP.Firestore.Database(id, {
    location: "us-central1",
    type: "FIRESTORE_NATIVE",
  });

/** Database the per-document PatchDocument / GetDocument / DeleteDocument bind. */
export const DocsDatabase = nativeDatabase("DocsDatabase");
/** Database only {@link GCP.Firestore.ReadDatabase} binds (seeded by the test). */
export const ReadOnlyDatabase = nativeDatabase("ReadOnlyDatabase");
/** Database only {@link GCP.Firestore.WriteDatabase} binds. */
export const WriteOnlyDatabase = nativeDatabase("WriteOnlyDatabase");
/** Database only {@link GCP.Firestore.ReadWriteDatabase} binds. */
export const ReadWriteOnlyDatabase = nativeDatabase("ReadWriteOnlyDatabase");

/** Documents the test seeds out of band. */
export const SEEDED_GET = "users/seeded";
export const SEEDED_DELETE = "users/doomed";
export const PATCHED = "users/alice";

/**
 * Effect-native Cloud Run service exercising every Firestore binding as its
 * own runtime service account. Deployed from {@link ../Bindings.test.ts}.
 */
export default class FirestoreBindingsHost extends GCP.Function<FirestoreBindingsHost>()(
  "FirestoreBindingsHost",
  { main: import.meta.url, invokerIamDisabled: true },
  Effect.gen(function* () {
    const patchDocument = yield* GCP.Firestore.PatchDocument(DocsDatabase);
    const getDocument = yield* GCP.Firestore.GetDocument(DocsDatabase);
    const deleteDocument = yield* GCP.Firestore.DeleteDocument(DocsDatabase);
    const reader = yield* GCP.Firestore.ReadDatabase(ReadOnlyDatabase);
    const writer = yield* GCP.Firestore.WriteDatabase(WriteOnlyDatabase);
    const both = yield* GCP.Firestore.ReadWriteDatabase(ReadWriteOnlyDatabase);

    return {
      fetch: serveProbes({
        patchDocument: patchDocument({
          documentPath: PATCHED,
          body: { fields: { name: { stringValue: "Alice" } } },
        }),
        getDocument: getDocument({ documentPath: SEEDED_GET }),
        deleteDocument: deleteDocument({ documentPath: SEEDED_DELETE }),
        read: Effect.gen(function* () {
          const one = yield* reader.get("things/a");
          const missing = yield* reader.get("things/never");
          const page1 = yield* reader.list("things", { pageSize: 1 });
          const page2 = yield* reader.list("things", {
            pageSize: 1,
            pageToken: page1.nextPageToken,
          });
          const big = yield* reader.query({
            from: [{ collectionId: "things" }],
            where: {
              fieldFilter: {
                field: { fieldPath: "n" },
                op: "GREATER_THAN",
                value: { integerValue: "1" },
              },
            },
          });
          return {
            one: one?.fields,
            missing: missing === undefined,
            listed: [...page1.documents, ...page2.documents]
              .map((doc) => doc.name.split("/").pop())
              .sort(),
            hasNextPage: page1.nextPageToken !== undefined,
            big: big.map((doc) => doc.fields.n),
          };
        }),
        write: Effect.gen(function* () {
          yield* writer.delete("things/created");
          const created = yield* writer.create("things/created", { n: 1 });
          const conflict = yield* writer
            .create("things/created", { n: 2 })
            .pipe(
              Effect.map(() => "created"),
              Effect.catchTag("GCP.Firestore.DocumentAlreadyExists", (error) =>
                Effect.succeed(error.path),
              ),
            );
          const updated = yield* writer.update("things/created", {
            "odd key": "x",
          });
          const updateMissing = yield* writer
            .update("things/never", { a: 1 })
            .pipe(
              Effect.map(() => "updated"),
              Effect.catchTag("NotFound", () => Effect.succeed("NotFound")),
            );
          yield* writer.set("things/set", { team: "red" });
          yield* writer.set("things/gone", { team: "blue" });
          yield* writer.delete("things/gone");
          yield* writer.delete("things/never-existed");
          return {
            created: created.name.endsWith("/documents/things/created"),
            conflict,
            updated: updated.fields,
            updateMissing,
          };
        }),
        readWrite: Effect.gen(function* () {
          yield* both.delete("scores/a");
          const missing = yield* both.get("scores/a");
          yield* both.create("scores/a", { team: "red", n: 1 });
          yield* both.set("scores/b", { team: "blue", n: 2 });
          yield* both.update("scores/b", { n: 3 });
          const b = yield* both.get("scores/b");
          const listed = yield* both.list("scores");
          const red = yield* both.query({
            from: [{ collectionId: "scores" }],
            where: {
              fieldFilter: {
                field: { fieldPath: "team" },
                op: "EQUAL",
                value: { stringValue: "red" },
              },
            },
          });
          yield* both.delete("scores/a");
          const afterDelete = yield* both.get("scores/a");
          return {
            missing: missing === undefined,
            b: b?.fields,
            listed: listed.documents
              .map((doc) => doc.name.split("/").pop())
              .sort(),
            red: red.map((doc) => doc.name.split("/").pop()),
            afterDelete: afterDelete === undefined,
          };
        }),
      }),
    };
  }).pipe(
    Effect.provide(GCP.Firestore.PatchDocumentHttp),
    Effect.provide(GCP.Firestore.GetDocumentHttp),
    Effect.provide(GCP.Firestore.DeleteDocumentHttp),
    Effect.provide(GCP.Firestore.ReadDatabaseHttp),
    Effect.provide(GCP.Firestore.WriteDatabaseHttp),
    Effect.provide(GCP.Firestore.ReadWriteDatabaseHttp),
  ),
) {}
