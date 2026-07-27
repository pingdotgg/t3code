import * as mediaconvert from "@distilled.cloud/aws/mediaconvert";
import * as Effect from "effect/Effect";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { createInternalTags } from "../../Tags.ts";
import type { Providers } from "../Providers.ts";

export interface JobProps {
  /**
   * ARN of the IAM role MediaConvert assumes to read the input from and write
   * the output to Amazon S3. Required.
   */
  role: string;
  /**
   * The transcode settings for this job — the input file(s) and the output
   * groups to produce. Required unless a `jobTemplate` supplies them.
   */
  settings?: mediaconvert.JobSettings;
  /**
   * Name (or ARN) of a job template to base this job on. When set, the
   * template's settings are merged with any `settings` overrides.
   */
  jobTemplate?: string;
  /**
   * Name of the queue to submit the job to. If omitted, the account's
   * `Default` queue is used.
   */
  queue?: string;
  /**
   * Relative priority of the job within its queue (-50 to 50).
   */
  priority?: number;
  /**
   * How often, in seconds, MediaConvert emits `STATUS_UPDATE` events.
   */
  statusUpdateInterval?: mediaconvert.StatusUpdateInterval;
  /**
   * Accelerated transcoding configuration.
   */
  accelerationSettings?: mediaconvert.AccelerationSettings;
  /**
   * Arbitrary key/value metadata attached to the job and echoed in events.
   */
  userMetadata?: Record<string, string>;
  /**
   * User-defined tags for the job.
   */
  tags?: Record<string, string>;
}

export interface Job extends Resource<
  "AWS.MediaConvert.Job",
  JobProps,
  {
    jobId: string;
    jobArn: string;
    status: string | undefined;
    queue: string | undefined;
  },
  never,
  Providers
> {}

/**
 * An AWS Elemental MediaConvert transcode job — a one-shot request to convert
 * an input in S3 into one or more outputs. Jobs are immutable once submitted:
 * they run to `COMPLETE`, `ERROR`, or `CANCELED` on their own. Deleting the
 * resource cancels the job only if it is still `SUBMITTED` or `PROGRESSING`.
 *
 * A live job is slow and billable — it requires input/output S3 objects and an
 * IAM role MediaConvert can assume. Drive it behind an environment gate in
 * tests rather than on every run.
 *
 * @resource
 * @section Submitting a Job
 * @example File Transcode from a Template
 * ```typescript
 * const job = yield* MediaConvert.Job("Transcode", {
 *   role: mediaConvertRole.roleArn,
 *   jobTemplate: template.jobTemplateName,
 *   settings: {
 *     Inputs: [{ FileInput: "s3://my-bucket/input.mp4" }],
 *     OutputGroups: [
 *       {
 *         OutputGroupSettings: {
 *           Type: "FILE_GROUP_SETTINGS",
 *           FileGroupSettings: { Destination: "s3://my-bucket/out/" },
 *         },
 *         Outputs: [{ Preset: preset.presetName }],
 *       },
 *     ],
 *   },
 * });
 * ```
 */
export const Job = Resource<Job>("AWS.MediaConvert.Job");

export const JobProvider = () =>
  Provider.effect(
    Job,
    Effect.gen(function* () {
      const toAttrs = (job: mediaconvert.Job) => ({
        jobId: job.Id!,
        jobArn: job.Arn!,
        status: job.Status,
        queue: job.Queue,
      });

      /** Get a job by id; typed not-found → undefined. */
      const getJob = Effect.fn(function* (id: string) {
        const response = yield* mediaconvert
          .getJob({ Id: id })
          .pipe(
            Effect.catchTag("NotFoundException", () =>
              Effect.succeed(undefined),
            ),
          );
        return response?.Job;
      });

      return {
        stables: ["jobId", "jobArn"],

        read: Effect.fn(function* ({ output }) {
          // Jobs are server-assigned; without an output cache there is no id.
          if (!output?.jobId) return undefined;
          const job = yield* getJob(output.jobId);
          // A job that has aged out of history is still "done" — keep the
          // cached attributes rather than triggering a resubmit.
          if (job === undefined) {
            return {
              jobId: output.jobId,
              jobArn: output.jobArn,
              status: output.status,
              queue: output.queue,
            };
          }
          return toAttrs(job);
        }),

        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          // Jobs are immutable. If one was already submitted, observe it and
          // return — never resubmit on an update.
          if (output?.jobId) {
            const existing = yield* getJob(output.jobId);
            yield* session.note(output.jobId);
            return existing
              ? toAttrs(existing)
              : {
                  jobId: output.jobId,
                  jobArn: output.jobArn,
                  status: output.status,
                  queue: output.queue,
                };
          }

          const internalTags = yield* createInternalTags(id);
          const created = yield* mediaconvert.createJob({
            Role: news.role,
            Settings: news.settings,
            JobTemplate: news.jobTemplate,
            Queue: news.queue,
            Priority: news.priority,
            StatusUpdateInterval: news.statusUpdateInterval,
            AccelerationSettings: news.accelerationSettings,
            UserMetadata: news.userMetadata,
            Tags: { ...internalTags, ...news.tags },
          });
          const job = created.Job!;
          yield* session.note(job.Id!);
          return toAttrs(job);
        }),

        delete: Effect.fn(function* ({ output }) {
          yield* mediaconvert.cancelJob({ Id: output.jobId }).pipe(
            // NotFound → already gone; Conflict/BadRequest → the job is already
            // in a terminal state and cannot be canceled. All are idempotent
            // no-ops for deletion.
            Effect.catchTag(
              ["NotFoundException", "ConflictException", "BadRequestException"],
              () => Effect.void,
            ),
          );
        }),

        // Jobs are ephemeral, not a managed inventory — enumeration would churn
        // over transient history, so the engine lists nothing.
        list: () => Effect.succeed([]),
      };
    }),
  );
