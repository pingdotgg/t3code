import type * as servicequotas from "@distilled.cloud/aws/service-quotas";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";

/**
 * Runtime binding for `servicequotas:StartQuotaUtilizationReport` — kick off
 * an asynchronous account-wide quota utilization report from inside a
 * Function. Poll the result with
 * {@link GetQuotaUtilizationReport | GetQuotaUtilizationReport}.
 *
 * ### Utilization Reports
 * **Example:** Start a utilization report
 * ```typescript
 * // init
 * const startQuotaUtilizationReport =
 *   yield* AWS.ServiceQuotas.StartQuotaUtilizationReport();
 *
 * // runtime
 * const { ReportId } = yield* startQuotaUtilizationReport();
 * ```
 *
 * @binding
 */
export interface StartQuotaUtilizationReport extends Binding.Service<
  StartQuotaUtilizationReport,
  "AWS.ServiceQuotas.StartQuotaUtilizationReport",
  () => Effect.Effect<
    (
      request?: servicequotas.StartQuotaUtilizationReportRequest,
    ) => Effect.Effect<
      servicequotas.StartQuotaUtilizationReportResponse,
      servicequotas.StartQuotaUtilizationReportError
    >
  >
> {}
export const StartQuotaUtilizationReport = Binding.Service<StartQuotaUtilizationReport>(
  "AWS.ServiceQuotas.StartQuotaUtilizationReport",
);
