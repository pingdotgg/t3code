import type * as SVC from "@distilled.cloud/aws/kinesis-analytics-v2";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Application } from "./Application.ts";

export interface DescribeApplicationVersionRequest extends Omit<
  SVC.DescribeApplicationVersionRequest,
  "ApplicationName"
> {}

/**
 * Runtime binding for `kinesisanalytics:DescribeApplicationVersion` — reads
 * the configuration of a specific version of the bound application, e.g. to
 * inspect what a rollback target looked like.
 * @binding
 * @section Observing the Application
 * @example Inspect a historical version
 * ```typescript
 * const describeVersion = yield* AWS.KinesisAnalyticsV2.DescribeApplicationVersion(app);
 *
 * const { ApplicationVersionDetail } = yield* describeVersion({
 *   ApplicationVersionId: 3,
 * });
 * ```
 */
export interface DescribeApplicationVersion extends Binding.Service<
  DescribeApplicationVersion,
  "AWS.KinesisAnalyticsV2.DescribeApplicationVersion",
  <A extends Application>(
    application: A,
  ) => Effect.Effect<
    (
      request: DescribeApplicationVersionRequest,
    ) => Effect.Effect<
      SVC.DescribeApplicationVersionResponse,
      SVC.DescribeApplicationVersionError
    >
  >
> {}
export const DescribeApplicationVersion =
  Binding.Service<DescribeApplicationVersion>(
    "AWS.KinesisAnalyticsV2.DescribeApplicationVersion",
  );
