import type * as transcoder from "@distilled.cloud/gcp/transcoder_v1";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import type { JobTemplate } from "./JobTemplate.ts";

export interface CreateJobRequest extends Omit<
  transcoder.CreateProjectsLocationsJobsRequest,
  "parent"
> {}

/**
 * Runtime binding for Transcoder `jobs.create`.
 *
 * Starts a transcoding job in the template's location. When `body.config`
 * is omitted, `templateId` is filled from the bound {@link JobTemplate}.
 * Provide {@link CreateJobHttp}.
 *
 * Grants `roles/transcoder.editor` on the project because Transcoder has
 * no resource-level IAM and no narrower predefined role carries
 * `transcoder.jobs.create` (`roles/transcoder.viewer` is read-only).
 *
 * ### Creating a Job
 * **Example:** Transcode with the bound template
 * ```typescript
 * const createJob = yield* GCP.Transcoder.CreateJob(template);
 * const job = yield* createJob({
 *   body: {
 *     inputUri: "gs://bucket/inputs/file.mp4",
 *     outputUri: "gs://bucket/outputs/",
 *   },
 * });
 * ```
 *
 * @binding
 * @category Transcoder
 */
export interface CreateJob extends Binding.Service<
  CreateJob,
  "GCP.Transcoder.CreateJob",
  (
    template: JobTemplate,
  ) => Effect.Effect<
    (
      request?: CreateJobRequest,
    ) => Effect.Effect<
      transcoder.Job,
      transcoder.CreateProjectsLocationsJobsError,
      RuntimeContext
    >
  >
> {}

export const CreateJob = Binding.Service<CreateJob>("GCP.Transcoder.CreateJob");
