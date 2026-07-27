import type * as controltower from "@distilled.cloud/aws/controltower";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `controltower:ListEnabledControls`.
 *
 * An account-level operation that enumerates the controls (guardrails)
 * enabled on an organizational unit — or, with a filter, across the whole
 * organization. Useful for compliance dashboards and drift-detection
 * functions. Provide the implementation with
 * `Effect.provide(AWS.ControlTower.ListEnabledControlsHttp)`.
 * @binding
 * @section Auditing Enablements
 * @example List Controls Enabled on an OU
 * ```typescript
 * // init — account-level binding takes no resource
 * const listEnabledControls = yield* AWS.ControlTower.ListEnabledControls();
 *
 * // runtime
 * const result = yield* listEnabledControls({ targetIdentifier: ouArn });
 * const drifted = result.enabledControls.filter(
 *   (c) => c.driftStatusSummary?.driftStatus === "DRIFTED",
 * );
 * ```
 */
export interface ListEnabledControls extends Binding.Service<
  ListEnabledControls,
  "AWS.ControlTower.ListEnabledControls",
  () => Effect.Effect<
    (
      request?: controltower.ListEnabledControlsInput,
    ) => Effect.Effect<
      controltower.ListEnabledControlsOutput,
      controltower.ListEnabledControlsError
    >
  >
> {}

export const ListEnabledControls = Binding.Service<ListEnabledControls>(
  "AWS.ControlTower.ListEnabledControls",
);
