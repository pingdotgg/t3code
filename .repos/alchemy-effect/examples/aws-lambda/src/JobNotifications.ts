import * as AWS from "alchemy/AWS";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import type { Job } from "./Job.ts";

export class NotifyJobError extends Data.TaggedError("NotifyJobError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

type JobNotification = {
  type: "job.created";
  job: Job;
};

export class JobNotifications extends Context.Service<
  JobNotifications,
  {
    notifyJobCreated(job: Job): Effect.Effect<void, NotifyJobError>;
  }
>()("JobNotifications") {}

export const JobNotificationsSNS = Layer.effect(
  JobNotifications,
  Effect.gen(function* () {
    const topic = yield* AWS.SNS.Topic("JobNotificationsTopic", {
      attributes: {
        DisplayName: "job-notifications",
      },
    });

    const publish = yield* AWS.SNS.Publish.bind(topic);

    yield* AWS.SNS.notifications(topic).subscribe((stream) =>
      stream.pipe(
        Stream.mapEffect((notification) =>
          Effect.try({
            try: () => JSON.parse(notification.Message) as JobNotification,
            catch: (cause) =>
              new NotifyJobError({
                message: "Failed to parse SNS job notification",
                cause,
              }),
          }).pipe(
            Effect.flatMap((payload) =>
              Effect.logInfo(
                `Job notification received: ${payload.type} (${payload.job.id})`,
              ),
            ),
            // Keep the example resilient to malformed demo messages.
            Effect.catchTag("NotifyJobError", (error) =>
              Effect.logWarning(error.message),
            ),
          ),
        ),
        Stream.runDrain,
      ),
    );

    const notifyJobCreated = (job: Job) =>
      publish({
        Subject: "JobCreated",
        Message: JSON.stringify({
          type: "job.created",
          job,
        } satisfies JobNotification),
      }).pipe(
        Effect.asVoid,
        Effect.mapError(
          (cause) =>
            new NotifyJobError({
              message: `Failed to publish job notification for "${job.id}"`,
              cause,
            }),
        ),
      );

    return JobNotifications.of({
      notifyJobCreated,
    });
  }),
).pipe(
  Layer.provideMerge(
    Layer.mergeAll(AWS.Lambda.TopicEventSource, AWS.SNS.PublishLive),
  ),
);
