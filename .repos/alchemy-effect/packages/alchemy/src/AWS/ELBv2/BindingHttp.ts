import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import * as Output from "../../Output.ts";
import { isInstance } from "../EC2/Instance.ts";
import { isTask } from "../ECS/Task.ts";
import { isBindingHost } from "../Lambda/Function.ts";
import type { LoadBalancer } from "./LoadBalancer.ts";
import type { TargetGroup } from "./TargetGroup.ts";
import type { TrustStore } from "./TrustStore.ts";

/**
 * Shared scaffolding for ELBv2 HTTP bindings.
 *
 * NOT exported from `index.ts` — every `{Op}Http.ts` in this service is a
 * thin `Layer.effect(Cap, make…HttpBinding({ … }))` over one of the two
 * builders below. Everything except the operation and the IAM action list is
 * boilerplate: the runtime callable injects the bound resource's ARN
 * (`TargetGroupArn` / `LoadBalancerArn`) into the request and the deploy-time
 * half grants `actions` on that ARN — or on `*` for `Describe*` actions,
 * which do not support resource-level permissions in ELBv2.
 *
 * Hosts: Lambda Functions plus self-registering compute (ECS Tasks and EC2
 * Instances registering themselves into a target group at boot).
 */

const bindHost = (
  tag: string,
  actions: readonly string[],
  resource: TargetGroup | LoadBalancer | TrustStore,
  iamResource: Output.Output<string> | "*",
) =>
  Effect.gen(function* () {
    if (!globalThis.__ALCHEMY_RUNTIME__) {
      const host = yield* Binding.Host;
      if (isBindingHost(host) || isTask(host) || isInstance(host)) {
        yield* host.bind`Allow(${host}, ${tag}(${resource}))`({
          policyStatements: [
            {
              Effect: "Allow",
              Action: [...actions],
              Resource: [iamResource === "*" ? "*" : iamResource],
            },
          ],
        });
      }
    }
  });

/**
 * Build the impl Effect for a target-group-addressed operation: the runtime
 * callable injects the bound {@link TargetGroup}'s ARN as `TargetGroupArn`;
 * the deploy-time half grants `actions` on the target-group ARN
 * (`"target-group"`, the default) or on `*` (`Describe*` actions do not
 * support resource-level permissions).
 */
export const makeTargetGroupHttpBinding = <
  I extends { TargetGroupArn?: string },
  A,
  E,
  R,
>(options: {
  /** Fully-qualified binding tag, e.g. `AWS.ELBv2.RegisterTargets`. */
  tag: string;
  /** The distilled operation; `TargetGroupArn` is injected from the group. */
  operation: Effect.Effect<(input: I) => Effect.Effect<A, E>, never, R>;
  /** IAM actions granted by the binding. */
  actions: readonly string[];
  /**
   * IAM resource scope. Write actions support resource-level permissions on
   * the target-group ARN (`"target-group"`, the default); `Describe*`
   * actions do not (`"*"`).
   */
  resource?: "target-group" | "*";
}) =>
  Effect.gen(function* () {
    const op = yield* options.operation;

    return Effect.fn(function* (targetGroup: TargetGroup) {
      const TargetGroupArn = yield* targetGroup.targetGroupArn;
      yield* bindHost(
        options.tag,
        options.actions,
        targetGroup,
        options.resource === "*"
          ? "*"
          : Output.interpolate`${targetGroup.targetGroupArn}`,
      );
      return Effect.fn(`${options.tag}(${targetGroup.LogicalId})`)(function* (
        request: Omit<I, "TargetGroupArn">,
      ) {
        return yield* op({
          ...request,
          TargetGroupArn: yield* TargetGroupArn,
        } as I);
      });
    });
  });

/**
 * Build the impl Effect for a load-balancer-addressed operation: the runtime
 * callable injects the bound {@link LoadBalancer}'s ARN as `LoadBalancerArn`;
 * the deploy-time half grants `actions` on the load-balancer ARN
 * (`"load-balancer"`, the default) or on `*` (`Describe*` actions do not
 * support resource-level permissions).
 */
export const makeLoadBalancerHttpBinding = <
  I extends { LoadBalancerArn?: string },
  A,
  E,
  R,
>(options: {
  /** Fully-qualified binding tag, e.g. `AWS.ELBv2.ModifyCapacityReservation`. */
  tag: string;
  /** The distilled operation; `LoadBalancerArn` is injected from the LB. */
  operation: Effect.Effect<(input: I) => Effect.Effect<A, E>, never, R>;
  /** IAM actions granted by the binding. */
  actions: readonly string[];
  /**
   * IAM resource scope. Write actions support resource-level permissions on
   * the load-balancer ARN (`"load-balancer"`, the default); `Describe*`
   * actions do not (`"*"`).
   */
  resource?: "load-balancer" | "*";
}) =>
  Effect.gen(function* () {
    const op = yield* options.operation;

    return Effect.fn(function* (loadBalancer: LoadBalancer) {
      const LoadBalancerArn = yield* loadBalancer.loadBalancerArn;
      yield* bindHost(
        options.tag,
        options.actions,
        loadBalancer,
        options.resource === "*"
          ? "*"
          : Output.interpolate`${loadBalancer.loadBalancerArn}`,
      );
      return Effect.fn(`${options.tag}(${loadBalancer.LogicalId})`)(function* (
        request?: Omit<I, "LoadBalancerArn">,
      ) {
        return yield* op({
          ...request,
          LoadBalancerArn: yield* LoadBalancerArn,
        } as I);
      });
    });
  });

/**
 * Build the impl Effect for a trust-store-addressed operation: the runtime
 * callable injects the bound {@link TrustStore}'s ARN as `TrustStoreArn`;
 * the deploy-time half grants `actions` on the trust-store ARN (mTLS
 * `GetTrustStore*` reads support resource-level permissions).
 */
export const makeTrustStoreHttpBinding = <
  I extends { TrustStoreArn?: string },
  A,
  E,
  R,
>(options: {
  /** Fully-qualified binding tag, e.g. `AWS.ELBv2.GetTrustStoreCaCertificatesBundle`. */
  tag: string;
  /** The distilled operation; `TrustStoreArn` is injected from the store. */
  operation: Effect.Effect<(input: I) => Effect.Effect<A, E>, never, R>;
  /** IAM actions granted on the trust-store ARN. */
  actions: readonly string[];
}) =>
  Effect.gen(function* () {
    const op = yield* options.operation;

    return Effect.fn(function* (trustStore: TrustStore) {
      const TrustStoreArn = yield* trustStore.trustStoreArn;
      yield* bindHost(
        options.tag,
        options.actions,
        trustStore,
        Output.interpolate`${trustStore.trustStoreArn}`,
      );
      return Effect.fn(`${options.tag}(${trustStore.LogicalId})`)(function* (
        request?: Omit<I, "TrustStoreArn">,
      ) {
        return yield* op({
          ...request,
          TrustStoreArn: yield* TrustStoreArn,
        } as I);
      });
    });
  });
