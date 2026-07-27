import type * as ec2 from "@distilled.cloud/aws/ec2";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { SecurityGroup } from "./SecurityGroup.ts";

/**
 * `RevokeSecurityGroupIngress` request with `GroupId` injected from the bound
 * {@link SecurityGroup}.
 */
export interface RevokeSecurityGroupIngressRequest extends Omit<
  ec2.RevokeSecurityGroupIngressRequest,
  "GroupId" | "GroupName"
> {}

/**
 * Runtime binding for the `RevokeSecurityGroupIngress` operation scoped to
 * the bound {@link SecurityGroup} (IAM action
 * `ec2:RevokeSecurityGroupIngress` on the security group ARN).
 *
 * Removes an inbound rule from the group at runtime — the cleanup half of the
 * dynamic IP-allowlisting pattern (see
 * {@link AuthorizeSecurityGroupIngress}). Provide the implementation with
 * `Effect.provide(AWS.EC2.RevokeSecurityGroupIngressHttp)`.
 * @binding
 * @section Dynamic Security Group Rules
 * @example Remove a previously allowlisted address
 * ```typescript
 * // init — bind the operation to the security group
 * const revokeIngress = yield* AWS.EC2.RevokeSecurityGroupIngress(group);
 *
 * // runtime — close port 22 for the address again
 * yield* revokeIngress({
 *   IpProtocol: "tcp",
 *   FromPort: 22,
 *   ToPort: 22,
 *   CidrIp: "203.0.113.7/32",
 * });
 * ```
 */
export interface RevokeSecurityGroupIngress extends Binding.Service<
  RevokeSecurityGroupIngress,
  "AWS.EC2.RevokeSecurityGroupIngress",
  (
    group: SecurityGroup,
  ) => Effect.Effect<
    (
      request: RevokeSecurityGroupIngressRequest,
    ) => Effect.Effect<
      ec2.RevokeSecurityGroupIngressResult,
      ec2.RevokeSecurityGroupIngressError
    >
  >
> {}

export const RevokeSecurityGroupIngress =
  Binding.Service<RevokeSecurityGroupIngress>(
    "AWS.EC2.RevokeSecurityGroupIngress",
  );
