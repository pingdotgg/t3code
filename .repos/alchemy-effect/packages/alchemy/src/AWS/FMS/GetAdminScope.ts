import type * as fms from "@distilled.cloud/aws/fms";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Request for {@link GetAdminScope}.
 */
export interface GetAdminScopeRequest extends fms.GetAdminScopeRequest {}

/**
 * Runtime binding for `fms:GetAdminScope`.
 *
 * Returns information about the specified account's administrative scope — the resources a Firewall Manager administrator can manage. Provide the
 * implementation with `Effect.provide(AWS.FMS.GetAdminScopeHttp)`.
 * @binding
 * @section Administrator Management
 * @example Read an Administrator's Scope
 * ```typescript
 * // init — account-level binding takes no resource
 * const getAdminScope = yield* AWS.FMS.GetAdminScope();
 *
 * // runtime
 * const result = yield* getAdminScope({ AdminAccount: accountId });
 * console.log(result.Status, result.AdminScope?.PolicyTypeScope);
 * ```
 */
export interface GetAdminScope extends Binding.Service<
  GetAdminScope,
  "AWS.FMS.GetAdminScope",
  () => Effect.Effect<
    (
      request: GetAdminScopeRequest,
    ) => Effect.Effect<fms.GetAdminScopeResponse, fms.GetAdminScopeError>
  >
> {}

export const GetAdminScope = Binding.Service<GetAdminScope>(
  "AWS.FMS.GetAdminScope",
);
