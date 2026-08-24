import type * as appsignals from "@distilled.cloud/aws/application-signals";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { ServiceLevelObjective } from "./ServiceLevelObjective.ts";

/**
 * `ListServiceLevelObjectiveExclusionWindows` request with `Id` injected
 * from the bound {@link ServiceLevelObjective}.
 */
export interface ListExclusionWindowsRequest extends Omit<
  appsignals.ListServiceLevelObjectiveExclusionWindowsInput,
  "Id"
> {}

/**
 * Runtime binding for
 * `application-signals:ListServiceLevelObjectiveExclusionWindows`, scoped
 * to one {@link ServiceLevelObjective}.
 *
 * Lists the exclusion (maintenance) windows configured on the bound SLO.
 * Provide the implementation with
 * `Effect.provide(AWS.ApplicationSignals.ListServiceLevelObjectiveExclusionWindowsHttp)`.
 * @binding
 * @section Managing Exclusion Windows
 * @example List the SLO's Exclusion Windows
 * ```typescript
 * // init — bind the operation to the SLO
 * const listExclusionWindows =
 *   yield* AWS.ApplicationSignals.ListServiceLevelObjectiveExclusionWindows(slo);
 *
 * // runtime — the SLO's ARN is injected as Id
 * const page = yield* listExclusionWindows();
 * yield* Effect.log(`${page.ExclusionWindows.length} windows`);
 * ```
 */
export interface ListServiceLevelObjectiveExclusionWindows extends Binding.Service<
  ListServiceLevelObjectiveExclusionWindows,
  "AWS.ApplicationSignals.ListServiceLevelObjectiveExclusionWindows",
  (
    slo: ServiceLevelObjective,
  ) => Effect.Effect<
    (
      request?: ListExclusionWindowsRequest,
    ) => Effect.Effect<
      appsignals.ListServiceLevelObjectiveExclusionWindowsOutput,
      appsignals.ListServiceLevelObjectiveExclusionWindowsError
    >
  >
> {}

export const ListServiceLevelObjectiveExclusionWindows =
  Binding.Service<ListServiceLevelObjectiveExclusionWindows>(
    "AWS.ApplicationSignals.ListServiceLevelObjectiveExclusionWindows",
  );
