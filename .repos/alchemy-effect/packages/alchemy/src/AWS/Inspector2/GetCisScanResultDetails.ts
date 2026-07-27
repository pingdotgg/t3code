import type * as inspector2 from "@distilled.cloud/aws/inspector2";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `inspector2:GetCisScanResultDetails`.
 *
 * Retrieves CIS scan result details.
 *
 * Provide the implementation with
 * `Effect.provide(AWS.Inspector2.GetCisScanResultDetailsHttp)`.
 * @binding
 * @section CIS Scan Results
 * @example CIS Result Details for an Instance
 * ```typescript
 * // init
 * const getCisScanResultDetails = yield* AWS.Inspector2.GetCisScanResultDetails();
 *
 * // runtime
 * const { scanResultDetails } = yield* getCisScanResultDetails({
 *   scanArn,
 *   accountId,
 *   targetResourceId: instanceId,
 * });
 * ```
 */
export interface GetCisScanResultDetails extends Binding.Service<
  GetCisScanResultDetails,
  "AWS.Inspector2.GetCisScanResultDetails",
  () => Effect.Effect<
    (
      request: inspector2.GetCisScanResultDetailsRequest,
    ) => Effect.Effect<
      inspector2.GetCisScanResultDetailsResponse,
      inspector2.GetCisScanResultDetailsError
    >
  >
> {}
export const GetCisScanResultDetails = Binding.Service<GetCisScanResultDetails>(
  "AWS.Inspector2.GetCisScanResultDetails",
);
