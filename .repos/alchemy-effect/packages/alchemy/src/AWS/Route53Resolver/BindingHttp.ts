import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import { isBindingHost } from "../Lambda/Function.ts";
import type { ResolverEndpoint } from "./ResolverEndpoint.ts";
import type { ResolverRule } from "./ResolverRule.ts";

/**
 * Shared scaffolding for AWS Route 53 Resolver HTTP bindings.
 *
 * NOT exported from `index.ts` — every `{Op}Http.ts` in this service is a
 * thin `Layer.effect(Cap, make…HttpBinding({ … }))` over one of the two
 * builders below. Everything except the operation and the IAM action is
 * boilerplate:
 *
 * - {@link makeRoute53ResolverEndpointHttpBinding} — operations scoped to one
 *   bound {@link ResolverEndpoint}. The runtime callable injects the
 *   endpoint's ID as the request's `ResolverEndpointId`; the deploy-time half
 *   grants `actions` on the endpoint ARN.
 * - {@link makeRoute53ResolverRuleHttpBinding} — operations scoped to one
 *   bound {@link ResolverRule}; injects `ResolverRuleId` and grants `actions`
 *   on the rule ARN.
 */

/**
 * Build the impl Effect for an operation scoped to a single bound
 * {@link ResolverEndpoint}. The runtime callable injects the endpoint's ID as
 * the request's `ResolverEndpointId`; the deploy-time half grants `actions`
 * on the endpoint ARN.
 */
export const makeRoute53ResolverEndpointHttpBinding = <
  I extends { ResolverEndpointId?: string },
  A,
  E,
  R,
>(options: {
  /** Fully-qualified binding tag, e.g. `AWS.Route53Resolver.GetResolverEndpoint`. */
  tag: string;
  /** The distilled operation; `ResolverEndpointId` is injected from the resource. */
  operation: Effect.Effect<(input: I) => Effect.Effect<A, E>, never, R>;
  /** IAM actions granted on the resolver endpoint ARN. */
  actions: readonly string[];
}) =>
  Effect.gen(function* () {
    const op = yield* options.operation;

    return Effect.fn(function* (endpoint: ResolverEndpoint) {
      const ResolverEndpointId = yield* endpoint.resolverEndpointId;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          yield* host.bind`Allow(${host}, ${options.tag}(${endpoint}))`({
            policyStatements: [
              {
                Effect: "Allow",
                Action: [...options.actions],
                Resource: [endpoint.resolverEndpointArn],
              },
            ],
          });
        }
      }
      return Effect.fn(`${options.tag}(${endpoint.LogicalId})`)(function* (
        request?: Omit<I, "ResolverEndpointId">,
      ) {
        return yield* op({
          ...request,
          ResolverEndpointId: yield* ResolverEndpointId,
        } as I);
      });
    });
  });

/**
 * Build the impl Effect for an operation scoped to a single bound
 * {@link ResolverRule}. The runtime callable injects the rule's ID as the
 * request's `ResolverRuleId`; the deploy-time half grants `actions` on the
 * rule ARN.
 */
export const makeRoute53ResolverRuleHttpBinding = <
  I extends { ResolverRuleId?: string },
  A,
  E,
  R,
>(options: {
  /** Fully-qualified binding tag, e.g. `AWS.Route53Resolver.GetResolverRule`. */
  tag: string;
  /** The distilled operation; `ResolverRuleId` is injected from the resource. */
  operation: Effect.Effect<(input: I) => Effect.Effect<A, E>, never, R>;
  /** IAM actions granted on the resolver rule ARN. */
  actions: readonly string[];
}) =>
  Effect.gen(function* () {
    const op = yield* options.operation;

    return Effect.fn(function* (rule: ResolverRule) {
      const ResolverRuleId = yield* rule.resolverRuleId;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          yield* host.bind`Allow(${host}, ${options.tag}(${rule}))`({
            policyStatements: [
              {
                Effect: "Allow",
                Action: [...options.actions],
                Resource: [rule.resolverRuleArn],
              },
            ],
          });
        }
      }
      return Effect.fn(`${options.tag}(${rule.LogicalId})`)(function* (
        request?: Omit<I, "ResolverRuleId">,
      ) {
        return yield* op({
          ...request,
          ResolverRuleId: yield* ResolverRuleId,
        } as I);
      });
    });
  });
