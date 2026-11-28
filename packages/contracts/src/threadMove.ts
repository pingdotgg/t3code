import * as Schema from "effect/Schema";
import {
  CommandId,
  IsoDateTime,
  NonNegativeInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { ModelSelection } from "./modelSelection.ts";
import { OrchestrationV2Actor, OrchestrationV2CreationSource } from "./orchestrationV2.ts";
import { ProviderInteractionMode, RuntimeMode } from "./providerPolicy.ts";
import { ThreadPullRequestLink } from "./threadPullRequest.ts";

/** Message text a move carries, in UTF-8 bytes. Export keeps the first request and the newest history within it. */
export const THREAD_MOVE_MAX_HISTORY_BYTES = 1_000_000;

export const ThreadMoveMessage = Schema.Struct({
  role: Schema.Literals(["user", "assistant"]),
  text: Schema.String,
  createdAt: IsoDateTime,
  /** Who wrote a user-role message, and through what; an agent can send one. Omitted means the user. */
  createdBy: Schema.optional(OrchestrationV2Actor),
  creationSource: Schema.optional(OrchestrationV2CreationSource),
});
export type ThreadMoveMessage = typeof ThreadMoveMessage.Type;

export const ThreadMoveGit = Schema.Struct({
  /** The branch checked out where the thread works. */
  branch: TrimmedNonEmptyString,
  /** The branch it tracks on its remote, as named there; null when it tracks none. */
  remoteBranch: Schema.NullOr(TrimmedNonEmptyString),
  headCommit: Schema.NullOr(TrimmedNonEmptyString),
  /** Commits the remote branch lacks. Counts every commit when nothing is tracked. */
  unpushedCommitCount: NonNegativeInt,
  uncommittedFileCount: NonNegativeInt,
});
export type ThreadMoveGit = typeof ThreadMoveGit.Type;

export const ThreadMoveSnapshot = Schema.Struct({
  sourceThreadId: ThreadId,
  sourceEnvironmentLabel: Schema.String,
  title: Schema.String,
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  messages: Schema.Array(ThreadMoveMessage),
  /** Messages left behind to stay within `THREAD_MOVE_MAX_HISTORY_BYTES`. */
  omittedMessageCount: NonNegativeInt,
  pullRequests: Schema.Array(ThreadPullRequestLink),
  /** Null when the thread works outside a Git branch. */
  git: Schema.NullOr(ThreadMoveGit),
});
export type ThreadMoveSnapshot = typeof ThreadMoveSnapshot.Type;

export const ThreadMoveExportInput = Schema.Struct({ threadId: ThreadId });
export type ThreadMoveExportInput = typeof ThreadMoveExportInput.Type;

export const ThreadMoveImportInput = Schema.Struct({
  commandId: CommandId,
  projectId: ProjectId,
  snapshot: ThreadMoveSnapshot,
  creationSource: Schema.optional(Schema.Literals(["web", "mobile"])),
});
export type ThreadMoveImportInput = typeof ThreadMoveImportInput.Type;

export const ThreadMoveImportResult = Schema.Struct({
  threadId: ThreadId,
  /** The branch the new thread works on, when the move brought the source's branch along. */
  carriedBranch: Schema.NullOr(TrimmedNonEmptyString),
});
export type ThreadMoveImportResult = typeof ThreadMoveImportResult.Type;

export const ThreadMoveCompleteInput = Schema.Struct({
  threadId: ThreadId,
  targetEnvironmentLabel: Schema.String,
});
export type ThreadMoveCompleteInput = typeof ThreadMoveCompleteInput.Type;

export const ThreadMoveErrorReason = Schema.Literals([
  "thread-not-found",
  "thread-running",
  "project-not-found",
  "history-too-large",
  "failed",
]);
export type ThreadMoveErrorReason = typeof ThreadMoveErrorReason.Type;

export class ThreadMoveError extends Schema.TaggedError<ThreadMoveError>()("ThreadMoveError", {
  reason: ThreadMoveErrorReason,
  detail: Schema.String,
}) {
  override get message(): string {
    return this.detail;
  }
}
