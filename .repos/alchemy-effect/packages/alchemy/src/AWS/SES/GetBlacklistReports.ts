import type * as sesv2 from "@distilled.cloud/aws/sesv2";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `sesv2:GetBlacklistReports`.
 *
 * Retrieves, per dedicated-IP address, the list of anti-spam blacklists (RBLs)
 * that IP currently appears on, with the observation time. Useful for a
 * reputation dashboard over the account's dedicated IPs. Account-level
 * operation. Provide the implementation with
 * `Effect.provide(AWS.SES.GetBlacklistReportsHttp)`.
 * ### Deliverability Insights
 * **Example:** Check Blacklist Status for Dedicated IPs
 * ```typescript
 * // init — account-level binding, no resource argument
 * const getBlacklists = yield* SES.GetBlacklistReports();
 *
 * // runtime — the dedicated IP addresses to check
 * const { BlacklistReport } = yield* getBlacklists({
 *   BlacklistItemNames: ["192.0.2.1"],
 * });
 * ```
 *
 * @binding
 */
export interface GetBlacklistReports extends Binding.Service<
  GetBlacklistReports,
  "AWS.SES.GetBlacklistReports",
  () => Effect.Effect<
    (
      request: sesv2.GetBlacklistReportsRequest,
    ) => Effect.Effect<
      sesv2.GetBlacklistReportsResponse,
      sesv2.GetBlacklistReportsError
    >
  >
> {}
export const GetBlacklistReports = Binding.Service<GetBlacklistReports>(
  "AWS.SES.GetBlacklistReports",
);
