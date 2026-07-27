import type * as account from "@distilled.cloud/aws/account";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `account:GetRegionOptStatus`.
 *
 * Reads the opt-in status of a single Region for the calling account
 * (`ENABLED`, `DISABLED`, `ENABLING`, `DISABLING`, or
 * `ENABLED_BY_DEFAULT`). Account Management is an account singleton, so the
 * binding takes no resource argument. Provide the implementation with
 * `Effect.provide(AWS.Account.GetRegionOptStatusHttp)`.
 * @binding
 * @section Reading Region Opt Status
 * @example Check Whether an Opt-in Region Is Enabled
 * ```typescript
 * // init — account-level binding, no resource argument
 * const getRegionOptStatus = yield* AWS.Account.GetRegionOptStatus();
 *
 * // runtime
 * const status = yield* getRegionOptStatus({ RegionName: "ap-east-1" });
 * console.log(status.RegionOptStatus);
 * ```
 */
export interface GetRegionOptStatus extends Binding.Service<
  GetRegionOptStatus,
  "AWS.Account.GetRegionOptStatus",
  () => Effect.Effect<
    (
      request: account.GetRegionOptStatusRequest,
    ) => Effect.Effect<
      account.GetRegionOptStatusResponse,
      account.GetRegionOptStatusError
    >
  >
> {}
export const GetRegionOptStatus = Binding.Service<GetRegionOptStatus>(
  "AWS.Account.GetRegionOptStatus",
);
