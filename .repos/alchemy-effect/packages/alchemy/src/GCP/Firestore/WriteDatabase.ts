import type * as firestore from "@distilled.cloud/gcp/firestore_v1";
import * as Data from "effect/Data";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import type { Database } from "./Database.ts";
import type { DocumentSnapshot } from "./ReadDatabase.ts";

/** `create` found a document already at `path`. */
export class DocumentAlreadyExists extends Data.TaggedError(
  "GCP.Firestore.DocumentAlreadyExists",
)<{
  path: string;
  message: string;
}> {}

/** Write-only client for one Firestore database. */
export interface WriteDatabaseClient {
  /**
   * Create or overwrite the document at `path` (`"users/alice"`) with
   * exactly `fields` (plain JavaScript, encoded to Firestore `Value`s).
   */
  set(
    path: string,
    fields: Record<string, unknown>,
  ): Effect.Effect<
    DocumentSnapshot,
    firestore.PatchProjectsDatabasesDocumentsError,
    RuntimeContext
  >;
  /**
   * Update only the top-level keys of `fields` on an existing document
   * (the update mask is `Object.keys(fields)`). Fails with `NotFound` when
   * the document does not exist.
   */
  update(
    path: string,
    fields: Record<string, unknown>,
  ): Effect.Effect<
    DocumentSnapshot,
    firestore.PatchProjectsDatabasesDocumentsError,
    RuntimeContext
  >;
  /** Delete the document at `path`. Deleting a missing document succeeds. */
  delete(
    path: string,
  ): Effect.Effect<
    void,
    firestore.DeleteProjectsDatabasesDocumentsError,
    RuntimeContext
  >;
  /**
   * Create the document at `path`; fails with
   * {@link DocumentAlreadyExists} when it already exists.
   */
  create(
    path: string,
    fields: Record<string, unknown>,
  ): Effect.Effect<
    DocumentSnapshot,
    | DocumentAlreadyExists
    | Exclude<
        firestore.CreateDocumentProjectsDatabasesDocumentsError,
        { _tag: "Conflict" }
      >,
    RuntimeContext
  >;
}

/**
 * Write access to a Firestore {@link Database}: `set`, `update`, `delete`,
 * `create`. Grants `roles/datastore.user` on the project under an IAM
 * Condition naming this database (Firestore databases have no
 * resource-level IAM policy).
 *
 * ### Writing documents
 * **Example:** Create, update, and delete
 * ```typescript
 * const db = yield* GCP.Firestore.WriteDatabase(database);
 * yield* db.create("users/alice", { name: "Alice", visits: 0 }).pipe(
 *   Effect.catchTag("GCP.Firestore.DocumentAlreadyExists", () => Effect.void),
 * );
 * yield* db.update("users/alice", { visits: 1, lastSeen: new Date() });
 * yield* db.delete("users/bob");
 * // …provided with Effect.provide(GCP.Firestore.WriteDatabaseHttp)
 * ```
 *
 * @binding
 * @category Firestore
 */
export interface WriteDatabase extends Binding.Service<
  WriteDatabase,
  "GCP.Firestore.WriteDatabase",
  (database: Database) => Effect.Effect<WriteDatabaseClient>
> {}

export const WriteDatabase = Binding.Service<WriteDatabase>(
  "GCP.Firestore.WriteDatabase",
);
