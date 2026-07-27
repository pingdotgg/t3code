import type * as controltower from "@distilled.cloud/aws/controltower";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `controltower:ListBaselines`.
 *
 * An account-level operation that enumerates the Control Tower baseline
 * catalog (e.g. `AWSControlTowerBaseline`, `AuditBaseline`,
 * `LogArchiveBaseline`). Useful for governance functions that discover the
 * baseline ARN to enable on an organizational unit. Provide the
 * implementation with `Effect.provide(AWS.ControlTower.ListBaselinesHttp)`.
 * @binding
 * @section Browsing the Baseline Catalog
 * @example List the Available Baselines
 * ```typescript
 * // init — account-level binding takes no resource
 * const listBaselines = yield* AWS.ControlTower.ListBaselines();
 *
 * // runtime
 * const result = yield* listBaselines();
 * const ouBaseline = result.baselines.find(
 *   (b) => b.name === "AWSControlTowerBaseline",
 * );
 * ```
 */
export interface ListBaselines extends Binding.Service<
  ListBaselines,
  "AWS.ControlTower.ListBaselines",
  () => Effect.Effect<
    (
      request?: controltower.ListBaselinesInput,
    ) => Effect.Effect<
      controltower.ListBaselinesOutput,
      controltower.ListBaselinesError
    >
  >
> {}

export const ListBaselines = Binding.Service<ListBaselines>(
  "AWS.ControlTower.ListBaselines",
);
