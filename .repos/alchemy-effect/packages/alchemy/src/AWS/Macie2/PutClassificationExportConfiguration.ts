import type * as macie2 from "@distilled.cloud/aws/macie2";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `macie2:PutClassificationExportConfiguration`.
 *
 * Adds or updates the configuration settings for storing data classification results.
 * Account-level operation — invoked with the caller's request as-is.
 * Provide the implementation with
 * `Effect.provide(AWS.Macie2.PutClassificationExportConfigurationHttp)`.
 * @binding
 * @section Classification Jobs & Export
 * @example Export Results to S3
 * ```typescript
 * // init — account-level binding, no resource argument
 * const putClassificationExportConfiguration = yield* AWS.Macie2.PutClassificationExportConfiguration();
 *
 * // runtime
 * yield* putClassificationExportConfiguration({
 *   configuration: {
 *     s3Destination: { bucketName, keyPrefix: "macie/", kmsKeyArn },
 *   },
 * });
 * ```
 */
export interface PutClassificationExportConfiguration extends Binding.Service<
  PutClassificationExportConfiguration,
  "AWS.Macie2.PutClassificationExportConfiguration",
  () => Effect.Effect<
    (
      request?: macie2.PutClassificationExportConfigurationRequest,
    ) => Effect.Effect<
      macie2.PutClassificationExportConfigurationResponse,
      macie2.PutClassificationExportConfigurationError
    >
  >
> {}
export const PutClassificationExportConfiguration =
  Binding.Service<PutClassificationExportConfiguration>(
    "AWS.Macie2.PutClassificationExportConfiguration",
  );
