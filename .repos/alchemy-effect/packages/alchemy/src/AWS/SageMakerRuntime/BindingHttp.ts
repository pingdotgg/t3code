import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import { AWSEnvironment } from "../Environment.ts";
import { isBindingHost } from "../Lambda/Function.ts";

/**
 * Shared scaffolding for AWS SageMaker Runtime HTTP bindings.
 *
 * NOT exported from `index.ts` — every `{Op}Http.ts` in this service is a
 * thin `Layer.effect(Cap, makeEndpointInvocationHttpBinding({ … }))` over the
 * builder below. Everything except the operation and the IAM action list is
 * boilerplate: SageMaker Runtime is a pure data-plane API whose three
 * invocation operations all take one or more endpoint names, inject
 * `EndpointName` into the request, and authorize against the endpoint ARNs.
 */

const currentEnv = AWSEnvironment.current as unknown as Effect.Effect<{
  accountId: string;
  region: string;
}>;

/**
 * Build the impl Effect for an endpoint-invocation operation
 * (`InvokeEndpoint`, `InvokeEndpointAsync`,
 * `InvokeEndpointWithResponseStream`). The binding accepts one or more
 * endpoint names, grants `actions` on exactly those endpoint ARNs, and the
 * runtime callable defaults `EndpointName` to the first bound endpoint (it
 * may be overridden per call with any of the bound names).
 */
export const makeEndpointInvocationHttpBinding = <
  I extends { EndpointName: string },
  A,
  E,
  R,
>(options: {
  /** Fully-qualified binding tag, e.g. `AWS.SageMakerRuntime.InvokeEndpoint`. */
  tag: string;
  /** The distilled operation; `EndpointName` defaults to the first bound endpoint. */
  operation: Effect.Effect<(input: I) => Effect.Effect<A, E>, never, R>;
  /** IAM actions granted on the bound endpoint ARNs. */
  actions: readonly string[];
}) =>
  Effect.gen(function* () {
    const op = yield* options.operation;

    return Effect.fn(function* (
      endpoint: string,
      ...additionalEndpoints: string[]
    ) {
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          const { accountId, region } = yield* currentEnv;
          // Sort so the binding identity (SID + ARN list) is deterministic
          // regardless of argument order.
          const sorted = [
            ...new Set([endpoint, ...additionalEndpoints]),
          ].sort();
          yield* host.bind`Allow(${host}, ${options.tag}(${sorted.join(",")}))`(
            {
              policyStatements: [
                {
                  Effect: "Allow",
                  Action: [...options.actions],
                  Resource: sorted.map(
                    (name) =>
                      `arn:aws:sagemaker:${region}:${accountId}:endpoint/${name}`,
                  ),
                },
              ],
            },
          );
        }
      }
      return Effect.fn(`${options.tag}(${endpoint})`)(function* (
        request: Omit<I, "EndpointName"> & { EndpointName?: string },
      ) {
        return yield* op({
          ...request,
          EndpointName: request.EndpointName ?? endpoint,
        } as unknown as I);
      });
    });
  });
