import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type * as Output from "../../Output.ts";
import { isBindingHost } from "../Lambda/Function.ts";
import type { EnabledBaseline } from "./EnabledBaseline.ts";
import type { EnabledControl } from "./EnabledControl.ts";
import type { LandingZone } from "./LandingZone.ts";

/**
 * Shared HTTP scaffolding for the AWS Control Tower runtime bindings.
 *
 * Every capability follows the same shape — resolve the distilled operation,
 * register an IAM policy statement on the binding host, and return a runtime
 * callable. The only variation is the operation, the IAM action(s), and
 * whether the binding is scoped to one Control Tower resource (injecting its
 * identifier ARN into the request) or to the whole account (the baseline
 * catalog, list, and operation-status APIs, which are not resource-scoped).
 *
 * @internal — not exported from `index.ts`.
 */

/** The Control Tower resources that resource-scoped bindings can target. */
export type ControlTowerBindable =
  | EnabledControl
  | EnabledBaseline
  | LandingZone;

/**
 * Build the implementation effect for a resource-scoped capability: the
 * runtime callable injects the bound resource's identifier ARN as the
 * request's `requestKey` field, and the deploy-time half grants `iamActions`
 * on the resource's ARN.
 */
export const makeControlTowerHttpBinding = <
  Res extends ControlTowerBindable,
  I extends object,
  K extends keyof I & string,
  A,
  E,
  R,
  IdReq = never,
>(options: {
  /**
   * Short capability name used in the binding sid and runtime span, e.g.
   * `"ResetEnabledControl"`.
   */
  capability: string;
  /**
   * IAM actions granted on the resource's ARN, e.g.
   * `["controltower:ResetEnabledControl"]`.
   */
  iamActions: readonly string[];
  /** The request field the resolved identifier ARN is injected as. */
  requestKey: K;
  /** Resolve the injected identifier ARN from the bound resource. */
  identifier: (resource: Res) => Output.Output<string, IdReq>;
  /** The distilled operation; `requestKey` is injected from the resource. */
  operation: Effect.Effect<(input: I) => Effect.Effect<A, E>, never, R>;
}) =>
  Effect.gen(function* () {
    const op = yield* options.operation;

    return Effect.fn(function* (resource: Res) {
      const Identifier = yield* options.identifier(resource);
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          yield* host.bind`Allow(${host}, AWS.ControlTower.${options.capability}(${resource}))`(
            {
              policyStatements: [
                {
                  Effect: "Allow",
                  Action: [...options.iamActions],
                  Resource: [options.identifier(resource)],
                },
              ],
            },
          );
        }
      }
      return Effect.fn(
        `AWS.ControlTower.${options.capability}(${resource.LogicalId})`,
      )(function* (request?: Omit<I, K>) {
        return yield* op({
          ...request,
          [options.requestKey]: yield* Identifier,
        } as I);
      });
    });
  });

/**
 * Build the implementation effect for an account-level capability (no
 * resource argument — the baseline catalog, list, and operation-status
 * APIs). The deploy-time half grants `iamActions` on `Resource: ["*"]`
 * because these operations are not resource-scoped.
 */
export const makeControlTowerAccountHttpBinding = <
  I extends object,
  A,
  E,
  R,
>(options: {
  /**
   * Short capability name used in the binding sid and runtime span, e.g.
   * `"ListBaselines"`.
   */
  capability: string;
  /**
   * IAM actions granted on `Resource: ["*"]`.
   */
  iamActions: readonly string[];
  /**
   * The distilled operation implementing the capability.
   */
  operation: Effect.Effect<(input: I) => Effect.Effect<A, E>, never, R>;
}) =>
  Effect.gen(function* () {
    const op = yield* options.operation;

    return Effect.fn(function* () {
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          yield* host.bind`Allow(${host}, AWS.ControlTower.${options.capability}())`(
            {
              policyStatements: [
                {
                  Effect: "Allow",
                  Action: [...options.iamActions],
                  Resource: ["*"],
                },
              ],
            },
          );
        }
      }
      return Effect.fn(`AWS.ControlTower.${options.capability}`)(function* (
        request?: I,
      ) {
        return yield* op((request ?? {}) as I);
      });
    });
  });
