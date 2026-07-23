import * as AWS from "alchemy/AWS";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Etag from "effect/unstable/http/Etag";
import * as HttpPlatform from "effect/unstable/http/HttpPlatform";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import { JobApiLive } from "./JobApi.ts";
import { JobNotificationsSNS } from "./JobNotifications.ts";
import { JobStorageDynamoDB } from "./JobStorage.ts";

export default class JobFunction extends AWS.Lambda.Function<JobFunction>()(
  "JobFunction",
  {
    main: import.meta.filename,
    url: true,
  },
  HttpRouter.toHttpEffect(JobApiLive).pipe(
    Effect.map((fetch) => ({ fetch })),
    Effect.provide(
      Layer.mergeAll(
        JobStorageDynamoDB,
        JobNotificationsSNS,
        // TODO(sam): these should be provided to us automatically
        HttpPlatform.layer,
        Etag.layer,
      ),
    ),
  ),
) {}
