import type * as oracle from "@distilled.cloud/gcp/oracledatabase_v1";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import type { AutonomousDatabase } from "./AutonomousDatabase.ts";

export interface StartAutonomousDatabaseRequest extends Omit<
  oracle.StartProjectsLocationsAutonomousDatabasesRequest,
  "name"
> {}

/**
 * Runtime binding for Oracle Database `autonomousDatabases.start`.
 *
 * Grants `roles/oracledatabase.autonomousDatabaseAdmin` on the project
 * because `autonomousDatabases.start` is only in the admin roles and Oracle
 * Database@Google Cloud has no per-resource IAM.
 *
 * ### Starting a database
 * **Example:** Start the bound database
 * ```typescript
 * const start = yield* GCP.OracleDatabase.StartAutonomousDatabase(db);
 * yield* start();
 * ```
 *
 * @binding
 * @category OracleDatabase
 */
export interface StartAutonomousDatabase extends Binding.Service<
  StartAutonomousDatabase,
  "GCP.OracleDatabase.StartAutonomousDatabase",
  (
    database: AutonomousDatabase,
  ) => Effect.Effect<
    (
      request?: StartAutonomousDatabaseRequest,
    ) => Effect.Effect<
      oracle.Operation,
      oracle.StartProjectsLocationsAutonomousDatabasesError,
      RuntimeContext
    >
  >
> {}

export const StartAutonomousDatabase = Binding.Service<StartAutonomousDatabase>(
  "GCP.OracleDatabase.StartAutonomousDatabase",
);
