import type * as glue from "@distilled.cloud/aws/glue";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Job } from "./Job.ts";

export interface GetJobBookmarkRequest extends Omit<
  glue.GetJobBookmarkRequest,
  "JobName"
> {}

/**
 * Runtime binding for `glue:GetJobBookmark`.
 *
 * Reads the bound {@link Job}'s bookmark entry — the incremental-processing
 * checkpoint Glue keeps when a job runs with `--job-bookmark-option
 * job-bookmark-enable`. Fails with the typed `EntityNotFoundException` when
 * the job has never recorded a bookmark. The job name is injected from the
 * binding. Provide the implementation with
 * `Effect.provide(AWS.Glue.GetJobBookmarkHttp)`.
 * @binding
 * @section Job Bookmarks
 * @example Read the Bookmark
 * ```typescript
 * // init
 * const getJobBookmark = yield* AWS.Glue.GetJobBookmark(job);
 *
 * // runtime
 * const entry = yield* getJobBookmark().pipe(
 *   Effect.map((r) => r.JobBookmarkEntry),
 *   Effect.catchTag("EntityNotFoundException", () =>
 *     Effect.succeed(undefined),
 *   ),
 * );
 * ```
 */
export interface GetJobBookmark extends Binding.Service<
  GetJobBookmark,
  "AWS.Glue.GetJobBookmark",
  (
    job: Job,
  ) => Effect.Effect<
    (
      request?: GetJobBookmarkRequest,
    ) => Effect.Effect<glue.GetJobBookmarkResponse, glue.GetJobBookmarkError>
  >
> {}

export const GetJobBookmark = Binding.Service<GetJobBookmark>(
  "AWS.Glue.GetJobBookmark",
);
