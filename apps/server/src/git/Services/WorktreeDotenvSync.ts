import { type GitSyncWorktreeDotenvFilesInput, type GitSyncWorktreeDotenvFilesResult } from "@t3tools/contracts";
import { ServiceMap } from "effect";
import type { Effect } from "effect";

import type { WorktreeDotenvSyncError } from "../Errors.ts";

export interface WorktreeDotenvSyncShape {
  readonly syncFiles: (
    input: GitSyncWorktreeDotenvFilesInput,
  ) => Effect.Effect<GitSyncWorktreeDotenvFilesResult, WorktreeDotenvSyncError>;
}

export class WorktreeDotenvSync extends ServiceMap.Service<
  WorktreeDotenvSync,
  WorktreeDotenvSyncShape
>()("t3/git/Services/WorktreeDotenvSync") {}
