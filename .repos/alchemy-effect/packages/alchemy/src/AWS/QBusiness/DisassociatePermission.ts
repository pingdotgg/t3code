import type * as qbusiness from "@distilled.cloud/aws/qbusiness";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Application } from "./Application.ts";

/**
 * `DisassociatePermission` request with `applicationId` injected from the bound application.
 */
export interface DisassociatePermissionRequest extends Omit<
  qbusiness.DisassociatePermissionRequest,
  "applicationId"
> {}

/**
 * Runtime binding for the `DisassociatePermission` operation (IAM action
 * `qbusiness:DisassociatePermission`), scoped to one {@link Application}.
 *
 * Removes a statement from the application's permission policy.
 * Provide the implementation with
 * `Effect.provide(AWS.QBusiness.DisassociatePermissionHttp)`.
 *
 * @binding
 * @section Cross-Account Permissions
 * @example Revoke a Permission Statement
 * ```typescript
 * const disassociate = yield* AWS.QBusiness.DisassociatePermission(app);
 *
 * yield* disassociate({ statementId: "isv-search" });
 * ```
 */
export interface DisassociatePermission extends Binding.Service<
  DisassociatePermission,
  "AWS.QBusiness.DisassociatePermission",
  (
    application: Application,
  ) => Effect.Effect<
    (
      request: DisassociatePermissionRequest,
    ) => Effect.Effect<
      qbusiness.DisassociatePermissionResponse,
      qbusiness.DisassociatePermissionError
    >
  >
> {}
export const DisassociatePermission = Binding.Service<DisassociatePermission>(
  "AWS.QBusiness.DisassociatePermission",
);
