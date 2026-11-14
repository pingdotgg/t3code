import * as Layer from "effect/Layer";
import { makeFirestoreDatabaseBinding, writeDatabaseIam } from "./DatabaseHttp.ts";
import { WriteDatabase } from "./WriteDatabase.ts";

/**
 * HTTP implementation of {@link WriteDatabase} over the Firestore REST API.
 *
 * @layer
 * @provides GCP.Firestore.WriteDatabase
 * @category Firestore
 */
export const WriteDatabaseHttp = Layer.effect(
  WriteDatabase,
  makeFirestoreDatabaseBinding({
    tag: "GCP.Firestore.WriteDatabase",
    iam: writeDatabaseIam,
    makeClient: (helpers, name) => helpers.makeWrite(name),
  }),
);
