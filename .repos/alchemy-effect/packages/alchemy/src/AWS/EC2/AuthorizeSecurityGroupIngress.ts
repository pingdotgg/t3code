import type * as ec2 from "@distilled.cloud/aws/ec2";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { SecurityGroup } from "./SecurityGroup.ts";

/**
 * `AuthorizeSecurityGroupIngress` request with `GroupId` injected from the
 * bound {@link SecurityGroup}.
 */
export interface AuthorizeSecurityGroupIngressRequest extends Omit<
  ec2.AuthorizeSecurityGroupIngressRequest,
  "GroupId" | "GroupName"
> {}

/**
 * Runtime binding for the `AuthorizeSecurityGroupIngress` operation scoped to
 * the bound {@link SecurityGroup} (IAM action
 * `ec2:AuthorizeSecurityGroupIngress` on the security group ARN).
 *
 * Adds an inbound rule to the group at runtime — the classic dynamic
 * IP-allowlisting Lambda that opens a port for an operator's current address.
 * Pair with {@link RevokeSecurityGroupIngress} to remove the rule afterwards.
 * Provide the implementation with
 * `Effect.provide(AWS.EC2.AuthorizeSecurityGroupIngressHttp)`.
 * @binding
 * @section Dynamic Security Group Rules
 * @example Allowlist an address for SSH
 * ```typescript
 * // init — bind the operation to the security group
 * const authorizeIngress = yield* AWS.EC2.AuthorizeSecurityGroupIngress(group);
 *
 * // runtime — open port 22 for the caller's address
 * yield* authorizeIngress({
 *   IpProtocol: "tcp",
 *   FromPort: 22,
 *   ToPort: 22,
 *   CidrIp: "203.0.113.7/32",
 * });
 * ```
 */
export interface AuthorizeSecurityGroupIngress extends Binding.Service<
  AuthorizeSecurityGroupIngress,
  "AWS.EC2.AuthorizeSecurityGroupIngress",
  (
    group: SecurityGroup,
  ) => Effect.Effect<
    (
      request: AuthorizeSecurityGroupIngressRequest,
    ) => Effect.Effect<
      ec2.AuthorizeSecurityGroupIngressResult,
      ec2.AuthorizeSecurityGroupIngressError
    >
  >
> {}

export const AuthorizeSecurityGroupIngress =
  Binding.Service<AuthorizeSecurityGroupIngress>(
    "AWS.EC2.AuthorizeSecurityGroupIngress",
  );
