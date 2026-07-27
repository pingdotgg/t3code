import type * as SVC from "@distilled.cloud/aws/kinesis-analytics-v2";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Application } from "./Application.ts";

export interface StartApplicationRequest extends Omit<
  SVC.StartApplicationRequest,
  "ApplicationName"
> {}

/**
 * Runtime binding for `kinesisanalytics:StartApplication` — starts the
 * bound Flink application, optionally restoring from a snapshot via
 * `RunConfiguration`. The returned `OperationId` can be polled with
 * {@link DescribeApplicationOperation}.
 * @binding
 * @section Operating the Application
 * @example Start the Flink job from its latest snapshot
 * ```typescript
 * const startApplication = yield* AWS.KinesisAnalyticsV2.StartApplication(app);
 *
 * const { OperationId } = yield* startApplication({
 *   RunConfiguration: {
 *     ApplicationRestoreConfiguration: {
 *       ApplicationRestoreType: "RESTORE_FROM_LATEST_SNAPSHOT",
 *     },
 *   },
 * });
 * ```
 */
export interface StartApplication extends Binding.Service<
  StartApplication,
  "AWS.KinesisAnalyticsV2.StartApplication",
  <A extends Application>(
    application: A,
  ) => Effect.Effect<
    (
      request?: StartApplicationRequest,
    ) => Effect.Effect<SVC.StartApplicationResponse, SVC.StartApplicationError>
  >
> {}
export const StartApplication = Binding.Service<StartApplication>(
  "AWS.KinesisAnalyticsV2.StartApplication",
);
