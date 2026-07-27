import type * as SVC from "@distilled.cloud/aws/kinesis-analytics-v2";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Application } from "./Application.ts";

export interface DescribeApplicationRequest extends Omit<
  SVC.DescribeApplicationRequest,
  "ApplicationName"
> {}

/**
 * Runtime binding for `kinesisanalytics:DescribeApplication` — reads the
 * bound application's full detail (status, version, runtime environment,
 * configuration), the building block of ops automation that reacts to the
 * Flink job's lifecycle state.
 * @binding
 * @section Observing the Application
 * @example Check whether the Flink job is running
 * ```typescript
 * const describeApplication = yield* AWS.KinesisAnalyticsV2.DescribeApplication(app);
 *
 * const { ApplicationDetail } = yield* describeApplication();
 * const running = ApplicationDetail.ApplicationStatus === "RUNNING";
 * ```
 */
export interface DescribeApplication extends Binding.Service<
  DescribeApplication,
  "AWS.KinesisAnalyticsV2.DescribeApplication",
  <A extends Application>(
    application: A,
  ) => Effect.Effect<
    (
      request?: DescribeApplicationRequest,
    ) => Effect.Effect<
      SVC.DescribeApplicationResponse,
      SVC.DescribeApplicationError
    >
  >
> {}
export const DescribeApplication = Binding.Service<DescribeApplication>(
  "AWS.KinesisAnalyticsV2.DescribeApplication",
);
