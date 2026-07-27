import type * as elbv2 from "@distilled.cloud/aws/elastic-load-balancing-v2";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { TrustStore } from "./TrustStore.ts";

/**
 * `GetTrustStoreRevocationContent` request with `TrustStoreArn` injected from
 * the bound {@link TrustStore}.
 */
export interface GetTrustStoreRevocationContentRequest extends Omit<
  elbv2.GetTrustStoreRevocationContentInput,
  "TrustStoreArn"
> {}

/**
 * Runtime binding for the `GetTrustStoreRevocationContent` operation (IAM
 * action `elasticloadbalancing:GetTrustStoreRevocationContent` scoped to the
 * trust-store ARN).
 *
 * Returns a pre-signed S3 URI (active for ten minutes) for a certificate
 * revocation list (CRL) previously added to the bound {@link TrustStore} —
 * e.g. an ops endpoint auditing which client certificates are currently
 * revoked. A missing revocation id surfaces as the typed
 * `RevocationIdNotFoundException`. Provide the implementation with
 * `Effect.provide(AWS.ELBv2.GetTrustStoreRevocationContentHttp)`.
 * @binding
 * @section Trust Store Content
 * @example Fetch a revocation list's presigned location
 * ```typescript
 * // init — bind the operation to the trust store
 * const getRevocation = yield* AWS.ELBv2.GetTrustStoreRevocationContent(trustStore);
 *
 * // runtime
 * const { Location } = yield* getRevocation({ RevocationId: 1 });
 * ```
 */
export interface GetTrustStoreRevocationContent extends Binding.Service<
  GetTrustStoreRevocationContent,
  "AWS.ELBv2.GetTrustStoreRevocationContent",
  (
    trustStore: TrustStore,
  ) => Effect.Effect<
    (
      request?: GetTrustStoreRevocationContentRequest,
    ) => Effect.Effect<
      elbv2.GetTrustStoreRevocationContentOutput,
      elbv2.GetTrustStoreRevocationContentError
    >
  >
> {}

export const GetTrustStoreRevocationContent =
  Binding.Service<GetTrustStoreRevocationContent>(
    "AWS.ELBv2.GetTrustStoreRevocationContent",
  );
