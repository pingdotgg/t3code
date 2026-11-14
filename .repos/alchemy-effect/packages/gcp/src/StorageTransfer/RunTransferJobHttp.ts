import { Credentials } from "@distilled.cloud/gcp/Credentials";
import * as storagetransfer from "@distilled.cloud/gcp/storagetransfer_v1";
import * as HttpClient from "effect/http/HttpClient";
import * as Layer from "effect/Layer";
import { makeTransferJobHttpBinding } from "./BindingHttp.ts";
import { RunTransferJob } from "./RunTransferJob.ts";

/**
 * HTTP implementation of {@link RunTransferJob}.
 *
 * @layer
 * @provides GCP.StorageTransfer.RunTransferJob
 */
export const RunTransferJobHttp: Layer.Layer<
  RunTransferJob,
  never,
  Credentials | HttpClient.HttpClient
> = Layer.effect(
  RunTransferJob,
  makeTransferJobHttpBinding<
    storagetransfer.RunTransferJobsRequest,
    storagetransfer.Operation,
    storagetransfer.RunTransferJobsError
  >({
    tag: "GCP.StorageTransfer.RunTransferJob",
    iam: { role: "roles/storagetransfer.user" },
    operation: storagetransfer.runTransferJobs,
    projectInBody: true,
  }),
);
