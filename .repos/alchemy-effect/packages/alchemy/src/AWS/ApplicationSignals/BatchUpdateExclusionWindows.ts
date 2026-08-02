import type * as appsignals from "@distilled.cloud/aws/application-signals";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { ServiceLevelObjective } from "./ServiceLevelObjective.ts";

/**
 * `BatchUpdateExclusionWindows` request with `SloIds` injected from the
 * bound {@link ServiceLevelObjective}.
 */
export interface UpdateExclusionWindowsRequest extends Omit<
  appsignals.BatchUpdateExclusionWindowsInput,
  "SloIds"
> {}

/**
 * Runtime binding for `application-signals:BatchUpdateExclusionWindows`,
 * scoped to one {@link ServiceLevelObjective}.
 *
 * Adds or removes exclusion (maintenance) windows on the bound SLO — for
 * example, automation that excludes a deployment window from SLO
 * attainment. Provide the implementation with
 * `Effect.provide(AWS.ApplicationSignals.BatchUpdateExclusionWindowsHttp)`.
 * @binding
 * @section Managing Exclusion Windows
 * @example Exclude a Maintenance Window
 * ```typescript
 * // init — bind the operation to the SLO
 * const updateExclusionWindows =
 *   yield* AWS.ApplicationSignals.BatchUpdateExclusionWindows(slo);
 *
 * // runtime — the SLO's ARN is injected as SloIds
 * yield* updateExclusionWindows({
 *   AddExclusionWindows: [
 *     {
 *       StartTime: new Date(),
 *       Window: { DurationUnit: "HOUR", Duration: 2 },
 *       Reason: "scheduled maintenance",
 *     },
 *   ],
 * });
 * ```
 */
export interface BatchUpdateExclusionWindows extends Binding.Service<
  BatchUpdateExclusionWindows,
  "AWS.ApplicationSignals.BatchUpdateExclusionWindows",
  (
    slo: ServiceLevelObjective,
  ) => Effect.Effect<
    (
      request: UpdateExclusionWindowsRequest,
    ) => Effect.Effect<
      appsignals.BatchUpdateExclusionWindowsOutput,
      appsignals.BatchUpdateExclusionWindowsError
    >
  >
> {}

export const BatchUpdateExclusionWindows =
  Binding.Service<BatchUpdateExclusionWindows>(
    "AWS.ApplicationSignals.BatchUpdateExclusionWindows",
  );
