import type * as SVC from "@distilled.cloud/aws/finspace";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { KxEnvironment } from "./KxEnvironment.ts";

/**
 * Runtime binding for `finspace:UpdateKxClusterCodeConfiguration` — deploys new q code (and optionally a new initialization script or command-line arguments) to a running cluster with a rolling, forced, or no-restart strategy.
 * Provide the implementation with
 * `Effect.provide(AWS.FinSpace.UpdateKxClusterCodeConfigurationHttp)`.
 * @binding
 * @section Deploying to Clusters
 * @example Roll New Code onto a Cluster
 * ```typescript
 * const updateClusterCode = yield* AWS.FinSpace.UpdateKxClusterCodeConfiguration(kdb);
 *
 * yield* updateClusterCode({
 *   clusterName: "rdb",
 *   code: { s3Bucket: "code-bucket", s3Key: "release/v2.zip" },
 *   deploymentConfiguration: { deploymentStrategy: "ROLLING" },
 *   clientToken: crypto.randomUUID(),
 * });
 * ```
 */
export interface UpdateKxClusterCodeConfiguration extends Binding.Service<
  UpdateKxClusterCodeConfiguration,
  "AWS.FinSpace.UpdateKxClusterCodeConfiguration",
  <K extends KxEnvironment>(
    environment: K,
  ) => Effect.Effect<
    (
      request: Omit<
        SVC.UpdateKxClusterCodeConfigurationRequest,
        "environmentId"
      >,
    ) => Effect.Effect<
      SVC.UpdateKxClusterCodeConfigurationResponse,
      SVC.UpdateKxClusterCodeConfigurationError
    >
  >
> {}
export const UpdateKxClusterCodeConfiguration =
  Binding.Service<UpdateKxClusterCodeConfiguration>(
    "AWS.FinSpace.UpdateKxClusterCodeConfiguration",
  );
