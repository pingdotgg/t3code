import { Credentials } from "@distilled.cloud/gcp/Credentials";
import * as storagetransfer from "@distilled.cloud/gcp/storagetransfer_v1";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as Layer from "effect/Layer";
import * as GCPBindings from "../GCPBindings.ts";
import { GetGoogleServiceAccount } from "./GetGoogleServiceAccount.ts";
import type { TransferJob } from "./TransferJob.ts";

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
    const bind = yield* GCPBindings.Bind;
    const run = yield* GCPBindings.withCredentials(storagetransfer.getGoogleServiceAccounts);
    return Effect.fn(function* (job: TransferJob) {
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        yield* bind`GCP.StorageTransfer.GetGoogleServiceAccount(${job})`({
          iam: [{ role: "roles/storagetransfer.viewer" }],
        });
      }
      const project = yield* job.project;
      return Effect.fn(`GCP.StorageTransfer.GetGoogleServiceAccount(${job.LogicalId})`)(
        function* () {
          return yield* run({ projectId: yield* project });
        },
      );
    });
  }),
);
