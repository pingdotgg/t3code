import type * as qbusiness from "@distilled.cloud/aws/qbusiness";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Application } from "./Application.ts";

/**
 * `AssociatePermission` request with `applicationId` injected from the bound application.
 */
export interface AssociatePermissionRequest extends Omit<
  qbusiness.AssociatePermissionRequest,
  "applicationId"
> {}

/**
 * Runtime binding for the `AssociatePermission` operation (IAM action
 * `qbusiness:AssociatePermission`), scoped to one {@link Application}.
 *
 * Adds a statement to the application's permission policy, granting
 * a principal (e.g. an ISV data accessor) cross-account access to Q
 * Business actions.
 * Provide the implementation with
 * `Effect.provide(AWS.QBusiness.AssociatePermissionHttp)`.
 *
 * @binding
 * @section Cross-Account Permissions
 * @example Grant an ISV SearchRelevantContent
 * ```typescript
 * const associate = yield* AWS.QBusiness.AssociatePermission(app);
 *
 * yield* associate({
 *   statementId: "isv-search",
 *   actions: ["qbusiness:SearchRelevantContent"],
 *   principal: "arn:aws:iam::123456789012:role/IsvRole",
 * });
 * ```
 */
export interface AssociatePermission extends Binding.Service<
  AssociatePermission,
  "AWS.QBusiness.AssociatePermission",
  (
    application: Application,
  ) => Effect.Effect<
    (
      request: AssociatePermissionRequest,
    ) => Effect.Effect<
      qbusiness.AssociatePermissionResponse,
      qbusiness.AssociatePermissionError
    >
  >
> {}
export const AssociatePermission = Binding.Service<AssociatePermission>(
  "AWS.QBusiness.AssociatePermission",
);
