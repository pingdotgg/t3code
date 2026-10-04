import {
  OrchestratorMcpFailure,
  ReviewDiffFileStat,
  ReviewDiffPreviewSource,
  ReviewDiffPreviewSourceKind,
  ThreadId,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/unstable/ai";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../../../project/ProjectService.ts";
import * as ReviewService from "../../../review/ReviewService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const MAX_DIFF_CHARACTERS = 100_000;

const ThreadDiffTool = Tool.make("t3_thread_diff", {
  description:
    "Show what a thread changed in its checkout (omit threadId for this thread), as the diff panel does. Returns two sources: working-tree (uncommitted changes vs HEAD) and branch-range (committed and uncommitted changes since the merge base with baseRef, or the detected base branch). Each has per-file stats and a unified diff cut to maxCharacters (default 20,000, max 100,000) with truncated set when cut. Pass source to return one. Pass file (repository-relative path) for that file's patch only; it reads branch-range unless source says otherwise.",
  parameters: Schema.Struct({
    threadId: Schema.optional(ThreadId),
    baseRef: Schema.optional(TrimmedNonEmptyString),
    source: Schema.optional(ReviewDiffPreviewSourceKind),
    file: Schema.optional(Schema.NonEmptyString),
    maxCharacters: Schema.optional(
      Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: MAX_DIFF_CHARACTERS })),
    ),
  }),
  success: Schema.Struct({
    threadId: ThreadId,
    cwd: Schema.String,
    sources: Schema.Array(
      Schema.Struct({
        kind: ReviewDiffPreviewSource.fields.kind,
        title: ReviewDiffPreviewSource.fields.title,
        baseRef: ReviewDiffPreviewSource.fields.baseRef,
        headRef: ReviewDiffPreviewSource.fields.headRef,
        // Null when there were too many untracked files to count.
        files: Schema.NullOr(Schema.Array(ReviewDiffFileStat)),
        diff: Schema.String,
        truncated: Schema.Boolean,
      }),
    ),
  }),
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    ProjectService.ProjectService,
    ReviewService.ReviewService,
  ],
})
  .annotate(Tool.Title, "Show thread diff")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

export const ReviewToolkit = Toolkit.make(ThreadDiffTool);
