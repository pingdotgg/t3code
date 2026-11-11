import * as oracle from "@distilled.cloud/gcp/oracledatabase_v1";
import * as Layer from "effect/Layer";
import { makeOracleNameHttpBinding } from "./BindingHttp.ts";
import { GetAutonomousDatabase } from "./GetAutonomousDatabase.ts";

/**
 * HTTP implementation of {@link GetAutonomousDatabase}.
 *
 * @layer
 * @provides GCP.OracleDatabase.GetAutonomousDatabase
 */
export const GetAutonomousDatabaseHttp = Layer.effect(
  GetAutonomousDatabase,
  makeOracleNameHttpBinding({
    tag: "GCP.OracleDatabase.GetAutonomousDatabase",
    operation: oracle.getProjectsLocationsAutonomousDatabases,
    iam: { role: "roles/oracledatabase.autonomousDatabaseViewer" },
  }),
);
