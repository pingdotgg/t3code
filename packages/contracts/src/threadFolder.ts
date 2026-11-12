import * as Schema from "effect/Schema";

import {
  ForwardCompatibleArray,
  IsoDateTime,
  ProjectId,
  ThreadFolderId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { ProjectIconOverride, ReceivedProjectIcon } from "./project.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

export const MAX_THREAD_FOLDERS = 200;
export const MAX_THREAD_FOLDER_MOVE_THREADS = 100;

export const ThreadFolderName = TrimmedNonEmptyString.check(Schema.isMaxLength(80));

const ThreadFolderRulePattern = TrimmedNonEmptyString.check(Schema.isMaxLength(200));
const ThreadFolderRuleList = <S extends Schema.Top>(item: S) =>
  Schema.Array(item).check(Schema.isMinLength(1), Schema.isMaxLength(20));

/**
 * Which new threads a folder files automatically. `smart`, `branches`, and `worktrees` each add
 * threads: a thread whose work fits the folder name, or that is on any listed branch or worktree.
 * Every other field present must also match. Patterns are case-insensitive; `*` matches any run.
 */
export const ThreadFolderRule = Schema.Struct({
  smart: Schema.optional(Schema.Boolean),
  projectIds: Schema.optional(ThreadFolderRuleList(ProjectId)),
  branches: Schema.optional(ThreadFolderRuleList(ThreadFolderRulePattern)),
  /** Matches the full worktree path or its last segment. */
  worktrees: Schema.optional(ThreadFolderRuleList(ThreadFolderRulePattern)),
  /** Matches when the title contains any of these. */
  titleKeywords: Schema.optional(ThreadFolderRuleList(ThreadFolderRulePattern)),
  /** true: the thread has a linked or branch pull request; false: it has none. */
  pullRequest: Schema.optional(Schema.Boolean),
  providerInstanceIds: Schema.optional(ThreadFolderRuleList(ProviderInstanceId)),
});
export type ThreadFolderRule = typeof ThreadFolderRule.Type;

export const ThreadFolder = Schema.Struct({
  id: ThreadFolderId,
  name: ThreadFolderName,
  icon: Schema.NullOr(ReceivedProjectIcon),
  // Deleted threads drop out; clients still skip ids they have not loaded.
  threadIds: Schema.Array(ThreadId),
  rule: Schema.NullOr(ThreadFolderRule),
  /** Whether threads created after `ruleSetAt` that match `rule` are filed here. */
  autoFile: Schema.Boolean,
  ruleSetAt: Schema.NullOr(IsoDateTime),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type ThreadFolder = typeof ThreadFolder.Type;

export const ThreadFolderListInput = Schema.Struct({});
export type ThreadFolderListInput = typeof ThreadFolderListInput.Type;

export const ThreadFolderListResult = Schema.Struct({
  folders: ForwardCompatibleArray(ThreadFolder),
});
export type ThreadFolderListResult = typeof ThreadFolderListResult.Type;

const ThreadFolderMoveThreadIds = Schema.Array(ThreadId).check(
  Schema.isMinLength(1),
  Schema.isMaxLength(MAX_THREAD_FOLDER_MOVE_THREADS),
);

export const ThreadFolderMutation = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("folder.create"),
    folderId: ThreadFolderId,
    name: ThreadFolderName,
    icon: Schema.optional(Schema.NullOr(ProjectIconOverride)),
    threadIds: Schema.optional(ThreadFolderMoveThreadIds),
    rule: Schema.optional(Schema.NullOr(ThreadFolderRule)),
    autoFile: Schema.optional(Schema.Boolean),
  }),
  Schema.Struct({
    type: Schema.Literal("folder.update"),
    folderId: ThreadFolderId,
    name: Schema.optional(ThreadFolderName),
    icon: Schema.optional(Schema.NullOr(ProjectIconOverride)),
    rule: Schema.optional(Schema.NullOr(ThreadFolderRule)),
    autoFile: Schema.optional(Schema.Boolean),
  }),
  Schema.Struct({
    type: Schema.Literal("folder.reorder"),
    folderId: ThreadFolderId,
    // null moves the folder to the end.
    beforeFolderId: Schema.NullOr(ThreadFolderId),
  }),
  Schema.Struct({
    // Moves every unfiled thread related to the folder into it: its rule, or else its name.
    type: Schema.Literal("folder.applyRule"),
    folderId: ThreadFolderId,
  }),
  Schema.Struct({
    type: Schema.Literal("folder.delete"),
    folderId: ThreadFolderId,
  }),
  Schema.Struct({
    type: Schema.Literal("folder.move"),
    threadIds: ThreadFolderMoveThreadIds,
    // null takes the threads out of their folder.
    folderId: Schema.NullOr(ThreadFolderId),
  }),
]);
export type ThreadFolderMutation = typeof ThreadFolderMutation.Type;

export const ThreadFolderMutationResult = Schema.Struct({
  folders: ForwardCompatibleArray(ThreadFolder),
});
export type ThreadFolderMutationResult = typeof ThreadFolderMutationResult.Type;

export class ThreadFolderError extends Schema.TaggedError<ThreadFolderError>()(
  "ThreadFolderError",
  {
    message: Schema.String,
    folderId: Schema.optional(ThreadFolderId),
    cause: Schema.optional(Schema.Defect()),
  },
) {}
