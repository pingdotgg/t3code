import type * as amp from "@distilled.cloud/aws/amp";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `aps:GetDefaultScraperConfiguration`.
 *
 * An account-level binding — call it with no arguments to get a callable
 * that returns the AWS-managed default scraper configuration as Prometheus
 * scrape-configuration YAML text (decoded from the wire blob). Provide the
 * `GetDefaultScraperConfigurationHttp` layer on the Function to satisfy the
 * binding.
 *
 * @binding
 * @section Scraper Configuration
 * @example Read the Default Scraper Configuration
 * ```typescript
 * const getDefaultScraperConfiguration =
 *   yield* AMP.GetDefaultScraperConfiguration();
 *
 * const yaml = yield* getDefaultScraperConfiguration();
 * ```
 */
export interface GetDefaultScraperConfiguration extends Binding.Service<
  GetDefaultScraperConfiguration,
  "AWS.AMP.GetDefaultScraperConfiguration",
  () => Effect.Effect<
    () => Effect.Effect<string, amp.GetDefaultScraperConfigurationError>
  >
> {}
export const GetDefaultScraperConfiguration =
  Binding.Service<GetDefaultScraperConfiguration>(
    "AWS.AMP.GetDefaultScraperConfiguration",
  );
