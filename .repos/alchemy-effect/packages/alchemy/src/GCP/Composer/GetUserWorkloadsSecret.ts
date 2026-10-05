import type * as composer from "@distilled.cloud/gcp/composer_v1";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import type { EnvironmentsUserWorkloadsSecret } from "./EnvironmentsUserWorkloadsSecret.ts";

export interface GetUserWorkloadsSecretRequest extends Omit<
  composer.GetProjectsLocationsEnvironmentsUserWorkloadsSecretsRequest,
  "name"
> {}

/**
 * Runtime binding for Cloud Composer `userWorkloadsSecrets.get`.
 *
 * Bind this operation to an {@link EnvironmentsUserWorkloadsSecret} in a
 * Function/Action init phase. Provide {@link GetUserWorkloadsSecretHttp}.
 * Data values in the response are cleared by the API.
 *
 * ### Observing Secrets
 * **Example:** Read the bound Secret
 * ```typescript
 * const getSecret = yield* GCP.Composer.GetUserWorkloadsSecret(secret);
 * const live = yield* getSecret();
 * ```
 *
 * @binding
 * @category Composer
 */
export interface GetUserWorkloadsSecret extends Binding.Service<
  GetUserWorkloadsSecret,
  "GCP.Composer.GetUserWorkloadsSecret",
  (
    secret: EnvironmentsUserWorkloadsSecret,
  ) => Effect.Effect<
    (
      request?: GetUserWorkloadsSecretRequest,
    ) => Effect.Effect<
      composer.UserWorkloadsSecret,
      composer.GetProjectsLocationsEnvironmentsUserWorkloadsSecretsError,
      RuntimeContext
    >
  >
> {}

export const GetUserWorkloadsSecret = Binding.Service<GetUserWorkloadsSecret>(
  "GCP.Composer.GetUserWorkloadsSecret",
);
