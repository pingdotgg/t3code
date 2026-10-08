import type * as oracle from "@distilled.cloud/gcp/oracledatabase_v1";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import type { AutonomousDatabase } from "./AutonomousDatabase.ts";

export interface GenerateWalletRequest extends Omit<
  oracle.GenerateWalletProjectsLocationsAutonomousDatabasesRequest,
  "name"
> {}

/**
 * Runtime binding for Oracle Database `autonomousDatabases.generateWallet`.
 *
 * Grants `roles/oracledatabase.autonomousDatabaseAdmin` on the project
 * because `autonomousDatabases.generateWallet` is only in the admin roles
 * and Oracle Database@Google Cloud has no per-resource IAM.
 *
 * ### Downloading a wallet
 * **Example:** Generate a SINGLE wallet
 * ```typescript
 * const generateWallet = yield* GCP.OracleDatabase.GenerateWallet(db);
 * const wallet = yield* generateWallet({
 *   body: { password: "AlchemyTest1!", type: "SINGLE" },
 * });
 * ```
 *
 * @binding
 * @category OracleDatabase
 */
export interface GenerateWallet extends Binding.Service<
  GenerateWallet,
  "GCP.OracleDatabase.GenerateWallet",
  (
    database: AutonomousDatabase,
  ) => Effect.Effect<
    (
      request: GenerateWalletRequest,
    ) => Effect.Effect<
      oracle.GenerateAutonomousDatabaseWalletResponse,
      oracle.GenerateWalletProjectsLocationsAutonomousDatabasesError,
      RuntimeContext
    >
  >
> {}

export const GenerateWallet = Binding.Service<GenerateWallet>(
  "GCP.OracleDatabase.GenerateWallet",
);
