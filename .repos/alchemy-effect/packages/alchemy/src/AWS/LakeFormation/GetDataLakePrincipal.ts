import type * as lf from "@distilled.cloud/aws/lakeformation";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Request for {@link GetDataLakePrincipal}.
 */
export interface GetDataLakePrincipalRequest
  extends lf.GetDataLakePrincipalRequest {}

/**
 * Runtime binding for `lakeformation:GetDataLakePrincipal`.
 *
 * Returns the identity of the calling principal as Lake Formation sees it —
 * useful for logging/auditing which data-lake principal a function acts as.
 * Provide the implementation with
 * `Effect.provide(AWS.LakeFormation.GetDataLakePrincipalHttp)`.
 * @binding
 * @section Identifying the Caller
 * @example Read the Calling Data Lake Principal
 * ```typescript
 * // init — account-level binding takes no resource
 * const getDataLakePrincipal = yield* AWS.LakeFormation.GetDataLakePrincipal();
 *
 * // runtime
 * const { Identity } = yield* getDataLakePrincipal();
 * ```
 */
export interface GetDataLakePrincipal extends Binding.Service<
  GetDataLakePrincipal,
  "AWS.LakeFormation.GetDataLakePrincipal",
  () => Effect.Effect<
    (
      request?: GetDataLakePrincipalRequest,
    ) => Effect.Effect<
      lf.GetDataLakePrincipalResponse,
      lf.GetDataLakePrincipalError
    >
  >
> {}

export const GetDataLakePrincipal = Binding.Service<GetDataLakePrincipal>(
  "AWS.LakeFormation.GetDataLakePrincipal",
);
