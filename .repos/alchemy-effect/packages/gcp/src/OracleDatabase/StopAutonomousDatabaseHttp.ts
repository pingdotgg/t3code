import * as oracle from "@distilled.cloud/gcp/oracledatabase_v1";
import * as Layer from "effect/Layer";
import { makeOracleNameHttpBinding } from "./BindingHttp.ts";
import { StopAutonomousDatabase } from "./StopAutonomousDatabase.ts";

/**
 * HTTP implementation of {@link StopAutonomousDatabase}.
 *
 * @layer
 * @provides GCP.OracleDatabase.StopAutonomousDatabase
 */
export const StopAutonomousDatabaseHttp = Layer.effect(
  StopAutonomousDatabase,
  makeOracleNameHttpBinding({
    tag: "GCP.OracleDatabase.StopAutonomousDatabase",
    operation: oracle.stopProjectsLocationsAutonomousDatabases,
    // Narrowest predefined role with this autonomousDatabases permission.
    iam: { role: "roles/oracledatabase.autonomousDatabaseAdmin" },
  }),
);
