import type * as glacier from "@distilled.cloud/aws/glacier";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Vault } from "./Vault.ts";

/**
 * `ListJobs` request with `accountId` and `vaultName` injected from the bound
 * {@link Vault}.
 */
export interface ListJobsRequest extends Omit<
  glacier.ListJobsInput,
  "accountId" | "vaultName"
> {}

/**
 * Runtime binding for the `ListJobs` operation (IAM action
 * `glacier:ListJobs` on the vault ARN).
 *
 * Lists in-progress and recently finished jobs for the bound
 * {@link Vault}, optionally filtered by status code or completion.
 * Provide the implementation with
 * `Effect.provide(AWS.Glacier.ListJobsHttp)`.
 * @binding
 * @section Retrieving Archives
 * @example List the vault's jobs
 * ```typescript
 * const listJobs = yield* AWS.Glacier.ListJobs(vault);
 *
 * const { JobList } = yield* listJobs({ completed: "true" });
 * ```
 */
export interface ListJobs extends Binding.Service<
  ListJobs,
  "AWS.Glacier.ListJobs",
  (
    vault: Vault,
  ) => Effect.Effect<
    (
      request?: ListJobsRequest,
    ) => Effect.Effect<glacier.ListJobsOutput, glacier.ListJobsError>
  >
> {}
export const ListJobs = Binding.Service<ListJobs>("AWS.Glacier.ListJobs");
