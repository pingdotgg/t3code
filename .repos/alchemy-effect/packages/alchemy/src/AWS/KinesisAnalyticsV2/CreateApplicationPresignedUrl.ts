import type * as SVC from "@distilled.cloud/aws/kinesis-analytics-v2";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Application } from "./Application.ts";

export interface CreateApplicationPresignedUrlRequest extends Omit<
  SVC.CreateApplicationPresignedUrlRequest,
  "ApplicationName"
> {}

/**
 * Runtime binding for `kinesisanalytics:CreateApplicationPresignedUrl` —
 * mints a short-lived URL to the bound application's extension (the Flink
 * dashboard, or the Zeppelin UI of a Studio notebook), e.g. to hand an
 * operator a dashboard link from an internal tool. The URL must be used
 * within 3 minutes; the session it opens lives for
 * `SessionExpirationDurationInSeconds` (default 12 hours).
 * @binding
 * @section Operating the Application
 * @example Mint a Flink dashboard link
 * ```typescript
 * const createPresignedUrl = yield* AWS.KinesisAnalyticsV2.CreateApplicationPresignedUrl(app);
 *
 * const { AuthorizedUrl } = yield* createPresignedUrl({
 *   UrlType: "FLINK_DASHBOARD_URL",
 *   SessionExpirationDurationInSeconds: 1800,
 * });
 * ```
 */
export interface CreateApplicationPresignedUrl extends Binding.Service<
  CreateApplicationPresignedUrl,
  "AWS.KinesisAnalyticsV2.CreateApplicationPresignedUrl",
  <A extends Application>(
    application: A,
  ) => Effect.Effect<
    (
      request: CreateApplicationPresignedUrlRequest,
    ) => Effect.Effect<
      SVC.CreateApplicationPresignedUrlResponse,
      SVC.CreateApplicationPresignedUrlError
    >
  >
> {}
export const CreateApplicationPresignedUrl =
  Binding.Service<CreateApplicationPresignedUrl>(
    "AWS.KinesisAnalyticsV2.CreateApplicationPresignedUrl",
  );
