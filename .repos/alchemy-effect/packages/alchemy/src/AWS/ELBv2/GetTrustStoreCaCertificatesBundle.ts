import type * as elbv2 from "@distilled.cloud/aws/elastic-load-balancing-v2";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { TrustStore } from "./TrustStore.ts";

/**
 * Runtime binding for the `GetTrustStoreCaCertificatesBundle` operation (IAM
 * action `elasticloadbalancing:GetTrustStoreCaCertificatesBundle` scoped to
 * the trust-store ARN).
 *
 * Returns a pre-signed S3 URI (active for ten minutes) for the bound
 * {@link TrustStore}'s CA certificate bundle — e.g. an ops endpoint that
 * serves or audits the mTLS CA bundle currently in force. The trust-store
 * ARN is injected from the binding. Provide the implementation with
 * `Effect.provide(AWS.ELBv2.GetTrustStoreCaCertificatesBundleHttp)`.
 * @binding
 * @section Trust Store Content
 * @example Fetch the presigned CA-bundle location
 * ```typescript
 * // init — bind the operation to the trust store
 * const getCaBundle = yield* AWS.ELBv2.GetTrustStoreCaCertificatesBundle(trustStore);
 *
 * // runtime — Location is a presigned S3 URL valid for ten minutes
 * const { Location } = yield* getCaBundle();
 * ```
 */
export interface GetTrustStoreCaCertificatesBundle extends Binding.Service<
  GetTrustStoreCaCertificatesBundle,
  "AWS.ELBv2.GetTrustStoreCaCertificatesBundle",
  (
    trustStore: TrustStore,
  ) => Effect.Effect<
    (
      request?: Omit<
        elbv2.GetTrustStoreCaCertificatesBundleInput,
        "TrustStoreArn"
      >,
    ) => Effect.Effect<
      elbv2.GetTrustStoreCaCertificatesBundleOutput,
      elbv2.GetTrustStoreCaCertificatesBundleError
    >
  >
> {}

export const GetTrustStoreCaCertificatesBundle =
  Binding.Service<GetTrustStoreCaCertificatesBundle>(
    "AWS.ELBv2.GetTrustStoreCaCertificatesBundle",
  );
