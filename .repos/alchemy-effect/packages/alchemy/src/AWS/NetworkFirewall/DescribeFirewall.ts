import type * as NFW from "@distilled.cloud/aws/network-firewall";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Firewall } from "./Firewall.ts";

export interface DescribeFirewallRequest extends Omit<
  NFW.DescribeFirewallRequest,
  "FirewallArn" | "FirewallName"
> {}

/**
 * Runtime binding for `network-firewall:DescribeFirewall` — read the bound
 * {@link Firewall}'s configuration and status (sync states, endpoint ids,
 * capacity usage); the firewall ARN is injected automatically.
 *
 * Provide `NetworkFirewall.DescribeFirewallHttp` on the hosting Lambda
 * Function to satisfy the requirement.
 * @binding
 * @section Reading Firewall State
 * @example Read the Firewall Status
 * ```typescript
 * // init — grants network-firewall:DescribeFirewall on the firewall
 * const describeFirewall = yield* AWS.NetworkFirewall.DescribeFirewall(firewall);
 *
 * // runtime
 * const { FirewallStatus } = yield* describeFirewall();
 * ```
 */
export interface DescribeFirewall extends Binding.Service<
  DescribeFirewall,
  "AWS.NetworkFirewall.DescribeFirewall",
  (
    firewall: Firewall,
  ) => Effect.Effect<
    (
      request?: DescribeFirewallRequest,
    ) => Effect.Effect<NFW.DescribeFirewallResponse, NFW.DescribeFirewallError>
  >
> {}

export const DescribeFirewall = Binding.Service<DescribeFirewall>(
  "AWS.NetworkFirewall.DescribeFirewall",
);
