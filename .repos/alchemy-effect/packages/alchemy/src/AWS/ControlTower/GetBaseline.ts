import type * as controltower from "@distilled.cloud/aws/controltower";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `controltower:GetBaseline`.
 *
 * An account-level operation that reads one entry of the Control Tower
 * baseline catalog by its ARN — its name and description. Provide the
 * implementation with `Effect.provide(AWS.ControlTower.GetBaselineHttp)`.
 * @binding
 * @section Browsing the Baseline Catalog
 * @example Read a Baseline's Details
 * ```typescript
 * // init — account-level binding takes no resource
 * const getBaseline = yield* AWS.ControlTower.GetBaseline();
 *
 * // runtime
 * const baseline = yield* getBaseline({ baselineIdentifier: baselineArn });
 * console.log(baseline.name, baseline.description);
 * ```
 */
export interface GetBaseline extends Binding.Service<
  GetBaseline,
  "AWS.ControlTower.GetBaseline",
  () => Effect.Effect<
    (
      request: controltower.GetBaselineInput,
    ) => Effect.Effect<
      controltower.GetBaselineOutput,
      controltower.GetBaselineError
    >
  >
> {}

export const GetBaseline = Binding.Service<GetBaseline>(
  "AWS.ControlTower.GetBaseline",
);
