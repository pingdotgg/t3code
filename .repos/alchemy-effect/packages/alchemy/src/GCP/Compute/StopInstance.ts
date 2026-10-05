import type * as compute from "@distilled.cloud/gcp/compute_v1";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import type { Instance } from "./Instance.ts";

export interface StopInstanceRequest extends Omit<
  compute.StopInstancesRequest,
  "instance" | "zone" | "project"
> {}

/**
 * Runtime binding for Compute Engine `instances.stop`.
 *
 * Bind this operation to an {@link Instance} in a Function/Action init phase.
 * Provide {@link StopInstanceHttp}.
 *
 * ### Instance Lifecycle Control
 * **Example:** Stop the bound instance
 * ```typescript
 * const stopInstance = yield* GCP.Compute.StopInstance(vm);
 * yield* stopInstance();
 * ```
 *
 * @binding
 * @category Compute
 */
export interface StopInstance extends Binding.Service<
  StopInstance,
  "GCP.Compute.StopInstance",
  (
    instance: Instance,
  ) => Effect.Effect<
    (
      request?: StopInstanceRequest,
    ) => Effect.Effect<
      compute.Operation,
      compute.StopInstancesError,
      RuntimeContext
    >
  >
> {}

export const StopInstance = Binding.Service<StopInstance>(
  "GCP.Compute.StopInstance",
);
