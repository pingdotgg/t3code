import * as oracle from "@distilled.cloud/gcp/oracledatabase_v1";
import * as Layer from "effect/Layer";
import { makeOracleNameHttpBinding } from "./BindingHttp.ts";
import { RestartAutonomousDatabase } from "./RestartAutonomousDatabase.ts";

/**
 * HTTP implementation of {@link RestartAutonomousDatabase}.
 *
 * @layer
 * @provides GCP.OracleDatabase.RestartAutonomousDatabase
 */
export const RestartAutonomousDatabaseHttp = Layer.effect(
  RestartAutonomousDatabase,
  makeOracleNameHttpBinding({
    tag: "GCP.OracleDatabase.RestartAutonomousDatabase",
    operation: oracle.restartProjectsLocationsAutonomousDatabases,
    // Narrowest predefined role with this autonomousDatabases permission.
    iam: { role: "roles/oracledatabase.autonomousDatabaseAdmin" },
  }),
);
