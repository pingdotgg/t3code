import type * as SVC from "@distilled.cloud/aws/kinesis-analytics-v2";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Application } from "./Application.ts";

export interface RollbackApplicationRequest extends Omit<
  SVC.RollbackApplicationRequest,
  "ApplicationName"
> {}

/**
 * Runtime binding for `kinesisanalytics:RollbackApplication` — reverts the
 * bound application to its previous running version (with the state from
 * the latest snapshot when available), e.g. an automated bad-deploy
 * remediation. The `CurrentApplicationVersionId` acts as a compare-and-set
 * token; read it fresh with {@link DescribeApplication}.
 * @binding
 * @section Operating the Application
 * @example Roll back a bad configuration update
 * ```typescript
 * const describeApplication = yield* AWS.KinesisAnalyticsV2.DescribeApplication(app);
 * const rollbackApplication = yield* AWS.KinesisAnalyticsV2.RollbackApplication(app);
 *
 * const { ApplicationDetail } = yield* describeApplication();
 * yield* rollbackApplication({
 *   CurrentApplicationVersionId: ApplicationDetail.ApplicationVersionId,
 * });
 * ```
 */
export interface RollbackApplication extends Binding.Service<
  RollbackApplication,
  "AWS.KinesisAnalyticsV2.RollbackApplication",
  <A extends Application>(
    application: A,
  ) => Effect.Effect<
    (
      request: RollbackApplicationRequest,
    ) => Effect.Effect<
      SVC.RollbackApplicationResponse,
      SVC.RollbackApplicationError
    >
  >
> {}
export const RollbackApplication = Binding.Service<RollbackApplication>(
  "AWS.KinesisAnalyticsV2.RollbackApplication",
);
