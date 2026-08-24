import type * as qbusiness from "@distilled.cloud/aws/qbusiness";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Application } from "./Application.ts";

/**
 * `GetPolicy` request with `applicationId` injected from the bound application.
 */
export interface GetPolicyRequest extends Omit<
  qbusiness.GetPolicyRequest,
  "applicationId"
> {}

/**
 * Runtime binding for the `GetPolicy` operation (IAM action
 * `qbusiness:GetPolicy`), scoped to one {@link Application}.
 *
 * Reads the application's resource-based permission policy (the
 * statements ISV data accessors were granted).
 * Provide the implementation with
 * `Effect.provide(AWS.QBusiness.GetPolicyHttp)`.
 *
 * @binding
 * @section Cross-Account Permissions
 * @example Read the Application Policy
 * ```typescript
 * const getPolicy = yield* AWS.QBusiness.GetPolicy(app);
 *
 * const { policy } = yield* getPolicy();
 * ```
 */
export interface GetPolicy extends Binding.Service<
  GetPolicy,
  "AWS.QBusiness.GetPolicy",
  (
    application: Application,
  ) => Effect.Effect<
    (
      request?: GetPolicyRequest,
    ) => Effect.Effect<qbusiness.GetPolicyResponse, qbusiness.GetPolicyError>
  >
> {}
export const GetPolicy = Binding.Service<GetPolicy>("AWS.QBusiness.GetPolicy");
