import type * as appconfig from "@distilled.cloud/aws/appconfig";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Application } from "./Application.ts";
import type { ConfigurationProfile } from "./ConfigurationProfile.ts";

export interface ValidateConfigurationRequest extends Omit<
  appconfig.ValidateConfigurationRequest,
  "ApplicationId" | "ConfigurationProfileId"
> {}

/**
 * Validate a configuration version against a configuration profile's
 * validators from a Lambda (or other AWS runtime). Pairs with
 * {@link CreateHostedConfigurationVersion} + {@link StartDeployment}: write
 * the new content, validate it, then roll it out. Fails with a typed
 * `BadRequestException` when a validator rejects the content; succeeds with
 * an empty response when validation passes (including when the profile has
 * no validators).
 *
 * Provide `AppConfig.ValidateConfigurationHttp` on the hosting function's
 * Effect to implement the binding.
 *
 * @binding
 * @section Writing Configuration at Runtime
 * @example Validate a version before deploying it
 * ```typescript
 * const validate = yield* AppConfig.ValidateConfiguration(app, profile);
 * yield* validate({ ConfigurationVersion: "2" });
 * ```
 */
export interface ValidateConfiguration extends Binding.Service<
  ValidateConfiguration,
  "AWS.AppConfig.ValidateConfiguration",
  (
    application: Application,
    configurationProfile: ConfigurationProfile,
  ) => Effect.Effect<
    (
      request: ValidateConfigurationRequest,
    ) => Effect.Effect<
      appconfig.ValidateConfigurationResponse,
      appconfig.ValidateConfigurationError
    >
  >
> {}
export const ValidateConfiguration = Binding.Service<ValidateConfiguration>(
  "AWS.AppConfig.ValidateConfiguration",
);
