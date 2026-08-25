import * as secretsmanager from "@distilled.cloud/aws/secrets-manager";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Secret } from "./Secret.ts";

export interface PutSecretValueRequest extends Omit<
  secretsmanager.PutSecretValueRequest,
  "SecretId"
> {}

/**
 * Runtime binding for `secretsmanager:PutSecretValue`.
 *
 * Bind this operation to a `Secret` to get a callable that writes a new
 * secret version (string or binary); the new version becomes `AWSCURRENT`.
 * Provide the implementation with
 * `Effect.provide(AWS.SecretsManager.PutSecretValueHttp)`.
 * @binding
 * @section Writing Secret Values
 * @example Rotate a Secret's Value
 * ```typescript
 * // init — bind the operation to the secret
 * const putSecretValue = yield* AWS.SecretsManager.PutSecretValue(secret);
 *
 * // runtime — write a new version; the response carries its VersionId
 * const result = yield* putSecretValue({
 *   SecretString: newPassword,
 * });
 * ```
 *
 * @example Store a Binary Payload
 * ```typescript
 * yield* putSecretValue({
 *   SecretBinary: new TextEncoder().encode(JSON.stringify(credentials)),
 * });
 * ```
 */
export interface PutSecretValue extends Binding.Service<
  PutSecretValue,
  "AWS.SecretsManager.PutSecretValue",
  (
    secret: Secret,
  ) => Effect.Effect<
    (
      request: PutSecretValueRequest,
    ) => Effect.Effect<
      secretsmanager.PutSecretValueResponse,
      secretsmanager.PutSecretValueError
    >
  >
> {}

export const PutSecretValue = Binding.Service<PutSecretValue>(
  "AWS.SecretsManager.PutSecretValue",
);
