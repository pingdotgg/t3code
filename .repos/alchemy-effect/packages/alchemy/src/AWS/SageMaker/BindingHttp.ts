import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import { isBindingHost } from "../Lambda/Function.ts";
import type { Endpoint } from "./Endpoint.ts";
import type { FeatureGroup } from "./FeatureGroup.ts";

/**
 * Shared scaffolding for Amazon SageMaker HTTP bindings.
 *
 * NOT exported from `index.ts` — every thin `{Op}Http.ts` in this service is
 * a `Layer.effect(Cap, make…HttpBinding({ … }))` over one of the two builders
 * below. Everything except the operation, the IAM action list, and the
 * request shaping is boilerplate.
 */

/**
 * Build the impl Effect for a SageMaker Feature Store data-plane operation
 * scoped to a {@link FeatureGroup}: the deploy-time half grants `actions` on
 * the bound feature group's ARN, and the runtime half injects the feature
 * group's name into every request via `prepare`.
 */
export const makeFeatureGroupHttpBinding = <Req, I, A, E, R>(options: {
  /** Fully-qualified binding tag, e.g. `AWS.SageMaker.GetRecord`. */
  tag: string;
  /** The distilled operation. */
  operation: Effect.Effect<(input: I) => Effect.Effect<A, E>, never, R>;
  /** IAM actions granted on the feature group ARN. */
  actions: readonly string[];
  /** Shape the caller's request into the wire request (injecting the name). */
  prepare: (request: Req, featureGroupName: string) => I;
}) =>
  Effect.gen(function* () {
    const op = yield* options.operation;

    return Effect.fn(function* (featureGroup: FeatureGroup) {
      const FeatureGroupName = yield* featureGroup.featureGroupName;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          yield* host.bind`Allow(${host}, ${options.tag}(${featureGroup}))`({
            policyStatements: [
              {
                Effect: "Allow",
                Action: [...options.actions],
                Resource: [featureGroup.featureGroupArn],
              },
            ],
          });
        }
      }
      return Effect.fn(`${options.tag}(${featureGroup.LogicalId})`)(function* (
        request: Req,
      ) {
        const featureGroupName = yield* FeatureGroupName;
        return yield* op(options.prepare(request, featureGroupName));
      });
    });
  });

/**
 * Build the impl Effect for a SageMaker control-plane operation scoped to an
 * {@link Endpoint}: the deploy-time half grants `actions` on the bound
 * endpoint's ARN, and the runtime half injects the endpoint's name into
 * every request.
 */
export const makeEndpointHttpBinding = <
  I extends { EndpointName?: string },
  A,
  E,
  R,
>(options: {
  /** Fully-qualified binding tag, e.g. `AWS.SageMaker.DescribeEndpoint`. */
  tag: string;
  /** The distilled operation. */
  operation: Effect.Effect<(input: I) => Effect.Effect<A, E>, never, R>;
  /** IAM actions granted on the endpoint ARN. */
  actions: readonly string[];
}) =>
  Effect.gen(function* () {
    const op = yield* options.operation;

    return Effect.fn(function* (endpoint: Endpoint) {
      const EndpointName = yield* endpoint.endpointName;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          yield* host.bind`Allow(${host}, ${options.tag}(${endpoint}))`({
            policyStatements: [
              {
                Effect: "Allow",
                Action: [...options.actions],
                Resource: [endpoint.endpointArn],
              },
            ],
          });
        }
      }
      return Effect.fn(`${options.tag}(${endpoint.LogicalId})`)(function* (
        request?: Omit<I, "EndpointName">,
      ) {
        const endpointName = yield* EndpointName;
        return yield* op({ ...request, EndpointName: endpointName } as I);
      });
    });
  });
