import type * as appconfigdata from "@distilled.cloud/aws/appconfigdata";
import type * as Duration from "effect/Duration";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Application } from "./Application.ts";
import type { ConfigurationProfile } from "./ConfigurationProfile.ts";
import type { Environment } from "./Environment.ts";

/**
 * Options for a {@link GetConfiguration} binding.
 */
export interface GetConfigurationOptions {
  /**
   * The minimum interval the configuration session enforces between polls
   * (e.g. `"30 seconds"` or `Duration.seconds(30)`; a bare number is
   * milliseconds). Sent to AppConfig as whole seconds. If omitted, AppConfig
   * uses the session default (60 seconds).
   */
  requiredMinimumPollInterval?: Duration.Input;
}

/**
 * The configuration returned by a {@link GetConfiguration} poll.
 */
export interface GetConfigurationResult {
  /**
   * The deployed configuration content as text. `undefined` on the very first
   * poll if the deployment has not completed; on subsequent polls AppConfig
   * returns an empty body when nothing changed and the last-seen content is
   * returned instead.
   */
  content: string | undefined;
  /** MIME type of the content (e.g. `application/json`). */
  contentType: string | undefined;
  /** The version label of the deployed configuration, if any. */
  versionLabel: string | undefined;
}

/**
 * Fetch the live, deployed configuration for a Lambda (or other AWS runtime)
 * via the AppConfig data plane. Backed by `StartConfigurationSession` +
 * `GetLatestConfiguration`: the binding starts a session on first use, caches
 * the poll token, and returns the latest content on each call.
 *
 * Provide `AppConfig.GetConfigurationHttp` on the hosting function's Effect
 * (`Effect.provide(AppConfig.GetConfigurationHttp)`) to satisfy the binding.
 *
 * @binding
 * @section Reading Live Configuration
 * @example Fetch config from a Lambda
 * ```typescript
 * const getConfig = yield* AppConfig.GetConfiguration(app, env, profile);
 * const { content, contentType } = yield* getConfig();
 * const settings = JSON.parse(content ?? "{}");
 * ```
 */
export interface GetConfiguration extends Binding.Service<
  GetConfiguration,
  "AWS.AppConfig.GetConfiguration",
  (
    application: Application,
    environment: Environment,
    configurationProfile: ConfigurationProfile,
    options?: GetConfigurationOptions,
  ) => Effect.Effect<
    () => Effect.Effect<
      GetConfigurationResult,
      | appconfigdata.StartConfigurationSessionError
      | appconfigdata.GetLatestConfigurationError
    >
  >
> {}
export const GetConfiguration = Binding.Service<GetConfiguration>(
  "AWS.AppConfig.GetConfiguration",
);
