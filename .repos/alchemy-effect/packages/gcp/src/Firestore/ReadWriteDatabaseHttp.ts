import * as Layer from "effect/Layer";
import { makeFirestoreDatabaseBinding, readWriteDatabaseIam } from "./DatabaseHttp.ts";
import { ReadWriteDatabase } from "./ReadWriteDatabase.ts";

/**
 * HTTP implementation of {@link ReadWriteDatabase} over the Firestore REST API.
 *
 * @layer
 * @provides GCP.Firestore.ReadWriteDatabase
 * @category Firestore
 */
export const ReadWriteDatabaseHttp = Layer.effect(
  ReadWriteDatabase,
  makeFirestoreDatabaseBinding({
    tag: "GCP.Firestore.ReadWriteDatabase",
    iam: readWriteDatabaseIam,
    makeClient: (helpers, name) => ({
      ...helpers.makeRead(name),
      ...helpers.makeWrite(name),
    }),
  }),
);
