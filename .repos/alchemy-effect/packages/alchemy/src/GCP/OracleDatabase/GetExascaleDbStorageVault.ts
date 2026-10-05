import type * as oracle from "@distilled.cloud/gcp/oracledatabase_v1";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import type { ExascaleDbStorageVault } from "./ExascaleDbStorageVault.ts";

export interface GetExascaleDbStorageVaultRequest extends Omit<
  oracle.GetProjectsLocationsExascaleDbStorageVaultsRequest,
  "name"
> {}

/**
 * Runtime binding for Oracle Database `exascaleDbStorageVaults.get`.
 *
 * ### Observing storage vaults
 * **Example:** Read the bound vault
 * ```typescript
 * const get = yield* GCP.OracleDatabase.GetExascaleDbStorageVault(vault);
 * const live = yield* get();
 * ```
 *
 * @binding
 * @category OracleDatabase
 */
export interface GetExascaleDbStorageVault extends Binding.Service<
  GetExascaleDbStorageVault,
  "GCP.OracleDatabase.GetExascaleDbStorageVault",
  (
    vault: ExascaleDbStorageVault,
  ) => Effect.Effect<
    (
      request?: GetExascaleDbStorageVaultRequest,
    ) => Effect.Effect<
      oracle.ExascaleDbStorageVault,
      oracle.GetProjectsLocationsExascaleDbStorageVaultsError,
      RuntimeContext
    >
  >
> {}

export const GetExascaleDbStorageVault =
  Binding.Service<GetExascaleDbStorageVault>(
    "GCP.OracleDatabase.GetExascaleDbStorageVault",
  );
