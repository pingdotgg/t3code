import type * as iam from "@distilled.cloud/aws/iam";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `iam:GetAccountAuthorizationDetails` — snapshot every
 * IAM user, group, role, and policy in the account together with their
 * relationships. The single-call foundation for permission-graph analyzers
 * and drift detectors.
 *
 * Account-singleton operation: the binding takes no arguments and grants
 * `iam:GetAccountAuthorizationDetails` on `*`. Provide the implementation
 * with `Effect.provide(AWS.IAM.GetAccountAuthorizationDetailsHttp)`.
 *
 * @binding
 * @section Account Auditing
 * @example Snapshot Roles and Their Policies
 * ```typescript
 * // init
 * const getAuthorizationDetails = yield* IAM.GetAccountAuthorizationDetails();
 *
 * // runtime — paginate with the Marker until IsTruncated is false
 * const page = yield* getAuthorizationDetails({
 *   Filter: ["Role"],
 *   MaxItems: 100,
 * });
 * const roles = page.RoleDetailList ?? [];
 * ```
 */
export interface GetAccountAuthorizationDetails extends Binding.Service<
  GetAccountAuthorizationDetails,
  "AWS.IAM.GetAccountAuthorizationDetails",
  () => Effect.Effect<
    (
      request?: iam.GetAccountAuthorizationDetailsRequest,
    ) => Effect.Effect<
      iam.GetAccountAuthorizationDetailsResponse,
      iam.GetAccountAuthorizationDetailsError
    >
  >
> {}
export const GetAccountAuthorizationDetails =
  Binding.Service<GetAccountAuthorizationDetails>(
    "AWS.IAM.GetAccountAuthorizationDetails",
  );
