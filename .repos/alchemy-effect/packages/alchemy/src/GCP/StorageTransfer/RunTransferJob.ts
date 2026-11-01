import type * as storagetransfer from "@distilled.cloud/gcp/storagetransfer_v1";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import type { TransferJob } from "./TransferJob.ts";

export interface RunTransferJobRequest extends Omit<
  storagetransfer.RunTransferJobsRequest,
  "jobName"
> {}

/**
 * Runtime binding for Storage Transfer `transferJobs.run`.
 *
 * Starts a transfer operation immediately, even when the job has no
 * schedule. Bind this operation to a {@link TransferJob} in a
 * Function/Action init phase. Provide {@link RunTransferJobHttp}.
 *
 * Grants `roles/storagetransfer.user` on the project because Storage
 * Transfer has no resource-level IAM.
 *
 * ### Running Transfer Jobs
 * **Example:** Run the bound job now
 * ```typescript
 * const runJob = yield* GCP.StorageTransfer.RunTransferJob(nightly);
 * const operation = yield* runJob();
 * ```
 *
 * @binding
 * @category StorageTransfer
 */
export interface RunTransferJob extends Binding.Service<
  RunTransferJob,
  "GCP.StorageTransfer.RunTransferJob",
  (
    job: TransferJob,
  ) => Effect.Effect<
    (
      request?: RunTransferJobRequest,
    ) => Effect.Effect<
      storagetransfer.Operation,
      storagetransfer.RunTransferJobsError,
      RuntimeContext
    >
  >
> {}

export const RunTransferJob = Binding.Service<RunTransferJob>(
  "GCP.StorageTransfer.RunTransferJob",
);
