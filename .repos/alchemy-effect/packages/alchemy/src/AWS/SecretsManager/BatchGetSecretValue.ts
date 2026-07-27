import * as secretsmanager from "@distilled.cloud/aws/secrets-manager";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Secret } from "./Secret.ts";

export interface BatchGetSecretValueRequest extends Omit<
  secretsmanager.BatchGetSecretValueRequest,
  "SecretIdList" | "Filters"
> {}

/**
 * Runtime binding for `secretsmanager:BatchGetSecretValue`.
 *
 * Bind this operation to a list of `Secret`s to get a callable that reads
 * all of their current values in a single call — the batch counterpart of
 * `GetSecretValue`. The bound secrets' ARNs are injected as the
 * `SecretIdList` and each secret is granted `secretsmanager:GetSecretValue`
 * (BatchGetSecretValue authorizes per-secret through GetSecretValue).
 * Provide the implementation with
 * `Effect.provide(AWS.SecretsManager.BatchGetSecretValueHttp)`.
 * @binding
 * @section Reading Secret Values
 * @example Read Several Secrets at Once
 * ```typescript
 * // init — bind the operation to the secrets
 * const batchGet = yield* AWS.SecretsManager.BatchGetSecretValue([
 *   dbSecret,
 *   apiKeySecret,
 * ]);
 *
 * // runtime — one call, every current value
 * const result = yield* batchGet();
 * for (const entry of result.SecretValues ?? []) {
 *   console.log(entry.Name);
 * }
 * ```
 */
export interface BatchGetSecretValue extends Binding.Service<
  BatchGetSecretValue,
  "AWS.SecretsManager.BatchGetSecretValue",
  (
    secrets: readonly Secret[],
  ) => Effect.Effect<
    (
      request?: BatchGetSecretValueRequest,
    ) => Effect.Effect<
      secretsmanager.BatchGetSecretValueResponse,
      secretsmanager.BatchGetSecretValueError
    >
  >
> {}

export const BatchGetSecretValue = Binding.Service<BatchGetSecretValue>(
  "AWS.SecretsManager.BatchGetSecretValue",
);
