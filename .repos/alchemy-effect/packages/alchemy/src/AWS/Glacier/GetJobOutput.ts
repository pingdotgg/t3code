import type * as glacier from "@distilled.cloud/aws/glacier";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Vault } from "./Vault.ts";

/**
 * `GetJobOutput` request with `accountId` and `vaultName` injected from the bound
 * {@link Vault}.
 */
export interface GetJobOutputRequest extends Omit<
  glacier.GetJobOutputInput,
  "accountId" | "vaultName"
> {}

/**
 * Runtime binding for the `GetJobOutput` operation (IAM action
 * `glacier:GetJobOutput` on the vault ARN).
 *
 * Downloads the output of a completed job on the bound {@link Vault} — the
 * archive bytes for an archive-retrieval job, or the JSON inventory for an
 * inventory-retrieval job. Supports ranged reads via the `range` header
 * field for chunked downloads.
 * Provide the implementation with
 * `Effect.provide(AWS.Glacier.GetJobOutputHttp)`.
 * @binding
 * @section Retrieving Archives
 * @example Download a completed job's output
 * ```typescript
 * const getJobOutput = yield* AWS.Glacier.GetJobOutput(vault);
 *
 * const { body, status } = yield* getJobOutput({ jobId });
 * ```
 */
export interface GetJobOutput extends Binding.Service<
  GetJobOutput,
  "AWS.Glacier.GetJobOutput",
  (
    vault: Vault,
  ) => Effect.Effect<
    (
      request: GetJobOutputRequest,
    ) => Effect.Effect<glacier.GetJobOutputOutput, glacier.GetJobOutputError>
  >
> {}
export const GetJobOutput = Binding.Service<GetJobOutput>(
  "AWS.Glacier.GetJobOutput",
);
