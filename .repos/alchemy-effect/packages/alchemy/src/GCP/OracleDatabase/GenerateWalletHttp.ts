import * as oracle from "@distilled.cloud/gcp/oracledatabase_v1";
import * as Layer from "effect/Layer";
import { makeOracleNameHttpBinding } from "./BindingHttp.ts";
import { GenerateWallet } from "./GenerateWallet.ts";

/**
 * HTTP implementation of {@link GenerateWallet}.
 *
 * @layer
 * @provides GCP.OracleDatabase.GenerateWallet
 */
export const GenerateWalletHttp = Layer.effect(
  GenerateWallet,
  makeOracleNameHttpBinding({
    tag: "GCP.OracleDatabase.GenerateWallet",
    operation: oracle.generateWalletProjectsLocationsAutonomousDatabases,
    // Narrowest predefined role with this autonomousDatabases permission.
    iam: { role: "roles/oracledatabase.autonomousDatabaseAdmin" },
  }),
);
