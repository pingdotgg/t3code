import type * as servicequotas from "@distilled.cloud/aws/service-quotas";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `servicequotas:StartQuotaUtilizationReport` — kick off
 * an asynchronous account-wide quota utilization report from inside a
 * Function. Poll the result with
 * {@link GetQuotaUtilizationReport | GetQuotaUtilizationReport}.
 *
 * @binding
 * @section Utilization Reports
 * @example Start a utilization report
 * ```typescript
 * // init
 * const startQuotaUtilizationReport =
 *   yield* AWS.ServiceQuotas.StartQuotaUtilizationReport();
 *
 * // runtime
 * const { ReportId } = yield* startQuotaUtilizationReport();
 * ```
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
export const StartQuotaUtilizationReport =
  Binding.Service<StartQuotaUtilizationReport>(
    "AWS.ServiceQuotas.StartQuotaUtilizationReport",
  );
