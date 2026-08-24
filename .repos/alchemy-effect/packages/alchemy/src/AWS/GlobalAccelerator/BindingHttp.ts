import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { PolicyStatement } from "../IAM/Policy.ts";
import { isBindingHost } from "../Lambda/Function.ts";
import type { Accelerator } from "./Accelerator.ts";
import { withGaRegion } from "./common.ts";
import type { EndpointGroup } from "./EndpointGroup.ts";

/**
 * Shared scaffolding for AWS Global Accelerator HTTP bindings.
 *
 * NOT exported from `index.ts` — every thin `{Op}Http.ts` in this service is
 * a `Layer.effect(Cap, make…HttpBinding({ … }))` over one of the two builders
 * below. Everything except the operation and the IAM action list is
 * boilerplate.
 *
 * The Global Accelerator control-plane API only exists in us-west-2, so the
 * operation is resolved under {@link withGaRegion} — the binding works no
 * matter which region the host Function is deployed to.
 */

/**
 * Build the impl Effect for a Global Accelerator operation scoped to an
 * {@link Accelerator}: the deploy-time half grants `actions` on the bound
 * accelerator's ARN, and the runtime half injects the accelerator's
 * `AcceleratorArn` into every request.
 */
export const makeGaAcceleratorHttpBinding = <
  I extends { AcceleratorArn: string },
  A,
  E,
  R,
>(options: {
  /** Fully-qualified binding tag, e.g. `AWS.GlobalAccelerator.DescribeAccelerator`. */
  tag: string;
  /** The distilled operation. */
  operation: Effect.Effect<(input: I) => Effect.Effect<A, E>, never, R>;
  /** IAM actions granted on the accelerator ARN. */
  actions: readonly string[];
}) =>
  Effect.gen(function* () {
    const op = yield* withGaRegion(options.operation);

    return Effect.fn(function* (accelerator: Accelerator) {
      const AcceleratorArn = yield* accelerator.acceleratorArn;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          yield* host.bind`Allow(${host}, ${options.tag}(${accelerator}))`({
            policyStatements: [
              {
                Effect: "Allow",
                Action: [...options.actions],
                Resource: [accelerator.acceleratorArn],
              },
            ],
          });
        }
      }
      return Effect.fn(`${options.tag}(${accelerator.LogicalId})`)(function* (
        request?: Omit<I, "AcceleratorArn">,
      ) {
        const acceleratorArn = yield* AcceleratorArn;
        return yield* op({ ...request, AcceleratorArn: acceleratorArn } as I);
      });
    });
  });

/**
 * Build the impl Effect for a Global Accelerator operation scoped to an
 * {@link EndpointGroup}: the deploy-time half grants `actions` on the bound
 * endpoint group's ARN, and the runtime half injects the group's
 * `EndpointGroupArn` into every request.
 */
export const makeGaEndpointGroupHttpBinding = <
  I extends { EndpointGroupArn: string },
  A,
  E,
  R,
>(options: {
  /** Fully-qualified binding tag, e.g. `AWS.GlobalAccelerator.AddEndpoints`. */
  tag: string;
  /** The distilled operation. */
  operation: Effect.Effect<(input: I) => Effect.Effect<A, E>, never, R>;
  /** IAM actions granted on the endpoint group ARN. */
  actions: readonly string[];
  /**
   * Additional statements granted alongside the group-scoped one (e.g. the
   * `ec2:Describe*` / `elasticloadbalancing:DescribeLoadBalancers` reads
   * Global Accelerator performs on the caller's behalf when endpoints are
   * added).
   */
  extraStatements?: readonly PolicyStatement[];
}) =>
  Effect.gen(function* () {
    const op = yield* withGaRegion(options.operation);

    return Effect.fn(function* (endpointGroup: EndpointGroup) {
      const EndpointGroupArn = yield* endpointGroup.endpointGroupArn;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          yield* host.bind`Allow(${host}, ${options.tag}(${endpointGroup}))`({
            policyStatements: [
              {
                Effect: "Allow",
                Action: [...options.actions],
                Resource: [endpointGroup.endpointGroupArn],
              },
              ...(options.extraStatements ?? []),
            ],
          });
        }
      }
      return Effect.fn(`${options.tag}(${endpointGroup.LogicalId})`)(function* (
        request: Omit<I, "EndpointGroupArn">,
      ) {
        const endpointGroupArn = yield* EndpointGroupArn;
        return yield* op({
          ...request,
          EndpointGroupArn: endpointGroupArn,
        } as I);
      });
    });
  });
