import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import { isBindingHost } from "../Lambda/Function.ts";

/**
 * Shared scaffolding for X-Ray HTTP bindings.
 *
 * NOT exported from `index.ts` — every single-operation `{Op}Http.ts` in
 * this service is a thin `Layer.effect(Cap, makeXRayHttpBinding({ … }))`
 * over the builder below. Everything except the operation and the IAM
 * action is boilerplate.
 *
 * X-Ray's trace, sampling, graph, and insight actions do not support
 * resource-level permissions, so the deploy-time half of every binding
 * grants its `actions` on `*` and the runtime callable passes the caller's
 * request through unchanged.
 */
export const makeXRayHttpBinding = <I, A, E, R>(options: {
  /** Fully-qualified binding tag, e.g. `AWS.XRay.GetServiceGraph`. */
  tag: string;
  /** The distilled operation, invoked with the caller's request as-is. */
  operation: Effect.Effect<(input: I) => Effect.Effect<A, E>, never, R>;
  /** IAM actions granted on `*` (X-Ray has no resource-level permissions). */
  actions: readonly string[];
}) =>
  Effect.gen(function* () {
    const op = yield* options.operation;

    return Effect.fn(function* () {
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          yield* host.bind`Allow(${host}, ${options.tag}())`({
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
      return Effect.fn(options.tag)(function* (request?: I) {
        return yield* op((request ?? {}) as I);
      });
    });
  });
