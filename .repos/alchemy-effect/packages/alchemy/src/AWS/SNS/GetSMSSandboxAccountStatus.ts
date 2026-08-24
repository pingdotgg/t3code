import * as sns from "@distilled.cloud/aws/sns";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

export interface GetSMSSandboxAccountStatusRequest
  extends sns.GetSMSSandboxAccountStatusInput {}

/**
 * Runtime binding for `sns:GetSMSSandboxAccountStatus`.
 *
 * An account-scoped operation — reports whether the account is still in
 * the SMS sandbox (only verified destination numbers deliverable).
 * Provide the `GetSMSSandboxAccountStatusHttp` layer on the Function to implement the binding.
 * @binding
 * @section SMS Sandbox
 * @example Check Sandbox Status
 * ```typescript
 * const getSandboxStatus = yield* SNS.GetSMSSandboxAccountStatus();
 * const { IsInSandbox } = yield* getSandboxStatus();
 * ```
 */
export interface GetSMSSandboxAccountStatus extends Binding.Service<
  GetSMSSandboxAccountStatus,
  "AWS.SNS.GetSMSSandboxAccountStatus",
  () => Effect.Effect<
    (
      request?: GetSMSSandboxAccountStatusRequest,
    ) => Effect.Effect<
      sns.GetSMSSandboxAccountStatusResult,
      sns.GetSMSSandboxAccountStatusError
    >
  >
> {}

export const GetSMSSandboxAccountStatus =
  Binding.Service<GetSMSSandboxAccountStatus>(
    "AWS.SNS.GetSMSSandboxAccountStatus",
  );
