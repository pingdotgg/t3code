import type * as SVC from "@distilled.cloud/aws/emr";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Cluster } from "./Cluster.ts";

/**
 * Runtime binding for `elasticmapreduce:GetSessionEndpoint` — resolves the Spark Connect endpoint URL and a time-limited auth token for an interactive session on the bound cluster. The returned `AuthToken` is `Redacted` — unwrap with `Redacted.value`.
 * @binding
 * @section Interactive Sessions
 * @example Connect a Spark Client
 * ```typescript
 * const getEndpoint = yield* AWS.EMR.GetSessionEndpoint(cluster);
 *
 * const { Endpoint, AuthToken } = yield* getEndpoint({
 *   SessionId: sessionId,
 * });
 * ```
 */
export interface GetSessionEndpoint extends Binding.Service<
  GetSessionEndpoint,
  "AWS.EMR.GetSessionEndpoint",
  <C extends Cluster>(
    cluster: C,
  ) => Effect.Effect<
    (
      request: Omit<SVC.GetSessionEndpointInput, "ClusterId">,
    ) => Effect.Effect<
      SVC.GetSessionEndpointOutput,
      SVC.GetSessionEndpointError
    >
  >
> {}
export const GetSessionEndpoint = Binding.Service<GetSessionEndpoint>(
  "AWS.EMR.GetSessionEndpoint",
);
