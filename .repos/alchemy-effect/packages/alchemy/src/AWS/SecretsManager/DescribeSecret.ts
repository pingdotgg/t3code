import * as secretsmanager from "@distilled.cloud/aws/secrets-manager";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Secret } from "./Secret.ts";

/**
 * Runtime binding for `secretsmanager:DescribeSecret`.
 *
 * Bind this operation to a `Secret` to get a callable that reads the secret's
 * metadata (name, description, rotation config, version stages) without
 * exposing its value. Provide the implementation with
 * `Effect.provide(AWS.SecretsManager.DescribeSecretHttp)`.
 * @binding
 * @section Inspecting Secrets
 * @example Read a Secret's Metadata
 * ```typescript
 * // init — bind the operation to the secret
 * const describeSecret = yield* AWS.SecretsManager.DescribeSecret(secret);
 *
 * // runtime — metadata only, no secret value in the response
 * const info = yield* describeSecret();
 * const arn = info.ARN;
 * const description = info.Description;
 * ```
 */
export interface DescribeSecret extends Binding.Service<
  DescribeSecret,
  "AWS.SecretsManager.DescribeSecret",
  (
    secret: Secret,
  ) => Effect.Effect<
    () => Effect.Effect<
      secretsmanager.DescribeSecretResponse,
      secretsmanager.DescribeSecretError
    >
  >
> {}

export const DescribeSecret = Binding.Service<DescribeSecret>(
  "AWS.SecretsManager.DescribeSecret",
);
