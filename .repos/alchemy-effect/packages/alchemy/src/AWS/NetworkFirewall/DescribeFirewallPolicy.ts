import type * as NFW from "@distilled.cloud/aws/network-firewall";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { FirewallPolicy } from "./FirewallPolicy.ts";

export interface DescribeFirewallPolicyRequest extends Omit<
  NFW.DescribeFirewallPolicyRequest,
  "FirewallPolicyArn" | "FirewallPolicyName"
> {}

/**
 * Runtime binding for `network-firewall:DescribeFirewallPolicy` — read the
 * bound {@link FirewallPolicy}'s definition (rule group references, default
 * actions, engine options); the policy ARN is injected automatically.
 *
 * Provide `NetworkFirewall.DescribeFirewallPolicyHttp` on the hosting Lambda
 * Function to satisfy the requirement.
 * @binding
 * @section Reading Policy State
 * @example Read the Policy Definition
 * ```typescript
 * // init — grants network-firewall:DescribeFirewallPolicy on the policy
 * const describeFirewallPolicy =
 *   yield* AWS.NetworkFirewall.DescribeFirewallPolicy(policy);
 *
 * // runtime
 * const { FirewallPolicy } = yield* describeFirewallPolicy();
 * ```
 */
export interface DescribeFirewallPolicy extends Binding.Service<
  DescribeFirewallPolicy,
  "AWS.NetworkFirewall.DescribeFirewallPolicy",
  (
    policy: FirewallPolicy,
  ) => Effect.Effect<
    (
      request?: DescribeFirewallPolicyRequest,
    ) => Effect.Effect<
      NFW.DescribeFirewallPolicyResponse,
      NFW.DescribeFirewallPolicyError
    >
  >
> {}

export const DescribeFirewallPolicy = Binding.Service<DescribeFirewallPolicy>(
  "AWS.NetworkFirewall.DescribeFirewallPolicy",
);
