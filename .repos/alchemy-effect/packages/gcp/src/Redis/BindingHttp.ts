import { makeNamedHttpBinding, type BindingIam, type GcpHttpOp } from "../HttpBinding.ts";
import type { AclPolicy } from "./AclPolicy.ts";
import type { Instance } from "./Instance.ts";

/**
 * Shared HTTP scaffolding for Memorystore Redis ACL policy bindings.
 * NOT exported from index.ts.
 */
export const makeRedisHttpBinding = <I extends { name?: string }, A, E>(options: {
  tag: string;
  operation: GcpHttpOp<I, A, E>;
}) =>
  // Memorystore has no resource-level IAM; viewer under an IAM Condition on
  // the policy name covers reads.
  makeNamedHttpBinding<AclPolicy, I, A, E>({
    tag: options.tag,
    operation: options.operation,
    iam: { role: "roles/redis.viewer", scopeByCondition: true },
    resourceName: (policy) => policy.name,
  });

/**
 * Shared HTTP scaffolding for Memorystore Redis instance bindings.
 * NOT exported from index.ts.
 */
export const makeRedisInstanceHttpBinding = <I extends { name?: string }, A, E>(options: {
  tag: string;
  iam: BindingIam;
  operation: GcpHttpOp<I, A, E>;
}) =>
  makeNamedHttpBinding<Instance, I, A, E>({
    tag: options.tag,
    operation: options.operation,
    iam: options.iam,
    resourceName: (instance) => instance.name,
  });
