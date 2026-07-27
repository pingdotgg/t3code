import type * as SVC from "@distilled.cloud/aws/kinesis-analytics-v2";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Application } from "./Application.ts";

export interface ListApplicationVersionsRequest extends Omit<
  SVC.ListApplicationVersionsRequest,
  "ApplicationName"
> {}

/**
 * Runtime binding for `kinesisanalytics:ListApplicationVersions` — pages
 * through the bound application's version history (every configuration
 * update creates a version), e.g. to pick a rollback target.
 * @binding
 * @section Observing the Application
 * @example List recent versions
 * ```typescript
 * const listVersions = yield* AWS.KinesisAnalyticsV2.ListApplicationVersions(app);
 *
 * const { ApplicationVersionSummaries } = yield* listVersions({ Limit: 10 });
 * ```
 */
export interface ListApplicationVersions extends Binding.Service<
  ListApplicationVersions,
  "AWS.KinesisAnalyticsV2.ListApplicationVersions",
  <A extends Application>(
    application: A,
  ) => Effect.Effect<
    (
      request?: ListApplicationVersionsRequest,
    ) => Effect.Effect<
      SVC.ListApplicationVersionsResponse,
      SVC.ListApplicationVersionsError
    >
  >
> {}
export const ListApplicationVersions = Binding.Service<ListApplicationVersions>(
  "AWS.KinesisAnalyticsV2.ListApplicationVersions",
);
