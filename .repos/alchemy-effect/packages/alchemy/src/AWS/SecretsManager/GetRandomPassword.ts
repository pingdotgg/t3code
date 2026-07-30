import * as secretsmanager from "@distilled.cloud/aws/secrets-manager";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `secretsmanager:GetRandomPassword`.
 *
 * Account-level operation (no target secret): bind it with no arguments to
 * get a callable that generates cryptographically strong random passwords —
 * typically paired with `PutSecretValue` for rotation. Provide the
 * implementation with
 * `Effect.provide(AWS.SecretsManager.GetRandomPasswordHttp)`.
 * @binding
 * @section Generating Passwords
 * @example Generate and Store a New Password
 * ```typescript
 * // init — account-level, no resource argument
 * const getRandomPassword = yield* AWS.SecretsManager.GetRandomPassword();
 * const putSecretValue = yield* AWS.SecretsManager.PutSecretValue(secret);
 *
 * // runtime — generate, then rotate the secret to it
 * const generated = yield* getRandomPassword({
 *   PasswordLength: 32,
 *   ExcludePunctuation: true,
 * });
 * yield* putSecretValue({ SecretString: generated.RandomPassword });
 * ```
 */
export interface GetRandomPassword extends Binding.Service<
  GetRandomPassword,
  "AWS.SecretsManager.GetRandomPassword",
  () => Effect.Effect<
    (
      request?: secretsmanager.GetRandomPasswordRequest,
    ) => Effect.Effect<
      secretsmanager.GetRandomPasswordResponse,
      secretsmanager.GetRandomPasswordError
    >
  >
> {}

export const GetRandomPassword = Binding.Service<GetRandomPassword>(
  "AWS.SecretsManager.GetRandomPassword",
);
