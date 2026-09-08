import type * as sesv2 from "@distilled.cloud/aws/sesv2";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `sesv2:GetDomainStatisticsReport`.
 *
 * Retrieves inbox-placement and engagement statistics for a domain identity
 * over a date range — the data behind the SES deliverability dashboard.
 * Requires the deliverability dashboard subscription; an unknown domain
 * surfaces the typed `NotFoundException`. Account-level operation. Provide the
 * implementation with `Effect.provide(AWS.SES.GetDomainStatisticsReportHttp)`.
 * ### Deliverability Insights
 * **Example:** Read a Domain's Deliverability Report
 * ```typescript
 * // init — account-level binding, no resource argument
 * const getReport = yield* SES.GetDomainStatisticsReport();
 *
 * // runtime
 * const report = yield* getReport({
 *   Domain: "example.com",
 *   StartDate: new Date(Date.now() - 7 * 24 * 3600 * 1000),
 *   EndDate: new Date(),
 * });
 * ```
 *
 * @binding
 */
export interface GetDomainStatisticsReport extends Binding.Service<
  GetDomainStatisticsReport,
  "AWS.SES.GetDomainStatisticsReport",
  () => Effect.Effect<
    (
      request: sesv2.GetDomainStatisticsReportRequest,
    ) => Effect.Effect<
      sesv2.GetDomainStatisticsReportResponse,
      sesv2.GetDomainStatisticsReportError
    >
  >
> {}
export const GetDomainStatisticsReport =
  Binding.Service<GetDomainStatisticsReport>(
    "AWS.SES.GetDomainStatisticsReport",
  );
