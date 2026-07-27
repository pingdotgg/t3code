import type * as macie2 from "@distilled.cloud/aws/macie2";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `macie2:GetClassificationExportConfiguration`.
 *
 * Retrieves the configuration settings for storing data classification results.
 * Account-level operation — invoked with the caller's request as-is.
 * Provide the implementation with
 * `Effect.provide(AWS.Macie2.GetClassificationExportConfigurationHttp)`.
 * @binding
 * @section Classification Jobs & Export
 * @example Read the Export Configuration
 * ```typescript
 * // init — account-level binding, no resource argument
 * const getClassificationExportConfiguration = yield* AWS.Macie2.GetClassificationExportConfiguration();
 *
 * // runtime
 * const { configuration } = yield* getClassificationExportConfiguration();
 * ```
 */
export interface GetClassificationExportConfiguration extends Binding.Service<
  GetClassificationExportConfiguration,
  "AWS.Macie2.GetClassificationExportConfiguration",
  () => Effect.Effect<
    (
      request?: macie2.GetClassificationExportConfigurationRequest,
    ) => Effect.Effect<
      macie2.GetClassificationExportConfigurationResponse,
      macie2.GetClassificationExportConfigurationError
    >
  >
> {}
export const GetClassificationExportConfiguration =
  Binding.Service<GetClassificationExportConfiguration>(
    "AWS.Macie2.GetClassificationExportConfiguration",
  );
