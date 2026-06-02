import { Effect, Layer, Schema } from "effect";
import {
  Rpc,
  RpcGroup,
  RpcSerialization,
  RpcServer,
} from "effect/unstable/rpc";
import { Job, JobId } from "./Job.ts";
import { JobNotifications } from "./JobNotifications.ts";
import { JobStorage } from "./JobStorage.ts";

export class JobNotFound extends Schema.TaggedClass<JobNotFound>()(
  "JobNotFound",
  { jobId: JobId },
) {}

export class GetJobFailed extends Schema.TaggedClass<GetJobFailed>()(
  "GetJobFailed",
  { message: Schema.String },
) {}

export class PutJobFailed extends Schema.TaggedClass<PutJobFailed>()(
  "PutJobFailed",
  { message: Schema.String },
) {}

const getJob = Rpc.make("getJob", {
  success: Job,
  error: Schema.Union([JobNotFound, GetJobFailed]),
  payload: {
    jobId: JobId,
  },
});

const createJob = Rpc.make("createJob", {
  success: JobId,
  error: PutJobFailed,
  payload: {
    content: Schema.String,
  },
});

export class JobRpcs extends RpcGroup.make(getJob, createJob) {}

export const JobRpcsLive = JobRpcs.toLayer(
  Effect.gen(function* () {
    const jobService = yield* JobStorage;
    const notifications = yield* JobNotifications;

    return {
      getJob: ({ jobId }) =>
        jobService.getJob(jobId).pipe(
          Effect.mapError(
            (error) =>
              new GetJobFailed({
                message: error.message,
              }),
          ),
          Effect.flatMap((job) =>
            job ? Effect.succeed(job) : Effect.fail(new JobNotFound({ jobId })),
          ),
        ),
      createJob: ({ content }) =>
        Effect.gen(function* () {
          const jobId = crypto.randomUUID();
          const job = yield* jobService.putJob({
            id: jobId,
            content,
          });
          yield* notifications.notifyJobCreated(job);
          return job.id;
        }).pipe(
          Effect.mapError(
            (error) =>
              new PutJobFailed({
                message: error.message,
              }),
          ),
        ),
    };
  }),
);

export const JobRpcHttpEffect = RpcServer.toHttpEffect(JobRpcs).pipe(
  Effect.provide(Layer.mergeAll(JobRpcsLive, RpcSerialization.layerJson)),
);
