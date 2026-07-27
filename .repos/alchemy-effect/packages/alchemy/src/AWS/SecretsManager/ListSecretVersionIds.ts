import * as secretsmanager from "@distilled.cloud/aws/secrets-manager";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Secret } from "./Secret.ts";

export interface ListSecretVersionIdsRequest extends Omit<
  secretsmanager.ListSecretVersionIdsRequest,
  "SecretId"
> {}

/**
 * Runtime binding for `secretsmanager:ListSecretVersionIds`.
 *
 * Bind this operation to a `Secret` to get a callable that lists the
 * secret's version IDs and their staging labels (`AWSCURRENT`,
 * `AWSPENDING`, `AWSPREVIOUS`) — useful for rotation functions and audit
 * tooling. Provide the implementation with
 * `Effect.provide(AWS.SecretsManager.ListSecretVersionIdsHttp)`.
 * @binding
 * @section Inspecting Secrets
 * @example List a Secret's Versions
 * ```typescript
 * // init — bind the operation to the secret
 * const listVersions = yield* AWS.SecretsManager.ListSecretVersionIds(secret);
 *
 * // runtime — every version with its staging labels
 * const result = yield* listVersions({ IncludeDeprecated: true });
 * const current = (result.Versions ?? []).find((version) =>
 *   version.VersionStages?.includes("AWSCURRENT"),
 * );
 * ```
 */
export interface ListSecretVersionIds extends Binding.Service<
  ListSecretVersionIds,
  "AWS.SecretsManager.ListSecretVersionIds",
  (
    secret: Secret,
  ) => Effect.Effect<
    (
      request?: ListSecretVersionIdsRequest,
    ) => Effect.Effect<
      secretsmanager.ListSecretVersionIdsResponse,
      secretsmanager.ListSecretVersionIdsError
    >
  >
> {}

export const ListSecretVersionIds = Binding.Service<ListSecretVersionIds>(
  "AWS.SecretsManager.ListSecretVersionIds",
);
