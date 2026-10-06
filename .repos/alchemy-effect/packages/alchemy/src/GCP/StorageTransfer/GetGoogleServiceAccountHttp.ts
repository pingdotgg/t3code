import * as storagetransfer from "@distilled.cloud/gcp/storagetransfer_v1";
import { Credentials } from "@distilled.cloud/gcp/Credentials";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpClient from "effect/http/HttpClient";
import { GetGoogleServiceAccount } from "./GetGoogleServiceAccount.ts";
import type { TransferJob } from "./TransferJob.ts";
import { bindGcpHost } from "../Host.ts";

/**
 * HTTP implementation of {@link GetGoogleServiceAccount}.
 *
 * @layer
 * @provides GCP.StorageTransfer.GetGoogleServiceAccount
 */
export const GetGoogleServiceAccountHttp: Layer.Layer<
  GetGoogleServiceAccount,
  never,
  Credentials | HttpClient.HttpClient
> = Layer.effect(
  GetGoogleServiceAccount,
  Effect.gen(function* () {
    const run = yield* storagetransfer.getGoogleServiceAccounts;
    return Effect.fn(function* (job: TransferJob) {
      yield* bindGcpHost({
        tag: "GCP.StorageTransfer.GetGoogleServiceAccount",
        resource: job,
        iam: [{ role: "roles/storagetransfer.viewer" }],
      });
      const project = yield* job.project;
      return Effect.fn(
        `GCP.StorageTransfer.GetGoogleServiceAccount(${job.LogicalId})`,
      )(function* () {
        return yield* run({ projectId: yield* project });
      });
    });
  }),
);
