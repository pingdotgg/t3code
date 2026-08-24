import type * as elbv2 from "@distilled.cloud/aws/elastic-load-balancing-v2";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { LoadBalancer } from "./LoadBalancer.ts";

/**
 * `DescribeCapacityReservation` request with `LoadBalancerArn` injected from
 * the bound {@link LoadBalancer}.
 */
export interface DescribeCapacityReservationRequest extends Omit<
  elbv2.DescribeCapacityReservationInput,
  "LoadBalancerArn"
> {}

/**
 * Runtime binding for the `DescribeCapacityReservation` operation (IAM
 * action `elasticloadbalancing:DescribeCapacityReservation`; ELBv2
 * `Describe*` actions do not support resource-level permissions, so the
 * grant is on `*`).
 *
 * Reads the bound load balancer's LCU capacity reservation status — pairs
 * with {@link ModifyCapacityReservation} to confirm a reservation is
 * `provisioned` before a known traffic spike. Provide the implementation
 * with `Effect.provide(AWS.ELBv2.DescribeCapacityReservationHttp)`.
 * @binding
 * @section Capacity Reservation
 * @example Read the current reservation
 * ```typescript
 * // init — bind the operation to the load balancer
 * const describeCapacityReservation =
 *   yield* AWS.ELBv2.DescribeCapacityReservation(loadBalancer);
 *
 * // runtime — read reservation state per Availability Zone
 * const reservation = yield* describeCapacityReservation();
 * const states = reservation.CapacityReservationState?.map((s) => s.State);
 * ```
 */
export interface DescribeCapacityReservation extends Binding.Service<
  DescribeCapacityReservation,
  "AWS.ELBv2.DescribeCapacityReservation",
  (
    loadBalancer: LoadBalancer,
  ) => Effect.Effect<
    (
      request?: DescribeCapacityReservationRequest,
    ) => Effect.Effect<
      elbv2.DescribeCapacityReservationOutput,
      elbv2.DescribeCapacityReservationError
    >
  >
> {}

export const DescribeCapacityReservation =
  Binding.Service<DescribeCapacityReservation>(
    "AWS.ELBv2.DescribeCapacityReservation",
  );
