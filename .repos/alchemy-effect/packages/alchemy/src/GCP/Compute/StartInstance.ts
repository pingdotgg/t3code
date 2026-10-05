import type * as compute from "@distilled.cloud/gcp/compute_v1";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import type { Instance } from "./Instance.ts";

export interface StartInstanceRequest extends Omit<
  compute.StartInstancesRequest,
  "instance" | "zone" | "project"
> {}

/**
 * Runtime binding for Compute Engine `instances.start`.
 *
 * Bind this operation to an {@link Instance} in a Function/Action init phase.
 * Provide {@link StartInstanceHttp}.
 *
 * ### Instance Lifecycle Control
 * **Example:** Start the bound instance
 * ```typescript
 * const startInstance = yield* GCP.Compute.StartInstance(vm);
 * yield* startInstance();
 * ```
 *
 * @binding
 * @category Compute
 */
export interface StartInstance extends Binding.Service<
  StartInstance,
  "GCP.Compute.StartInstance",
  (
    instance: Instance,
  ) => Effect.Effect<
    (
      request?: StartInstanceRequest,
    ) => Effect.Effect<
      compute.Operation,
      compute.StartInstancesError,
      RuntimeContext
    >
  >
> {}

export const StartInstance = Binding.Service<StartInstance>(
  "GCP.Compute.StartInstance",
);
