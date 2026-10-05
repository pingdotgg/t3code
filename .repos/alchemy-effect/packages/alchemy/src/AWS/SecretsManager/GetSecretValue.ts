import * as secretsmanager from "@distilled.cloud/aws/secrets-manager";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Secret } from "./Secret.ts";

export interface GetSecretValueRequest extends Omit<
  secretsmanager.GetSecretValueRequest,
  "SecretId"
> {}

/**
 * Runtime binding for `secretsmanager:GetSecretValue`.
 *
 * Bind this operation to a `Secret` in the function's init phase to get a
 * callable that reads the current (or a specific) secret version — the secret
 * ARN is injected automatically and `secretsmanager:GetSecretValue` is
 * granted on the secret. Provide the implementation with
 * `Effect.provide(AWS.SecretsManager.GetSecretValueHttp)`.
 *
 * Secret values are sensitive: `SecretString` / `SecretBinary` may be handed
 * back wrapped in `Redacted` — unwrap with `Redacted.value` before use.
 *
 * AWS lists `secretsmanager:GetSecretValue` as the required permission for
 * retrieving the value; `DescribeSecret` is metadata-only and is not needed.
 * If the secret uses a customer-managed KMS key, the caller additionally
 * needs `kms:Decrypt` for that key. See the [GetSecretValue API](https://docs.aws.amazon.com/secretsmanager/latest/apireference/API_GetSecretValue.html)
 * and [Secrets Manager authorization reference](https://docs.aws.amazon.com/service-authorization/latest/reference/list_secretsmanager.html).
 * ### Reading Secret Values
 * **Example:** Read the Current Secret Value
 * ```typescript
 * // init — bind the operation to the secret
 * const secret = yield* AWS.SecretsManager.Secret("DbPassword", {
 *   secretString: Redacted.make("initial-password"),
 * });
 * const getSecretValue = yield* AWS.SecretsManager.GetSecretValue(secret);
 *
 * // runtime — reads the AWSCURRENT version
 * const result = yield* getSecretValue();
 * const value =
 *   typeof result.SecretString === "string"
 *     ? result.SecretString
 *     : Redacted.value(result.SecretString!);
 * ```
 *
 * @see https://docs.aws.amazon.com/secretsmanager/latest/apireference/API_GetSecretValue.html
 * @see https://docs.aws.amazon.com/service-authorization/latest/reference/list_secretsmanager.html
 *
 * @binding
 */
export interface GetSecretValue extends Binding.Service<
  GetSecretValue,
  "AWS.SecretsManager.GetSecretValue",
  (
    secret: Secret,
  ) => Effect.Effect<
    (
      request?: GetSecretValueRequest,
    ) => Effect.Effect<
      secretsmanager.GetSecretValueResponse,
      secretsmanager.GetSecretValueError
    >
  >
> {}

export const GetSecretValue = Binding.Service<GetSecretValue>(
  "AWS.SecretsManager.GetSecretValue",
);
