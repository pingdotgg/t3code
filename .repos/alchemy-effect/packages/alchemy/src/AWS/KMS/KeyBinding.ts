import type { Input } from "../../Input.ts";
import type { PolicyStatement } from "../IAM/Policy.ts";
import type { AliasName } from "./Alias.ts";
import type { Key } from "./Key.ts";

/**
 * The target of a KMS cryptographic binding: either a {@link Key} resource
 * declared in the stack, or the alias name (`alias/...`) of a pre-existing
 * key that is managed outside the stack.
 *
 * When an alias name is given, the runtime request identifies the key by that
 * alias and the IAM policy is scoped with the `kms:RequestAlias` condition
 * key, so the role can only use keys through that exact alias.
 *
 * @internal shared scaffolding for the KMS crypto bindings — not exported
 * from the service index.
 */
export type KeyLike = Key | AliasName;

/**
 * Build the least-privilege IAM policy statement for a KMS crypto operation
 * against a {@link KeyLike} target.
 *
 * - `Key` resource → `Resource` is the exact key ARN.
 * - alias name → `Resource: "*"` constrained by the `kms:RequestAlias`
 *   condition, AWS's documented pattern for alias-scoped access. The runtime
 *   caller must (and does) address the key by that alias.
 *
 * @internal
 */
export const keyPolicyStatement = (
  action: `kms:${string}` | readonly `kms:${string}`[],
  key: KeyLike,
): Input<PolicyStatement> =>
  typeof key === "string"
    ? {
        Effect: "Allow",
        Action: typeof action === "string" ? [action] : [...action],
        Resource: ["*"],
        Condition: { StringEquals: { "kms:RequestAlias": key } },
      }
    : {
        Effect: "Allow",
        Action: typeof action === "string" ? [action] : [...action],
        Resource: [key.keyArn],
      };

/** Stable human-readable label for tracing spans. @internal */
export const keyLabel = (key: KeyLike): string =>
  typeof key === "string" ? key : key.LogicalId;
