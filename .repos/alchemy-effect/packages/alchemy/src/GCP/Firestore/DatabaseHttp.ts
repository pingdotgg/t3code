import * as firestore from "@distilled.cloud/gcp/firestore_v1";
import * as Effect from "effect/Effect";
import { bindGcpHost } from "../Host.ts";
import { type BindingIam, grantFor } from "../HttpBinding.ts";
import type { Database } from "./Database.ts";
import type { DocumentSnapshot, ReadDatabaseClient } from "./ReadDatabase.ts";
import { decodeFields, encodeFields, fieldPath } from "./Values.ts";
import {
  DocumentAlreadyExists,
  type WriteDatabaseClient,
} from "./WriteDatabase.ts";

// Firestore databases have no resource-level IAM policy: each grant is on
// the project under an IAM Condition naming the bound database.
export const readDatabaseIam: BindingIam = {
  role: "roles/datastore.viewer",
  scopeByCondition: true,
};
export const writeDatabaseIam: BindingIam = {
  role: "roles/datastore.user",
  scopeByCondition: true,
};
export const readWriteDatabaseIam: BindingIam = {
  role: "roles/datastore.user",
  scopeByCondition: true,
};

const trimPath = (path: string) => path.replace(/^\/+|\/+$/g, "");

/** `"a/b/c"` → `{ parent: "a/b", last: "c" }`. */
const splitLast = (path: string) => {
  const trimmed = trimPath(path);
  const at = trimmed.lastIndexOf("/");
  return at < 0
    ? { parent: "", last: trimmed }
    : { parent: trimmed.slice(0, at), last: trimmed.slice(at + 1) };
};

const snapshot = (document: firestore.Document): DocumentSnapshot => ({
  name: document.name ?? "",
  fields: decodeFields(document.fields),
  createTime: document.createTime,
  updateTime: document.updateTime,
});

/**
 * Shared HTTP scaffolding for the Firestore Read/Write/ReadWrite bindings:
 * resolves the distilled operations once at Layer construction and grants
 * the level's role at deploy time.
 *
 * NOT exported from `index.ts`.
 */
export const makeFirestoreDatabaseHelpers = Effect.gen(function* () {
  const getDocument = yield* firestore.getProjectsDatabasesDocuments;
  const listDocuments = yield* firestore.listProjectsDatabasesDocuments;
  const runQuery = yield* firestore.runQueryProjectsDatabasesDocuments;
  const patchDocument = yield* firestore.patchProjectsDatabasesDocuments;
  const createDocument =
    yield* firestore.createDocumentProjectsDatabasesDocuments;
  const deleteDocument = yield* firestore.deleteProjectsDatabasesDocuments;

  const makeRead = (
    databaseName: Effect.Effect<string>,
  ): ReadDatabaseClient => {
    const documentsRoot = Effect.map(databaseName, (db) => `${db}/documents`);
    const parentOf = (path: string) =>
      Effect.map(documentsRoot, (root) =>
        path.length > 0 ? `${root}/${path}` : root,
      );
    return {
      get: (path) =>
        parentOf(trimPath(path)).pipe(
          Effect.flatMap((name) => getDocument({ name })),
          Effect.map(snapshot),
          Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
        ),
      list: (collection, options) => {
        const { parent, last } = splitLast(collection);
        return parentOf(parent).pipe(
          Effect.flatMap((parent) =>
            listDocuments({
              parent,
              collectionId: last,
              pageSize: options?.pageSize,
              pageToken: options?.pageToken,
            }),
          ),
          Effect.map((page) => ({
            documents: (page.documents ?? []).map(snapshot),
            nextPageToken: page.nextPageToken || undefined,
          })),
        );
      },
      query: (structuredQuery) =>
        documentsRoot.pipe(
          Effect.flatMap((parent) =>
            runQuery({ parent, body: { structuredQuery } }),
          ),
          // The REST endpoint streams a JSON array of RunQueryResponse
          // messages; the generated output type models a single message.
          Effect.map((response): ReadonlyArray<firestore.RunQueryResponse> =>
            Array.isArray(response) ? response : [response],
          ),
          Effect.map((responses) =>
            responses.flatMap((r) =>
              r.document === undefined ? [] : [snapshot(r.document)],
            ),
          ),
        ),
    };
  };

  const makeWrite = (
    databaseName: Effect.Effect<string>,
  ): WriteDatabaseClient => {
    const documentName = (path: string) =>
      Effect.map(databaseName, (db) => `${db}/documents/${trimPath(path)}`);
    return {
      set: (path, fields) =>
        documentName(path).pipe(
          Effect.flatMap((name) =>
            patchDocument({ name, body: { fields: encodeFields(fields) } }),
          ),
          Effect.map(snapshot),
        ),
      update: (path, fields) =>
        documentName(path).pipe(
          Effect.flatMap((name) =>
            patchDocument({
              name,
              "updateMask.fieldPaths": Object.keys(fields).map(fieldPath),
              "currentDocument.exists": true,
              body: { fields: encodeFields(fields) },
            }),
          ),
          Effect.map(snapshot),
        ),
      delete: (path) =>
        documentName(path).pipe(
          Effect.flatMap((name) => deleteDocument({ name })),
          Effect.asVoid,
          Effect.catchTag("NotFound", () => Effect.void),
        ),
      create: (path, fields) => {
        const { parent, last } = splitLast(path);
        const collection = splitLast(parent);
        return databaseName.pipe(
          Effect.flatMap((db) =>
            createDocument({
              parent:
                collection.parent.length > 0
                  ? `${db}/documents/${collection.parent}`
                  : `${db}/documents`,
              collectionId: collection.last,
              documentId: last,
              body: { fields: encodeFields(fields) },
            }),
          ),
          Effect.map(snapshot),
          Effect.catchTag("Conflict", (error) =>
            Effect.fail(
              new DocumentAlreadyExists({
                path: trimPath(path),
                message: error.message,
              }),
            ),
          ),
        );
      },
    };
  };

  return { makeRead, makeWrite };
});

/** Build a database binding that grants `iam` and returns `makeClient`'s client. */
export const makeFirestoreDatabaseBinding = <Client>(options: {
  tag: string;
  iam: BindingIam;
  makeClient: (
    helpers: Effect.Success<typeof makeFirestoreDatabaseHelpers>,
    databaseName: Effect.Effect<string>,
  ) => Client;
}) =>
  Effect.gen(function* () {
    const helpers = yield* makeFirestoreDatabaseHelpers;
    return Effect.fn(function* (database: Database) {
      yield* bindGcpHost({
        tag: options.tag,
        resource: database,
        iam: [grantFor(options.iam, database.name)],
      });
      const databaseName = yield* database.name;
      return options.makeClient(helpers, databaseName);
    });
  });
