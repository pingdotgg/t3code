import type * as firestore from "@distilled.cloud/gcp/firestore_v1";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import type { Database } from "./Database.ts";

/**
 * A Firestore document read through a {@link ReadDatabase} client. `fields`
 * are decoded from Firestore `Value`s to plain JavaScript: integers →
 * `number` (`bigint` beyond the safe range), doubles → `number`,
 * timestamps → `Date`, bytes → `Uint8Array`, arrays and maps recursively,
 * geo points → `{ latitude, longitude }`, references → resource name.
 */
export interface DocumentSnapshot {
  /** Full resource name `projects/{p}/databases/{d}/documents/{path}`. */
  name: string;
  /** Decoded document fields. */
  fields: Record<string, unknown>;
  /** RFC 3339 creation time. */
  createTime: string | undefined;
  /** RFC 3339 last-update time. */
  updateTime: string | undefined;
}

export interface ListDocumentsOptions {
  /** Maximum documents per page. */
  pageSize?: number;
  /** Page token from a previous `list`. */
  pageToken?: string;
}

export interface ListDocumentsResult {
  documents: DocumentSnapshot[];
  /** Pass to the next `list` call; `undefined` on the last page. */
  nextPageToken: string | undefined;
}

/** Read-only client for one Firestore database. */
export interface ReadDatabaseClient {
  /**
   * Get a document by path relative to the database (`"users/alice"`), or
   * `undefined` when it does not exist.
   */
  get(
    path: string,
  ): Effect.Effect<
    DocumentSnapshot | undefined,
    firestore.GetProjectsDatabasesDocumentsError,
    RuntimeContext
  >;
  /**
   * One page of documents in a collection (`"users"`, or a subcollection
   * such as `"users/alice/posts"`).
   */
  list(
    collection: string,
    options?: ListDocumentsOptions,
  ): Effect.Effect<
    ListDocumentsResult,
    firestore.ListProjectsDatabasesDocumentsError,
    RuntimeContext
  >;
  /**
   * Run a Firestore `StructuredQuery` against the database root. Filter
   * values use the Firestore REST `Value` shape
   * (`{ integerValue: "2" }`, `{ stringValue: "a" }`, …).
   */
  query(
    structuredQuery: firestore.StructuredQuery,
  ): Effect.Effect<
    DocumentSnapshot[],
    firestore.RunQueryProjectsDatabasesDocumentsError,
    RuntimeContext
  >;
}

/**
 * Read access to a Firestore {@link Database}: `get`, `list`, `query`.
 * Grants `roles/datastore.viewer` on the project under an IAM Condition
 * naming this database (Firestore databases have no resource-level IAM
 * policy).
 *
 * ### Reading documents
 * **Example:** Get a document and list a collection
 * ```typescript
 * const db = yield* GCP.Firestore.ReadDatabase(database);
 * const alice = yield* db.get("users/alice");
 * const { documents } = yield* db.list("users", { pageSize: 20 });
 * // …provided with Effect.provide(GCP.Firestore.ReadDatabaseHttp)
 * ```
 *
 * ### Querying
 * **Example:** Filter a collection
 * ```typescript
 * const db = yield* GCP.Firestore.ReadDatabase(database);
 * const admins = yield* db.query({
 *   from: [{ collectionId: "users" }],
 *   where: {
 *     fieldFilter: {
 *       field: { fieldPath: "role" },
 *       op: "EQUAL",
 *       value: { stringValue: "admin" },
 *     },
 *   },
 * });
 * ```
 *
 * @binding
 * @category Firestore
 */
export interface ReadDatabase extends Binding.Service<
  ReadDatabase,
  "GCP.Firestore.ReadDatabase",
  (database: Database) => Effect.Effect<ReadDatabaseClient>
> {}

export const ReadDatabase = Binding.Service<ReadDatabase>(
  "GCP.Firestore.ReadDatabase",
);
