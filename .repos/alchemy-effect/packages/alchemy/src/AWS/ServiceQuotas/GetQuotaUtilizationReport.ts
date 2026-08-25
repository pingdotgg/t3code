import type * as servicequotas from "@distilled.cloud/aws/service-quotas";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `servicequotas:GetQuotaUtilizationReport` — read the
 * result of a utilization report started with
 * {@link StartQuotaUtilizationReport | StartQuotaUtilizationReport} from
 * inside a Function.
 *
 * @binding
 * @section Utilization Reports
 * @example Read a utilization report
 * ```typescript
 * // init
 * const getQuotaUtilizationReport =
 *   yield* AWS.ServiceQuotas.GetQuotaUtilizationReport();
 *
 * // runtime
 * const { Status, QuotaUtilizationList } = yield* getQuotaUtilizationReport({
 *   ReportId: reportId,
 * });
 * ```
 */
export interface GetQuotaUtilizationReport extends Binding.Service<
  GetQuotaUtilizationReport,
  "AWS.ServiceQuotas.GetQuotaUtilizationReport",
  () => Effect.Effect<
    (
      request: servicequotas.GetQuotaUtilizationReportRequest,
    ) => Effect.Effect<
      servicequotas.GetQuotaUtilizationReportResponse,
      servicequotas.GetQuotaUtilizationReportError
    >
  >
> {}
export const GetQuotaUtilizationReport =
  Binding.Service<GetQuotaUtilizationReport>(
    "AWS.ServiceQuotas.GetQuotaUtilizationReport",
  );
