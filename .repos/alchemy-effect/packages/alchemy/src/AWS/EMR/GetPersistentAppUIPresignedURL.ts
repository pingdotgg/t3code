import type * as SVC from "@distilled.cloud/aws/emr";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Cluster } from "./Cluster.ts";

/**
 * Runtime binding for `elasticmapreduce:GetPersistentAppUIPresignedURL` — mints a presigned URL for a persistent application UI of the bound cluster (works after the cluster terminates).
 * @binding
 * @section Application UIs
 * @example Link to the Spark History Server
 * ```typescript
 * const getAppUIUrl = yield* AWS.EMR.GetPersistentAppUIPresignedURL(cluster);
 *
 * const { PresignedURL } = yield* getAppUIUrl({
 *   PersistentAppUIId: appUIId,
 *   PersistentAppUIType: "SHS",
 * });
 * ```
 */
export interface GetPersistentAppUIPresignedURL extends Binding.Service<
  GetPersistentAppUIPresignedURL,
  "AWS.EMR.GetPersistentAppUIPresignedURL",
  <C extends Cluster>(
    cluster: C,
  ) => Effect.Effect<
    (
      request: SVC.GetPersistentAppUIPresignedURLInput,
    ) => Effect.Effect<
      SVC.GetPersistentAppUIPresignedURLOutput,
      SVC.GetPersistentAppUIPresignedURLError
    >
  >
> {}
export const GetPersistentAppUIPresignedURL =
  Binding.Service<GetPersistentAppUIPresignedURL>(
    "AWS.EMR.GetPersistentAppUIPresignedURL",
  );
