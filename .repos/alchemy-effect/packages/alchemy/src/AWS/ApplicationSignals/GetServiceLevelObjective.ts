import type * as appsignals from "@distilled.cloud/aws/application-signals";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { ServiceLevelObjective } from "./ServiceLevelObjective.ts";

/**
 * Runtime binding for `application-signals:GetServiceLevelObjective`,
 * scoped to one {@link ServiceLevelObjective}.
 *
 * Returns the bound SLO's full configuration (SLI, goal, burn rates).
 * Provide the implementation with
 * `Effect.provide(AWS.ApplicationSignals.GetServiceLevelObjectiveHttp)`.
 * @binding
 * @section Reading SLOs
 * @example Read the Bound SLO
 * ```typescript
 * // init — bind the operation to the SLO
 * const getSlo = yield* AWS.ApplicationSignals.GetServiceLevelObjective(slo);
 *
 * // runtime — the SLO's ARN is injected automatically
 * const result = yield* getSlo();
 * yield* Effect.log(result.Slo.Goal.AttainmentGoal);
 * ```
 */
export interface GetServiceLevelObjective extends Binding.Service<
  GetServiceLevelObjective,
  "AWS.ApplicationSignals.GetServiceLevelObjective",
  (
    slo: ServiceLevelObjective,
  ) => Effect.Effect<
    () => Effect.Effect<
      appsignals.GetServiceLevelObjectiveOutput,
      appsignals.GetServiceLevelObjectiveError
    >
  >
> {}

export const GetServiceLevelObjective =
  Binding.Service<GetServiceLevelObjective>(
    "AWS.ApplicationSignals.GetServiceLevelObjective",
  );
