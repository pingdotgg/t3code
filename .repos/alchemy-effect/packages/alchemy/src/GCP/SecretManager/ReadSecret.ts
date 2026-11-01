import type * as secretmanager from "@distilled.cloud/gcp/secretmanager_v1";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import type { SecretBindingTarget } from "./BindingHttp.ts";

/** Read-only client for one Secret Manager secret. */
export interface ReadSecretClient {
  /**
   * UTF-8 payload of `version` (a version id, `latest`, or a full version
   * name), or `undefined` when that version does not exist — including
   * `latest` on a secret with no versions. `version` defaults to `latest`.
   * A missing, disabled, or destroyed version reads as `undefined`.
   */
  access(
    version?: string,
  ): Effect.Effect<
    string | undefined,
    secretmanager.AccessProjectsSecretsVersionsError,
    RuntimeContext
  >;
  /** Raw payload bytes of `version`; `undefined` like {@link access}. */
  accessBytes(
    version?: string,
  ): Effect.Effect<
    Uint8Array | undefined,
    secretmanager.AccessProjectsSecretsVersionsError,
    RuntimeContext
  >;
}

/**
 * Read access to a Secret Manager {@link Secret} (or regional
 * `LocationsSecret`): `access`, `accessBytes`. Grants
 * `roles/secretmanager.secretAccessor` on the secret only.
 *
 * ### Reading a secret
 * **Example:** Read the latest version
 * ```typescript
 * const apiKey = yield* GCP.SecretManager.ReadSecret(secret);
 * const value = yield* apiKey.access();
 * // …provided with Effect.provide(GCP.SecretManager.ReadSecretHttp)
 * ```
 *
 * **Example:** Pin a version
 * ```typescript
 * const previous = yield* apiKey.access("3");
 * ```
 *
 * @binding
 * @category SecretManager
 */
export interface ReadSecret extends Binding.Service<
  ReadSecret,
  "GCP.SecretManager.ReadSecret",
  (secret: SecretBindingTarget) => Effect.Effect<ReadSecretClient>
> {}

export const ReadSecret = Binding.Service<ReadSecret>(
  "GCP.SecretManager.ReadSecret",
);
