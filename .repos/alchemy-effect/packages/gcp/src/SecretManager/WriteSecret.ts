import type * as secretmanager from "@distilled.cloud/gcp/secretmanager_v1";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { SecretBindingTarget } from "./BindingHttp.ts";

/** Version-management client for one Secret Manager secret. */
export interface WriteSecretClient {
  /** Add a new version and return its full resource name. */
  addVersion(
    value: string | Uint8Array,
  ): Effect.Effect<string, secretmanager.AddVersionProjectsSecretsError, RuntimeContext>;
  /** Disable a version (a version id or full version name). */
  disableVersion(
    version: string,
  ): Effect.Effect<void, secretmanager.DisableProjectsSecretsVersionsError, RuntimeContext>;
  /**
   * Irrevocably destroy a version's data. Destroying a missing version
   * succeeds.
   */
  destroyVersion(
    version: string,
  ): Effect.Effect<void, secretmanager.DestroyProjectsSecretsVersionsError, RuntimeContext>;
}

/**
 * Write access to a Secret Manager {@link Secret} (or regional
 * `LocationsSecret`): `addVersion`, `disableVersion`, `destroyVersion`.
 * Grants `roles/secretmanager.secretVersionManager` on the secret only
 * (`secretVersionAdder` cannot disable or destroy). It cannot read payloads.
 *
 * ### Rotating a secret
 * **Example:** Add a version and destroy the previous one
 * ```typescript
 * const apiKey = yield* GCP.SecretManager.WriteSecret(secret);
 * const version = yield* apiKey.addVersion(newKey);
 * yield* apiKey.destroyVersion(previousVersion);
 * // …provided with Effect.provide(GCP.SecretManager.WriteSecretHttp)
 * ```
 *
 * @binding
 * @category SecretManager
 */
export interface WriteSecret extends Binding.Service<
  WriteSecret,
  "GCP.SecretManager.WriteSecret",
  (secret: SecretBindingTarget) => Effect.Effect<WriteSecretClient>
> {}

export const WriteSecret = Binding.Service<WriteSecret>("GCP.SecretManager.WriteSecret");
