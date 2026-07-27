import type * as appsignals from "@distilled.cloud/aws/application-signals";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { ServiceLevelObjective } from "./ServiceLevelObjective.ts";

/**
 * `BatchGetServiceLevelObjectiveBudgetReport` request with `SloIds`
 * injected from the bound {@link ServiceLevelObjective}.
 */
export interface GetBudgetReportRequest extends Omit<
  appsignals.BatchGetServiceLevelObjectiveBudgetReportInput,
  "SloIds"
> {}

/**
 * Runtime binding for
 * `application-signals:BatchGetServiceLevelObjectiveBudgetReport`, scoped
 * to one {@link ServiceLevelObjective}.
 *
 * Retrieves the bound SLO's error-budget report — health indicator,
 * attainment, and remaining budget — at the requested timestamp. Provide
 * the implementation with
 * `Effect.provide(AWS.ApplicationSignals.BatchGetServiceLevelObjectiveBudgetReportHttp)`.
 * @binding
 * @section Reading SLOs
 * @example Check the SLO's Error Budget
 * ```typescript
 * // init — bind the operation to the SLO
 * const getBudgetReport =
 *   yield* AWS.ApplicationSignals.BatchGetServiceLevelObjectiveBudgetReport(slo);
 *
 * // runtime — the SLO's ARN is injected as SloIds
 * const result = yield* getBudgetReport({ Timestamp: new Date() });
 * const report = result.Reports[0];
 * yield* Effect.log(`${report?.BudgetStatus}: ${report?.Attainment}%`);
 * ```
 */
export interface BatchGetServiceLevelObjectiveBudgetReport extends Binding.Service<
  BatchGetServiceLevelObjectiveBudgetReport,
  "AWS.ApplicationSignals.BatchGetServiceLevelObjectiveBudgetReport",
  (
    slo: ServiceLevelObjective,
  ) => Effect.Effect<
    (
      request: GetBudgetReportRequest,
    ) => Effect.Effect<
      appsignals.BatchGetServiceLevelObjectiveBudgetReportOutput,
      appsignals.BatchGetServiceLevelObjectiveBudgetReportError
    >
  >
> {}

export const BatchGetServiceLevelObjectiveBudgetReport =
  Binding.Service<BatchGetServiceLevelObjectiveBudgetReport>(
    "AWS.ApplicationSignals.BatchGetServiceLevelObjectiveBudgetReport",
  );
