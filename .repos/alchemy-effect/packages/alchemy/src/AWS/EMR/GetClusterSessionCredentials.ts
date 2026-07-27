import type * as SVC from "@distilled.cloud/aws/emr";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Cluster } from "./Cluster.ts";

/**
 * Runtime binding for `elasticmapreduce:GetClusterSessionCredentials` — mints temporary HTTP basic credentials for the bound cluster's endpoints (runtime-role / fine-grained access control clusters). The returned `Password` is `Redacted` — unwrap with `Redacted.value`.
 * @binding
 * @section Connecting to the Cluster
 * @example Mint Session Credentials
 * ```typescript
 * const getCredentials = yield* AWS.EMR.GetClusterSessionCredentials(cluster);
 *
 * const { Credentials, ExpiresAt } = yield* getCredentials({
 *   ExecutionRoleArn: runtimeRoleArn,
 * });
 * const password = Redacted.value(
 *   Credentials!.UsernamePassword.Password! as Redacted.Redacted<string>,
 * );
 * ```
 */
export interface GetClusterSessionCredentials extends Binding.Service<
  GetClusterSessionCredentials,
  "AWS.EMR.GetClusterSessionCredentials",
  <C extends Cluster>(
    cluster: C,
  ) => Effect.Effect<
    (
      request?: Omit<SVC.GetClusterSessionCredentialsInput, "ClusterId">,
    ) => Effect.Effect<
      SVC.GetClusterSessionCredentialsOutput,
      SVC.GetClusterSessionCredentialsError
    >
  >
> {}
export const GetClusterSessionCredentials =
  Binding.Service<GetClusterSessionCredentials>(
    "AWS.EMR.GetClusterSessionCredentials",
  );
