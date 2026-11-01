import type * as secretmanager from "@distilled.cloud/gcp/secretmanager_v1";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import type { LocationsSecret } from "./LocationsSecret.ts";
import type { Secret } from "./Secret.ts";

export interface AddSecretVersionRequest {
  /**
   * Secret payload. `data` is the standard-base64 encoding of at most
   * 64KiB of bytes.
   */
  payload: secretmanager.SecretPayload;
}

/**
 * Runtime binding for Secret Manager `secrets.addVersion`.
 *
 * Bind this operation to a {@link Secret} or {@link LocationsSecret} in a
 * Function/Action init phase.
 * Provide {@link AddSecretVersionHttp}.
 *
 * ### Adding Secret Versions
 * **Example:** Add a version
 * ```typescript
 * const addVersion = yield* GCP.SecretManager.AddSecretVersion(secret);
 * yield* addVersion({ payload: { data: btoa("hello") } });
 * ```
 *
 * @binding
 * @category SecretManager
 */
export interface AddSecretVersion extends Binding.Service<
  AddSecretVersion,
  "GCP.SecretManager.AddSecretVersion",
  (
    secret: Secret | LocationsSecret,
  ) => Effect.Effect<
    (
      request: AddSecretVersionRequest,
    ) => Effect.Effect<
      secretmanager.SecretVersion,
      secretmanager.AddVersionProjectsSecretsError,
      RuntimeContext
    >
  >
> {}

export const AddSecretVersion = Binding.Service<AddSecretVersion>(
  "GCP.SecretManager.AddSecretVersion",
);
