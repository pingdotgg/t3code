import * as secretsmanager from "@distilled.cloud/aws/secrets-manager";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Secret } from "./Secret.ts";

export interface RotateSecretRequest extends Omit<
  secretsmanager.RotateSecretRequest,
  "SecretId"
> {}

/**
 * Runtime binding for `secretsmanager:RotateSecret`.
 *
 * Bind this operation to a `Secret` to get a callable that triggers an
 * immediate rotation using the secret's configured rotation function (see
 * {@link onSecretRotation} for wiring one up). Provide the implementation
 * with `Effect.provide(AWS.SecretsManager.RotateSecretHttp)`.
 * @binding
 * @section Rotating Secrets
 * @example Trigger an On-Demand Rotation
 * ```typescript
 * // init — bind the operation to the secret
 * const rotateSecret = yield* AWS.SecretsManager.RotateSecret(secret);
 *
 * // runtime — kicks off the configured rotation function
 * const result = yield* rotateSecret();
 * const pendingVersionId = result.VersionId;
 * ```
 */
export interface RotateSecret extends Binding.Service<
  RotateSecret,
  "AWS.SecretsManager.RotateSecret",
  (
    secret: Secret,
  ) => Effect.Effect<
    (
      request?: RotateSecretRequest,
    ) => Effect.Effect<
      secretsmanager.RotateSecretResponse,
      secretsmanager.RotateSecretError
    >
  >
> {}

export const RotateSecret = Binding.Service<RotateSecret>(
  "AWS.SecretsManager.RotateSecret",
);
