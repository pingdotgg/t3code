import type * as iam from "@distilled.cloud/aws/iam";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `iam:GetAccountSummary` — read IAM entity usage and
 * quota counters for the account (`Users`, `Roles`, `PoliciesQuota`, `MFADevices`,
 * `AccountMFAEnabled`, …). The quick health snapshot behind quota alarms and
 * security dashboards.
 *
 * Account-singleton operation: the binding takes no arguments and grants
 * `iam:GetAccountSummary` on `*`. Provide the implementation with
 * `Effect.provide(AWS.IAM.GetAccountSummaryHttp)`.
 *
 * @binding
 * @section Account Auditing
 * @example Alarm When Nearing the Role Quota
 * ```typescript
 * // init
 * const getAccountSummary = yield* IAM.GetAccountSummary();
 *
 * // runtime
 * const { SummaryMap } = yield* getAccountSummary();
 * const nearQuota =
 *   (SummaryMap?.Roles ?? 0) > 0.9 * (SummaryMap?.RolesQuota ?? Infinity);
 * ```
 */
export interface GetAccountSummary extends Binding.Service<
  GetAccountSummary,
  "AWS.IAM.GetAccountSummary",
  () => Effect.Effect<
    (
      request?: iam.GetAccountSummaryRequest,
    ) => Effect.Effect<
      iam.GetAccountSummaryResponse,
      iam.GetAccountSummaryError
    >
  >
> {}
export const GetAccountSummary = Binding.Service<GetAccountSummary>(
  "AWS.IAM.GetAccountSummary",
);
