import * as Layer from "effect/Layer";
import {
  makeFirestoreDatabaseBinding,
  readDatabaseIam,
} from "./DatabaseHttp.ts";
import { ReadDatabase } from "./ReadDatabase.ts";

/**
 * HTTP implementation of {@link ReadDatabase} over the Firestore REST API.
 *
 * @layer
 * @provides GCP.Firestore.ReadDatabase
 * @category Firestore
 */
export const ReadDatabaseHttp = Layer.effect(
  ReadDatabase,
  makeFirestoreDatabaseBinding({
    tag: "GCP.Firestore.ReadDatabase",
    iam: readDatabaseIam,
    makeClient: (helpers, name) => helpers.makeRead(name),
  }),
);
