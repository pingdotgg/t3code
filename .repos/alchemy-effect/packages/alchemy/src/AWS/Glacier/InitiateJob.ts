import type * as glacier from "@distilled.cloud/aws/glacier";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Vault } from "./Vault.ts";

/**
 * `InitiateJob` request with `accountId` and `vaultName` injected from the bound
 * {@link Vault}.
 */
export interface InitiateJobRequest extends Omit<
  glacier.InitiateJobInput,
  "accountId" | "vaultName"
> {}

/**
 * Runtime binding for the `InitiateJob` operation (IAM action
 * `glacier:InitiateJob` on the vault ARN).
 *
 * Initiates an archive-retrieval, inventory-retrieval, or select job
 * against the bound {@link Vault}. Retrieval is asynchronous — poll the
 * returned `jobId` with {@link DescribeJob} and fetch the result with
 * {@link GetJobOutput} once it completes (typically 3–5 hours for standard
 * tier, minutes for expedited).
 * Provide the implementation with
 * `Effect.provide(AWS.Glacier.InitiateJobHttp)`.
 * @binding
 * @section Retrieving Archives
 * @example Start an inventory-retrieval job
 * ```typescript
 * const initiateJob = yield* AWS.Glacier.InitiateJob(vault);
 *
 * const { jobId } = yield* initiateJob({
 *   jobParameters: { Type: "inventory-retrieval" },
 * });
 * ```
 */
export interface InitiateJob extends Binding.Service<
  InitiateJob,
  "AWS.Glacier.InitiateJob",
  (
    vault: Vault,
  ) => Effect.Effect<
    (
      request?: InitiateJobRequest,
    ) => Effect.Effect<glacier.InitiateJobOutput, glacier.InitiateJobError>
  >
> {}
export const InitiateJob = Binding.Service<InitiateJob>(
  "AWS.Glacier.InitiateJob",
);
