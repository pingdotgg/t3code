import type * as sesv2 from "@distilled.cloud/aws/sesv2";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `sesv2:GetAccount`.
 *
 * Retrieves the SES account's sending status in the current region — the
 * send quota, whether sending is enabled, and whether the account has
 * production access (or is still in the sandbox). Useful to check remaining
 * quota before a large send. Account-level operation — invoked with no
 * arguments. Provide the implementation with
 * `Effect.provide(AWS.SES.GetAccountHttp)`.
 * @binding
 * @section Account Status
 * @example Check Quota and Sandbox Status
 * ```typescript
 * // init — account-level binding, no resource argument
 * const getAccount = yield* SES.GetAccount();
 *
 * // runtime
 * const account = yield* getAccount();
 * // account.SendQuota?.Max24HourSend, account.ProductionAccessEnabled
 * ```
 */
export interface GetAccount extends Binding.Service<
  GetAccount,
  "AWS.SES.GetAccount",
  () => Effect.Effect<
    (
      request?: sesv2.GetAccountRequest,
    ) => Effect.Effect<sesv2.GetAccountResponse, sesv2.GetAccountError>
  >
> {}
export const GetAccount = Binding.Service<GetAccount>("AWS.SES.GetAccount");
