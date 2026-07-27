import type * as appconfig from "@distilled.cloud/aws/appconfig";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Application } from "./Application.ts";
import type { ConfigurationProfile } from "./ConfigurationProfile.ts";

export interface CreateHostedConfigurationVersionRequest extends Omit<
  appconfig.CreateHostedConfigurationVersionRequest,
  "ApplicationId" | "ConfigurationProfileId"
> {}

/**
 * Write a new configuration version to the AppConfig hosted store from a
 * Lambda (or other AWS runtime). Pairs with {@link StartDeployment} to build
 * runtime feature-flag/configuration management services: write the new
 * content, then roll it out.
 *
 * Provide `AppConfig.CreateHostedConfigurationVersionHttp` on the hosting
 * function's Effect to implement the binding.
 *
 * @binding
 * @section Writing Configuration at Runtime
 * @example Store a new configuration version
 * ```typescript
 * const createVersion = yield* AppConfig.CreateHostedConfigurationVersion(
 *   app,
 *   profile,
 * );
 * const version = yield* createVersion({
 *   Content: JSON.stringify({ featureX: false }),
 *   ContentType: "application/json",
 * });
 * // version.VersionNumber -> 2
 * ```
 */
export interface CreateHostedConfigurationVersion extends Binding.Service<
  CreateHostedConfigurationVersion,
  "AWS.AppConfig.CreateHostedConfigurationVersion",
  (
    application: Application,
    configurationProfile: ConfigurationProfile,
  ) => Effect.Effect<
    (
      request: CreateHostedConfigurationVersionRequest,
    ) => Effect.Effect<
      appconfig.HostedConfigurationVersion,
      appconfig.CreateHostedConfigurationVersionError
    >
  >
> {}
export const CreateHostedConfigurationVersion =
  Binding.Service<CreateHostedConfigurationVersion>(
    "AWS.AppConfig.CreateHostedConfigurationVersion",
  );
