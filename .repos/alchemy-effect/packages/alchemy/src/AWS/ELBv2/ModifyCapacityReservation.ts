import type * as elbv2 from "@distilled.cloud/aws/elastic-load-balancing-v2";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { LoadBalancer } from "./LoadBalancer.ts";

/**
 * `ModifyCapacityReservation` request with `LoadBalancerArn` injected from
 * the bound {@link LoadBalancer}.
 */
export interface ModifyCapacityReservationRequest extends Omit<
  elbv2.ModifyCapacityReservationInput,
  "LoadBalancerArn"
> {}

/**
 * Runtime binding for the `ModifyCapacityReservation` operation (IAM action
 * `elasticloadbalancing:ModifyCapacityReservation` scoped to the
 * load-balancer ARN).
 *
 * Sets or resets the bound load balancer's minimum LCU capacity reservation
 * at runtime — e.g. a Lambda that pre-provisions capacity ahead of a known
 * traffic spike (product launch, ticket sale) and resets it afterwards, the
 * ELBv2 analogue of Auto Scaling's `SetDesiredCapacity`. Provide the
 * implementation with
 * `Effect.provide(AWS.ELBv2.ModifyCapacityReservationHttp)`.
 * @binding
 * @section Capacity Reservation
 * @example Reserve capacity ahead of a spike
 * ```typescript
 * // init — bind the operation to the load balancer
 * const modifyCapacityReservation =
 *   yield* AWS.ELBv2.ModifyCapacityReservation(loadBalancer);
 *
 * // runtime — reserve 100 LCUs per Availability Zone
 * yield* modifyCapacityReservation({
 *   MinimumLoadBalancerCapacity: { CapacityUnits: 100 },
 * });
 *
 * // later — release the reservation
 * yield* modifyCapacityReservation({ ResetCapacityReservation: true });
 * ```
 */
export interface ModifyCapacityReservation extends Binding.Service<
  ModifyCapacityReservation,
  "AWS.ELBv2.ModifyCapacityReservation",
  (
    loadBalancer: LoadBalancer,
  ) => Effect.Effect<
    (
      request: ModifyCapacityReservationRequest,
    ) => Effect.Effect<
      elbv2.ModifyCapacityReservationOutput,
      elbv2.ModifyCapacityReservationError
    >
  >
> {}

export const ModifyCapacityReservation =
  Binding.Service<ModifyCapacityReservation>(
    "AWS.ELBv2.ModifyCapacityReservation",
  );
