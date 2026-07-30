import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import { isBindingHost } from "../Lambda/Function.ts";
import type { Firewall } from "./Firewall.ts";
import type { FirewallPolicy } from "./FirewallPolicy.ts";
import type { RuleGroup } from "./RuleGroup.ts";

/**
 * Shared scaffolding for AWS Network Firewall HTTP bindings.
 *
 * NOT exported from `index.ts` — every `{Op}Http.ts` in this service is a
 * thin `Layer.effect(Cap, make…HttpBinding({ … }))` over one of the three
 * builders below. Everything except the operation and the IAM action is
 * boilerplate:
 *
 * - {@link makeNetworkFirewallFirewallHttpBinding} — operations scoped to one
 *   bound {@link Firewall} (`DescribeFirewall`, the flow-operation interface,
 *   the analysis-report interface). The runtime callable injects the
 *   firewall's ARN as the request's `FirewallArn`; the deploy-time half
 *   grants `actions` on the firewall ARN.
 * - {@link makeNetworkFirewallFirewallPolicyHttpBinding} — operations scoped
 *   to one bound {@link FirewallPolicy}; injects `FirewallPolicyArn`.
 * - {@link makeNetworkFirewallRuleGroupHttpBinding} — operations scoped to
 *   one bound {@link RuleGroup}; injects `RuleGroupArn`.
 */

/**
 * Build the impl Effect for an operation scoped to a single bound
 * {@link Firewall}. The runtime callable injects the firewall's ARN as the
 * request's `FirewallArn`; the deploy-time half grants `actions` on the
 * firewall ARN.
 */
export const makeNetworkFirewallFirewallHttpBinding = <
  I extends { FirewallArn?: string },
  A,
  E,
  R,
>(options: {
  /** Fully-qualified binding tag, e.g. `AWS.NetworkFirewall.StartFlowCapture`. */
  tag: string;
  /** The distilled operation; `FirewallArn` is injected from the resource. */
  operation: Effect.Effect<(input: I) => Effect.Effect<A, E>, never, R>;
  /** IAM actions granted on the firewall ARN. */
  actions: readonly string[];
}) =>
  Effect.gen(function* () {
    const op = yield* options.operation;

    return Effect.fn(function* (firewall: Firewall) {
      const FirewallArn = yield* firewall.firewallArn;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          yield* host.bind`Allow(${host}, ${options.tag}(${firewall}))`({
            policyStatements: [
              {
                Effect: "Allow",
                Action: [...options.actions],
                Resource: [firewall.firewallArn],
              },
            ],
          });
        }
      }
      return Effect.fn(`${options.tag}(${firewall.LogicalId})`)(function* (
        request?: Omit<I, "FirewallArn" | "FirewallName">,
      ) {
        return yield* op({
          ...request,
          FirewallArn: yield* FirewallArn,
        } as I);
      });
    });
  });

/**
 * Build the impl Effect for an operation scoped to a single bound
 * {@link FirewallPolicy}. The runtime callable injects the policy's ARN as
 * the request's `FirewallPolicyArn`; the deploy-time half grants `actions`
 * on the policy ARN.
 */
export const makeNetworkFirewallFirewallPolicyHttpBinding = <
  I extends { FirewallPolicyArn?: string },
  A,
  E,
  R,
>(options: {
  /** Fully-qualified binding tag, e.g. `AWS.NetworkFirewall.DescribeFirewallPolicy`. */
  tag: string;
  /** The distilled operation; `FirewallPolicyArn` is injected from the resource. */
  operation: Effect.Effect<(input: I) => Effect.Effect<A, E>, never, R>;
  /** IAM actions granted on the firewall policy ARN. */
  actions: readonly string[];
}) =>
  Effect.gen(function* () {
    const op = yield* options.operation;

    return Effect.fn(function* (policy: FirewallPolicy) {
      const FirewallPolicyArn = yield* policy.firewallPolicyArn;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          yield* host.bind`Allow(${host}, ${options.tag}(${policy}))`({
            policyStatements: [
              {
                Effect: "Allow",
                Action: [...options.actions],
                Resource: [policy.firewallPolicyArn],
              },
            ],
          });
        }
      }
      return Effect.fn(`${options.tag}(${policy.LogicalId})`)(function* (
        request?: Omit<I, "FirewallPolicyArn" | "FirewallPolicyName">,
      ) {
        return yield* op({
          ...request,
          FirewallPolicyArn: yield* FirewallPolicyArn,
        } as I);
      });
    });
  });

/**
 * Build the impl Effect for an operation scoped to a single bound
 * {@link RuleGroup}. The runtime callable injects the rule group's ARN as
 * the request's `RuleGroupArn`; the deploy-time half grants `actions` on the
 * rule group ARN.
 */
export const makeNetworkFirewallRuleGroupHttpBinding = <
  I extends { RuleGroupArn?: string },
  A,
  E,
  R,
>(options: {
  /** Fully-qualified binding tag, e.g. `AWS.NetworkFirewall.DescribeRuleGroup`. */
  tag: string;
  /** The distilled operation; `RuleGroupArn` is injected from the resource. */
  operation: Effect.Effect<(input: I) => Effect.Effect<A, E>, never, R>;
  /** IAM actions granted on the rule group ARN. */
  actions: readonly string[];
}) =>
  Effect.gen(function* () {
    const op = yield* options.operation;

    return Effect.fn(function* (ruleGroup: RuleGroup) {
      const RuleGroupArn = yield* ruleGroup.ruleGroupArn;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          yield* host.bind`Allow(${host}, ${options.tag}(${ruleGroup}))`({
            policyStatements: [
              {
                Effect: "Allow",
                Action: [...options.actions],
                Resource: [ruleGroup.ruleGroupArn],
              },
            ],
          });
        }
      }
      return Effect.fn(`${options.tag}(${ruleGroup.LogicalId})`)(function* (
        request?: Omit<I, "RuleGroupArn" | "RuleGroupName" | "Type">,
      ) {
        return yield* op({
          ...request,
          RuleGroupArn: yield* RuleGroupArn,
        } as I);
      });
    });
  });
