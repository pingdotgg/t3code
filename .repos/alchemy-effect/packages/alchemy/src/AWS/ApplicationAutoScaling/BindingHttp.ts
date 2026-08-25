import type * as aas from "@distilled.cloud/aws/application-auto-scaling";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import { isBindingHost } from "../Lambda/Function.ts";
import type { ScalableTarget } from "./ScalableTarget.ts";
import type { ScalingPolicy } from "./ScalingPolicy.ts";

/**
 * Shared scaffolding for Application Auto Scaling HTTP bindings.
 *
 * NOT exported from `index.ts` — every `{Op}Http.ts` in this service is a
 * thin `Layer.effect(Cap, make…HttpBinding({ … }))` over one of the two
 * builders below. Everything except the operation and the IAM action list is
 * boilerplate: the runtime callable injects the scalable target's identity
 * triple (`ServiceNamespace`/`ResourceId`/`ScalableDimension`) — plus
 * `PolicyName` for policy-scoped operations — from the bound resource.
 *
 * All grants use `Resource: ["*"]` because Application Auto Scaling's
 * describe/get actions do not support resource-level permissions (only the
 * tagging actions accept the `scalable-target/…` ARN).
 */

/** The request fields identifying a scalable target, injected from the bound resource. */
interface TargetTriple {
  ServiceNamespace: aas.ServiceNamespace;
  ResourceId: string;
  ScalableDimension: aas.ScalableDimension;
}

/**
 * Build the impl Effect for a scalable-target-scoped operation: the runtime
 * callable injects the bound {@link ScalableTarget}'s identity triple and the
 * deploy-time half grants `actions` on `*`.
 */
export const makeTargetScopedHttpBinding = <
  I extends TargetTriple,
  A,
  E,
  R,
>(options: {
  /** Fully-qualified binding tag, e.g. `AWS.ApplicationAutoScaling.DescribeScalingActivities`. */
  tag: string;
  /** The distilled operation; the identity triple is injected from the target. */
  operation: Effect.Effect<(input: I) => Effect.Effect<A, E>, never, R>;
  /** IAM actions granted on `*` (no resource-level permission support). */
  actions: readonly string[];
}) =>
  Effect.gen(function* () {
    const op = yield* options.operation;

    return Effect.fn(function* (target: ScalableTarget) {
      const ServiceNamespace = yield* target.serviceNamespace;
      const ResourceId = yield* target.resourceId;
      const ScalableDimension = yield* target.scalableDimension;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          yield* host.bind`Allow(${host}, ${options.tag}(${target}))`({
            policyStatements: [
              {
                Effect: "Allow",
                Action: [...options.actions],
                Resource: ["*"],
              },
            ],
          });
        }
      }
      return Effect.fn(`${options.tag}(${target.LogicalId})`)(function* (
        request?: Omit<I, keyof TargetTriple>,
      ) {
        return yield* op({
          ...request,
          ServiceNamespace: yield* ServiceNamespace,
          ResourceId: yield* ResourceId,
          ScalableDimension: yield* ScalableDimension,
        } as I);
      });
    });
  });

/**
 * Build the impl Effect for a scaling-policy-scoped operation: the runtime
 * callable injects the bound {@link ScalingPolicy}'s identity triple and
 * `PolicyName`, and the deploy-time half grants `actions` on `*`.
 */
export const makePolicyScopedHttpBinding = <
  I extends TargetTriple & { PolicyName: string },
  A,
  E,
  R,
>(options: {
  /** Fully-qualified binding tag, e.g. `AWS.ApplicationAutoScaling.GetPredictiveScalingForecast`. */
  tag: string;
  /** The distilled operation; the triple and `PolicyName` are injected from the policy. */
  operation: Effect.Effect<(input: I) => Effect.Effect<A, E>, never, R>;
  /** IAM actions granted on `*` (no resource-level permission support). */
  actions: readonly string[];
}) =>
  Effect.gen(function* () {
    const op = yield* options.operation;

    return Effect.fn(function* (policy: ScalingPolicy) {
      const ServiceNamespace = yield* policy.serviceNamespace;
      const ResourceId = yield* policy.resourceId;
      const ScalableDimension = yield* policy.scalableDimension;
      const PolicyName = yield* policy.policyName;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          yield* host.bind`Allow(${host}, ${options.tag}(${policy}))`({
            policyStatements: [
              {
                Effect: "Allow",
                Action: [...options.actions],
                Resource: ["*"],
              },
            ],
          });
        }
      }
      return Effect.fn(`${options.tag}(${policy.LogicalId})`)(function* (
        request: Omit<I, keyof TargetTriple | "PolicyName">,
      ) {
        return yield* op({
          ...request,
          ServiceNamespace: yield* ServiceNamespace,
          ResourceId: yield* ResourceId,
          ScalableDimension: yield* ScalableDimension,
          PolicyName: yield* PolicyName,
        } as I);
      });
    });
  });
