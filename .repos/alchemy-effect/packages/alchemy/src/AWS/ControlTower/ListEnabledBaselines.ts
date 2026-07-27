import type * as controltower from "@distilled.cloud/aws/controltower";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `controltower:ListEnabledBaselines`.
 *
 * An account-level operation that enumerates the baselines enabled across
 * the organization's targets, optionally filtered by target or baseline
 * identifiers. Useful for compliance dashboards that report which OUs are
 * registered with Control Tower. Provide the implementation with
 * `Effect.provide(AWS.ControlTower.ListEnabledBaselinesHttp)`.
 * @binding
 * @section Auditing Enablements
 * @example List Baselines Enabled on an OU
 * ```typescript
 * // init — account-level binding takes no resource
 * const listEnabledBaselines = yield* AWS.ControlTower.ListEnabledBaselines();
 *
 * // runtime
 * const result = yield* listEnabledBaselines({
 *   filter: { targetIdentifiers: [ouArn] },
 * });
 * const statuses = result.enabledBaselines.map(
 *   (b) => b.statusSummary.status,
 * );
 * ```
 */
export interface ListEnabledBaselines extends Binding.Service<
  ListEnabledBaselines,
  "AWS.ControlTower.ListEnabledBaselines",
  () => Effect.Effect<
    (
      request?: controltower.ListEnabledBaselinesInput,
    ) => Effect.Effect<
      controltower.ListEnabledBaselinesOutput,
      controltower.ListEnabledBaselinesError
    >
  >
> {}

export const ListEnabledBaselines = Binding.Service<ListEnabledBaselines>(
  "AWS.ControlTower.ListEnabledBaselines",
);
