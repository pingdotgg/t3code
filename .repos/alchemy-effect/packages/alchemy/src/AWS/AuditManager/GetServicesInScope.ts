import type * as auditmanager from "@distilled.cloud/aws/auditmanager";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `auditmanager:GetServicesInScope`.
 *
 * Lists the AWS services that Audit Manager can include in the scope
 * of an assessment. Provide the
 * implementation with `Effect.provide(AWS.AuditManager.GetServicesInScopeHttp)`.
 * @binding
 * @section Account Status
 * @example List Services Audit Manager Can Assess
 * ```typescript
 * const getServicesInScope = yield* AWS.AuditManager.GetServicesInScope();
 * const result = yield* getServicesInScope();
 * ```
 */
export interface GetServicesInScope extends Binding.Service<
  GetServicesInScope,
  "AWS.AuditManager.GetServicesInScope",
  () => Effect.Effect<
    (
      request?: auditmanager.GetServicesInScopeRequest,
    ) => Effect.Effect<
      auditmanager.GetServicesInScopeResponse,
      auditmanager.GetServicesInScopeError
    >
  >
> {}

export const GetServicesInScope = Binding.Service<GetServicesInScope>(
  "AWS.AuditManager.GetServicesInScope",
);
