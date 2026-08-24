import type * as glue from "@distilled.cloud/aws/glue";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Job } from "./Job.ts";

export interface ResetJobBookmarkRequest extends Omit<
  glue.ResetJobBookmarkRequest,
  "JobName"
> {}

/**
 * Runtime binding for `glue:ResetJobBookmark`.
 *
 * Resets the bound {@link Job}'s bookmark entry so the next bookmarked run
 * reprocesses the source data from the beginning — the standard remediation
 * after a bad deploy consumed data incorrectly. The job name is injected
 * from the binding. Provide the implementation with
 * `Effect.provide(AWS.Glue.ResetJobBookmarkHttp)`.
 * @binding
 * @section Job Bookmarks
 * @example Reset the Bookmark
 * ```typescript
 * // init
 * const resetJobBookmark = yield* AWS.Glue.ResetJobBookmark(job);
 *
 * // runtime
 * yield* resetJobBookmark();
 * ```
 */
export interface ResetJobBookmark extends Binding.Service<
  ResetJobBookmark,
  "AWS.Glue.ResetJobBookmark",
  (
    job: Job,
  ) => Effect.Effect<
    (
      request?: ResetJobBookmarkRequest,
    ) => Effect.Effect<
      glue.ResetJobBookmarkResponse,
      glue.ResetJobBookmarkError
    >
  >
> {}

export const ResetJobBookmark = Binding.Service<ResetJobBookmark>(
  "AWS.Glue.ResetJobBookmark",
);
