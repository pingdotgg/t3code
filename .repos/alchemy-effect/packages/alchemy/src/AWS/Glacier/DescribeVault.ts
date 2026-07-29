import type * as glacier from "@distilled.cloud/aws/glacier";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Vault } from "./Vault.ts";

/**
 * Runtime binding for the `DescribeVault` operation (IAM action
 * `glacier:DescribeVault` on the vault ARN).
 *
 * Reads the bound {@link Vault}'s description — archive count, total size
 * in bytes, and last inventory date (both as of the last nightly
 * inventory).
 * Provide the implementation with
 * `Effect.provide(AWS.Glacier.DescribeVaultHttp)`.
 * @binding
 * @section Inspecting Vaults
 * @example Read the vault's stats
 * ```typescript
 * const describeVault = yield* AWS.Glacier.DescribeVault(vault);
 *
 * const { NumberOfArchives, SizeInBytes } = yield* describeVault();
 * ```
 */
export interface DescribeVault extends Binding.Service<
  DescribeVault,
  "AWS.Glacier.DescribeVault",
  (
    vault: Vault,
  ) => Effect.Effect<
    () => Effect.Effect<glacier.DescribeVaultOutput, glacier.DescribeVaultError>
  >
> {}
export const DescribeVault = Binding.Service<DescribeVault>(
  "AWS.Glacier.DescribeVault",
);
