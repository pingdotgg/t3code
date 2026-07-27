import type * as organizations from "@distilled.cloud/aws/organizations";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `organizations:DescribeCreateAccountStatus`.
 *
 * Retrieves the current status of an asynchronous account-creation request — the polling half of an account-vending workflow.
 * Account-level operation — Organizations is a management-account-scoped
 * global service, so the binding takes no resource argument. Provide the
 * implementation with `Effect.provide(AWS.Organizations.DescribeCreateAccountStatusHttp)`.
 * @binding
 * @section Account Vending
 * @example Poll an Account-Creation Request
 * ```typescript
 * // init — account-level binding, no resource argument
 * const describeCreateAccountStatus = yield* AWS.Organizations.DescribeCreateAccountStatus();
 *
 * // runtime
 * const { CreateAccountStatus } = yield* describeCreateAccountStatus({
 *   CreateAccountRequestId: requestId,
 * });
 * ```
 */
export interface DescribeCreateAccountStatus extends Binding.Service<
  DescribeCreateAccountStatus,
  "AWS.Organizations.DescribeCreateAccountStatus",
  () => Effect.Effect<
    (
      request: organizations.DescribeCreateAccountStatusRequest,
    ) => Effect.Effect<
      organizations.DescribeCreateAccountStatusResponse,
      organizations.DescribeCreateAccountStatusError
    >
  >
> {}
export const DescribeCreateAccountStatus =
  Binding.Service<DescribeCreateAccountStatus>(
    "AWS.Organizations.DescribeCreateAccountStatus",
  );
