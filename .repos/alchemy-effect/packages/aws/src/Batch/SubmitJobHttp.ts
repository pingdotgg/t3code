import * as batch from "@distilled.cloud/aws/batch";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as AWSBindings from "../AWSBindings.ts";
import type { JobDefinition } from "./JobDefinition.ts";
import type { JobQueue } from "./JobQueue.ts";
import { SubmitJob, type SubmitJobRequest } from "./SubmitJob.ts";

export const SubmitJobHttp = Layer.effect(
  SubmitJob,
  Effect.gen(function* () {
    const bind = yield* AWSBindings.Bind;
    const submitJob = yield* AWSBindings.withCredentials(batch.submitJob);

    return Effect.fn(function* (queue: JobQueue, jobDefinition: JobDefinition) {
      // Outputs yield a DEFERRED effect — resolve again per invocation below.
      const JobQueueArn = yield* queue.jobQueueArn;
      const JobDefinitionArn = yield* jobDefinition.jobDefinitionArn;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        yield* bind`AWS.Batch.SubmitJob(${queue}, ${jobDefinition})`({
          policyStatements: [
            {
              Effect: "Allow",
              Action: ["batch:SubmitJob"],
              Resource: [queue.jobQueueArn, jobDefinition.jobDefinitionArn],
            },
          ],
        });
      }
      return Effect.fn(`AWS.Batch.SubmitJob(${queue.LogicalId}, ${jobDefinition.LogicalId})`)(
        function* (request: SubmitJobRequest) {
          const jobQueueArn = yield* JobQueueArn;
          const jobDefinitionArn = yield* JobDefinitionArn;
          return yield* submitJob({
            ...request,
            jobQueue: jobQueueArn,
            jobDefinition: jobDefinitionArn,
          });
        },
      );
    });
  }),
);
