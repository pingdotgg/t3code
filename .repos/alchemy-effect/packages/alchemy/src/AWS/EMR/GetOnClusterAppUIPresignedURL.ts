import type * as SVC from "@distilled.cloud/aws/emr";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Cluster } from "./Cluster.ts";

/**
 * Runtime binding for `elasticmapreduce:GetOnClusterAppUIPresignedURL` — mints a presigned URL for a live application UI (Spark UI, YARN ResourceManager, Tez) on the bound cluster.
 * @binding
 * @section Application UIs
 * @example Link to the Spark UI
 * ```typescript
 * const getAppUrl = yield* AWS.EMR.GetOnClusterAppUIPresignedURL(cluster);
 *
 * const { PresignedURL } = yield* getAppUrl({
 *   OnClusterAppUIType: "ApplicationMaster",
 * });
 * ```
 */
export interface GetOnClusterAppUIPresignedURL extends Binding.Service<
  GetOnClusterAppUIPresignedURL,
  "AWS.EMR.GetOnClusterAppUIPresignedURL",
  <C extends Cluster>(
    cluster: C,
  ) => Effect.Effect<
    (
      request?: Omit<SVC.GetOnClusterAppUIPresignedURLInput, "ClusterId">,
    ) => Effect.Effect<
      SVC.GetOnClusterAppUIPresignedURLOutput,
      SVC.GetOnClusterAppUIPresignedURLError
    >
  >
> {}
export const GetOnClusterAppUIPresignedURL =
  Binding.Service<GetOnClusterAppUIPresignedURL>(
    "AWS.EMR.GetOnClusterAppUIPresignedURL",
  );
