import type * as ga from "@distilled.cloud/aws/global-accelerator";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Accelerator } from "./Accelerator.ts";

/**
 * Runtime binding for `globalaccelerator:DescribeAccelerator`.
 *
 * Reads the bound {@link Accelerator}'s live state — deployment status
 * (`DEPLOYED` / `IN_PROGRESS`), DNS names, static IP sets, and whether it is
 * enabled — so a function can health-check the accelerator or hand out its
 * DNS name at runtime. The accelerator ARN is injected from the binding.
 * Provide the implementation with
 * `Effect.provide(AWS.GlobalAccelerator.DescribeAcceleratorHttp)`.
 * @binding
 * @section Observing Accelerators
 * @example Read the Accelerator's Status and DNS Name
 * ```typescript
 * // init — bind the operation to the accelerator
 * const describeAccelerator =
 *   yield* AWS.GlobalAccelerator.DescribeAccelerator(accelerator);
 *
 * // runtime
 * const { Accelerator } = yield* describeAccelerator();
 * yield* Effect.log(`${Accelerator?.DnsName} is ${Accelerator?.Status}`);
 * ```
 */
export interface DescribeAccelerator extends Binding.Service<
  DescribeAccelerator,
  "AWS.GlobalAccelerator.DescribeAccelerator",
  (
    accelerator: Accelerator,
  ) => Effect.Effect<
    () => Effect.Effect<
      ga.DescribeAcceleratorResponse,
      ga.DescribeAcceleratorError
    >
  >
> {}
export const DescribeAccelerator = Binding.Service<DescribeAccelerator>(
  "AWS.GlobalAccelerator.DescribeAccelerator",
);
