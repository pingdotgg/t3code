import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import * as Output from "../../Output.ts";
import { isBindingHost } from "../Lambda/Function.ts";
import type { TargetGroup } from "./TargetGroup.ts";

/**
 * Shared scaffolding for the VPC Lattice runtime bindings.
 *
 * NOT exported from `index.ts` — every `{Op}Http.ts` in this service is a
 * thin `Layer.effect(Cap, makeVpcLatticeTargetGroupHttpBinding({ … }))` over
 * the builder below. Everything except the operation, the IAM action list,
 * and the injected `targetGroupIdentifier` is boilerplate.
 */

/**
 * Build the impl Effect for a target-group-scoped VPC Lattice operation: the
 * runtime callable injects the bound {@link TargetGroup}'s ID as
 * `targetGroupIdentifier` and the deploy-time half grants `actions` on the
 * target group's ARN.
 */
export const makeVpcLatticeTargetGroupHttpBinding = <
  I extends { targetGroupIdentifier?: string },
  A,
  E,
  R,
>(options: {
  /** Fully-qualified binding tag, e.g. `AWS.VpcLattice.ListTargets`. */
  tag: string;
  /**
   * The distilled operation; `targetGroupIdentifier` is injected from the
   * target group.
   */
  operation: Effect.Effect<(input: I) => Effect.Effect<A, E>, never, R>;
  /** IAM actions granted on the target group ARN. */
  actions: readonly string[];
}) =>
  Effect.gen(function* () {
    const op = yield* options.operation;

    return Effect.fn(function* (targetGroup: TargetGroup) {
      const targetGroupIdentifier = yield* targetGroup.targetGroupId;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          yield* host.bind`Allow(${host}, ${options.tag}(${targetGroup}))`({
            policyStatements: [
              {
                Effect: "Allow",
                Action: [...options.actions],
                Resource: [Output.interpolate`${targetGroup.targetGroupArn}`],
              },
            ],
          });
        }
      }
      return Effect.fn(`${options.tag}(${targetGroup.LogicalId})`)(function* (
        request: Omit<I, "targetGroupIdentifier">,
      ) {
        return yield* op({
          ...request,
          targetGroupIdentifier: yield* targetGroupIdentifier,
        } as I);
      });
    });
  });
