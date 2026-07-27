import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type * as Output from "../../Output.ts";
import { isBindingHost } from "../Lambda/Function.ts";

/**
 * Options for {@link makeAppFlowHttpBinding}. Everything except these five
 * inputs is identical across AppFlow's per-operation HTTP bindings.
 */
export interface AppFlowHttpBindingOptions<
  R extends { readonly LogicalId: string },
  K extends string,
  I extends { [P in K]?: string },
  A,
  E,
  OpR,
> {
  /**
   * The AppFlow action name, e.g. `"StartFlow"`. Becomes the IAM action
   * (`appflow:StartFlow`), the bind label, and the runtime span name.
   */
  action: string;
  /** The distilled AppFlow operation invoked at runtime. */
  operation: Effect.Effect<(input: I) => Effect.Effect<A, E>, never, OpR>;
  /**
   * Resolve the identifier the operation is keyed by (the flow name or the
   * connector profile name).
   */
  identifier: (resource: R) => Output.Output<string, never>;
  /** The request field the resolved identifier is injected as. */
  requestKey: K;
  /** The IAM policy resources the action is granted on. */
  resources: (resource: R) => Array<string | Output.Output<string, never>>;
}

/**
 * Shared scaffolding for AppFlow per-operation HTTP bindings.
 *
 * Every AppFlow runtime binding follows the same recipe: resolve the
 * identifier (flow name / connector profile name), register the IAM grant on
 * the binding host at deploy time, then invoke the distilled operation with
 * the identifier injected. This factory owns that recipe so each `{Op}Http.ts`
 * is a thin `Layer.effect(Cap, makeAppFlowHttpBinding({ ... }))` call whose
 * request/response/error types are still checked against the capability
 * contract at the `Layer.effect` site.
 *
 * Internal scaffolding — NOT exported from `index.ts`.
 */
export const makeAppFlowHttpBinding = <
  R extends { readonly LogicalId: string },
  K extends string,
  I extends { [P in K]?: string },
  A,
  E,
  OpR,
>(
  options: AppFlowHttpBindingOptions<R, K, I, A, E, OpR>,
) =>
  Effect.gen(function* () {
    const operation = yield* options.operation;

    return Effect.fn(function* (resource: R) {
      const Identifier = yield* options.identifier(resource);
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          yield* host.bind`Allow(${host}, AWS.AppFlow.${options.action}(${resource}))`(
            {
              policyStatements: [
                {
                  Effect: "Allow",
                  Action: [`appflow:${options.action}`],
                  Resource: options.resources(resource),
                },
              ],
            },
          );
        }
      }
      return Effect.fn(`AWS.AppFlow.${options.action}(${resource.LogicalId})`)(
        function* (request?: Omit<I, K>) {
          // The compiler cannot relate `Omit<I, K>` plus a computed generic
          // key back to `I`, so the identifier injection carries one
          // contained cast. Concrete request/response types are still fully
          // checked where each `Layer.effect(Cap, ...)` matches this factory's
          // inferred shape against the capability contract.
          return yield* operation({
            ...request,
            [options.requestKey]: yield* Identifier,
          } as unknown as I);
        },
      );
    });
  });
