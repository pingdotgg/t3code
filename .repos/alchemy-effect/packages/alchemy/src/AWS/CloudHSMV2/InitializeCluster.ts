import type * as cloudhsm from "@distilled.cloud/aws/cloudhsm-v2";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for the `InitializeCluster` operation (IAM action
 * `cloudhsm:InitializeCluster`).
 *
 * Claims an `UNINITIALIZED` CloudHSM cluster by submitting the cluster
 * certificate (the cluster's CSR signed by your issuing CA) and the CA's
 * root certificate — lets a Function automate the activation ceremony
 * around your CA. The certificates are public key material. Provide the
 * implementation with `Effect.provide(AWS.CloudHSMV2.InitializeClusterHttp)`.
 * @binding
 * @section Activating a Cluster
 * @example Submit The Signed Cluster Certificate
 * ```typescript
 * const initializeCluster = yield* AWS.CloudHSMV2.InitializeCluster();
 *
 * const result = yield* initializeCluster({
 *   ClusterId: clusterId,
 *   SignedCert: signedClusterCertPem,
 *   TrustAnchor: issuingCaRootPem,
 * });
 * // result.State === "INITIALIZE_IN_PROGRESS"
 * ```
 */
export interface InitializeCluster extends Binding.Service<
  InitializeCluster,
  "AWS.CloudHSMV2.InitializeCluster",
  () => Effect.Effect<
    (
      request: cloudhsm.InitializeClusterRequest,
    ) => Effect.Effect<
      cloudhsm.InitializeClusterResponse,
      cloudhsm.InitializeClusterError
    >
  >
> {}
export const InitializeCluster = Binding.Service<InitializeCluster>(
  "AWS.CloudHSMV2.InitializeCluster",
);
