import type * as SVC from "@distilled.cloud/aws/finspace";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { KxEnvironment } from "./KxEnvironment.ts";

/**
 * Runtime binding for `finspace:GetKxConnectionString` — retrieves a signed connection string a kdb user can use to connect to a cluster in the bound environment. The returned `signedConnectionString` embeds a SigV4 signature and is surfaced as `Redacted`.
 * Provide the implementation with
 * `Effect.provide(AWS.FinSpace.GetKxConnectionStringHttp)`.
 * @binding
 * @section Connecting to Clusters
 * @example Connect a User to a Cluster
 * ```typescript
 * const getConnectionString = yield* AWS.FinSpace.GetKxConnectionString(kdb);
 *
 * const { signedConnectionString } = yield* getConnectionString({
 *   userArn: user.userArn,
 *   clusterName: "hdb",
 * });
 * const value = Redacted.value(signedConnectionString!);
 * ```
 */
export interface GetKxConnectionString extends Binding.Service<
  GetKxConnectionString,
  "AWS.FinSpace.GetKxConnectionString",
  <K extends KxEnvironment>(
    environment: K,
  ) => Effect.Effect<
    (
      request: Omit<SVC.GetKxConnectionStringRequest, "environmentId">,
    ) => Effect.Effect<
      SVC.GetKxConnectionStringResponse,
      SVC.GetKxConnectionStringError
    >
  >
> {}
export const GetKxConnectionString = Binding.Service<GetKxConnectionString>(
  "AWS.FinSpace.GetKxConnectionString",
);
