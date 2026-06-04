import * as AWS from "alchemy/AWS";
import * as Context from "effect/Context";
import * as Layer from "effect/Layer";

/**
 * Deploy-time binding for the ECS example’s jobs queue. Provide with
 * `Layer.succeed(ExampleJobsQueue, queue)` from the stack after the queue exists.
 */
export class JobsQueue extends Context.Service<JobsQueue, AWS.SQS.Queue>()(
  "JobsQueue",
) {}

export const JobsQueueLive = Layer.effect(
  JobsQueue,
  AWS.SQS.Queue("JobsQueue"),
);
