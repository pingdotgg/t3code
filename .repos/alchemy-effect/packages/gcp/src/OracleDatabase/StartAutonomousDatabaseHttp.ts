import * as oracle from "@distilled.cloud/gcp/oracledatabase_v1";
import * as Layer from "effect/Layer";
import { makeOracleNameHttpBinding } from "./BindingHttp.ts";
import { StartAutonomousDatabase } from "./StartAutonomousDatabase.ts";

/**
 * HTTP implementation of {@link StartAutonomousDatabase}.
 *
 * @layer
 * @provides GCP.OracleDatabase.StartAutonomousDatabase
 */
export const StartAutonomousDatabaseHttp = Layer.effect(
  StartAutonomousDatabase,
  makeOracleNameHttpBinding({
    tag: "GCP.OracleDatabase.StartAutonomousDatabase",
    operation: oracle.startProjectsLocationsAutonomousDatabases,
    // Narrowest predefined role with this autonomousDatabases permission.
    iam: { role: "roles/oracledatabase.autonomousDatabaseAdmin" },
  }),
);
