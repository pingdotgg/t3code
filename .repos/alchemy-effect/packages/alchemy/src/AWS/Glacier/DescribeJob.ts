import type * as glacier from "@distilled.cloud/aws/glacier";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Vault } from "./Vault.ts";

/**
 * `DescribeJob` request with `accountId` and `vaultName` injected from the bound
 * {@link Vault}.
 */
export interface DescribeJobRequest extends Omit<
  glacier.DescribeJobInput,
  "accountId" | "vaultName"
> {}

/**
 * Runtime binding for the `DescribeJob` operation (IAM action
 * `glacier:DescribeJob` on the vault ARN).
 *
 * Reads the status of a job previously started with {@link InitiateJob} on
 * the bound {@link Vault} — its action, status code, and completion flag.
 * Provide the implementation with
 * `Effect.provide(AWS.Glacier.DescribeJobHttp)`.
 * @binding
 * @section Retrieving Archives
 * @example Poll a retrieval job
 * ```typescript
 * const describeJob = yield* AWS.Glacier.DescribeJob(vault);
 *
 * const job = yield* describeJob({ jobId });
 * if (job.Completed) {
 *   // fetch with GetJobOutput
 * }
 * ```
 */
export interface DescribeJob extends Binding.Service<
  DescribeJob,
  "AWS.Glacier.DescribeJob",
  (
    vault: Vault,
  ) => Effect.Effect<
    (
      request: DescribeJobRequest,
    ) => Effect.Effect<glacier.GlacierJobDescription, glacier.DescribeJobError>
  >
> {}
export const DescribeJob = Binding.Service<DescribeJob>(
  "AWS.Glacier.DescribeJob",
);
