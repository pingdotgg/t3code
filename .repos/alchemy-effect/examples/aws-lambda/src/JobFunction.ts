import * as AWS from "alchemy/AWS";
import { Stack } from "alchemy/Stack";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import {
  JobNotifications,
  JobNotificationsSNS,
  NotifyJobError,
} from "./JobNotifications.ts";
import {
  GetJobError,
  JobStorage,
  JobStorageDynamoDB,
  PutJobError,
} from "./JobStorage.ts";

export default class JobFunction extends AWS.Lambda.Function<JobFunction>()(
  "JobFunction",
  Stack.useSync((stack) => ({
    main: import.meta.filename,
    memory: stack.stage === "prod" ? 1024 : 512,
    url: true,
  })),
  Effect.gen(function* () {
    const jobStorage = yield* JobStorage;
    const notifications = yield* JobNotifications;

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.originalUrl);

        if (request.method === "GET" && url.pathname === "/") {
          const jobId = url.searchParams.get("jobId");
          if (!jobId) {
            return HttpServerResponse.text("Job ID is required", {
              status: 400,
            });
          }

          const job = yield* jobStorage.getJob(jobId).pipe(
            Effect.match({
              onFailure: (error) => error,
              onSuccess: (job) => job,
            }),
          );

          if (job instanceof GetJobError) {
            return HttpServerResponse.text(job.message, { status: 500 });
          }

          if (!job) {
            return HttpServerResponse.text("Job not found", { status: 404 });
          }

          return yield* HttpServerResponse.json(job);
        }

        if (request.method === "POST" && url.pathname === "/") {
          const content = yield* request.text;
          if (!content) {
            return HttpServerResponse.text("Job content is required", {
              status: 400,
            });
          }

          const job = yield* jobStorage
            .putJob({
              id: crypto.randomUUID(),
              content,
            })
            .pipe(
              Effect.match({
                onFailure: (error) => error,
                onSuccess: (job) => job,
              }),
            );

          if (job instanceof PutJobError) {
            return HttpServerResponse.text(job.message, { status: 500 });
          }

          const notificationResult = yield* notifications
            .notifyJobCreated(job)
            .pipe(
              Effect.match({
                onFailure: (error) => error,
                onSuccess: () => undefined,
              }),
            );

          if (notificationResult instanceof NotifyJobError) {
            return HttpServerResponse.text(notificationResult.message, {
              status: 500,
            });
          }

          return yield* HttpServerResponse.json(
            { jobId: job.id },
            { status: 201 },
          );
        }

        return HttpServerResponse.text("Not found", { status: 404 });
      }),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        // Services go here
        JobStorageDynamoDB,
        JobNotificationsSNS,
        // JobStorageS3,
      ),
    ),
  ),
) {}
