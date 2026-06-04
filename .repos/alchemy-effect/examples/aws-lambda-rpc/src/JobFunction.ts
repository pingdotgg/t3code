import * as AWS from "alchemy/AWS";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { JobNotificationsSNS } from "./JobNotifications.ts";
import { JobRpcHttpEffect } from "./JobRpcApi.ts";
import { JobStorageDynamoDB } from "./JobStorage.ts";

export default class JobFunction extends AWS.Lambda.Function<JobFunction>()(
  "JobFunction",
  {
    main: import.meta.filename,
    url: true,
  },
  JobRpcHttpEffect.pipe(
    Effect.map((fetch) => ({ fetch })),
    Effect.provide(Layer.mergeAll(JobStorageDynamoDB, JobNotificationsSNS)),
  ),
) {}
