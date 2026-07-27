import * as secretsmanager from "@distilled.cloud/aws/secrets-manager";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `secretsmanager:ListSecrets`.
 *
 * Account-level operation (no target secret): bind it with no arguments to
 * get a callable that lists the account's secrets (metadata only, never
 * values). Provide the implementation with
 * `Effect.provide(AWS.SecretsManager.ListSecretsHttp)`.
 * @binding
 * @section Listing Secrets
 * @example List Secrets by Name
 * ```typescript
 * // init — account-level, no resource argument
 * const listSecrets = yield* AWS.SecretsManager.ListSecrets();
 *
 * // runtime — filter server-side by name
 * const result = yield* listSecrets({
 *   Filters: [{ Key: "name", Values: ["my-app/"] }],
 * });
 * const names = (result.SecretList ?? []).map((entry) => entry.Name);
 * ```
 */
export interface ListSecrets extends Binding.Service<
  ListSecrets,
  "AWS.SecretsManager.ListSecrets",
  () => Effect.Effect<
    (
      request?: secretsmanager.ListSecretsRequest,
    ) => Effect.Effect<
      secretsmanager.ListSecretsResponse,
      secretsmanager.ListSecretsError
    >
  >
> {}

export const ListSecrets = Binding.Service<ListSecrets>(
  "AWS.SecretsManager.ListSecrets",
);
