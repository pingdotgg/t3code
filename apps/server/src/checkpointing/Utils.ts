import * as Encoding from "effect/Encoding";
import {
  CHAT_PROJECT_ID,
  chatThreadWorkspacePath,
  CheckpointRef,
  ProjectId,
  type ThreadId,
} from "@t3tools/contracts";

const CHECKPOINT_REFS_PREFIX = "refs/t3/checkpoints";

export function checkpointRefForThreadTurn(threadId: ThreadId, turnCount: number): CheckpointRef {
  return CheckpointRef.make(
    `${CHECKPOINT_REFS_PREFIX}/${Encoding.encodeBase64Url(threadId)}/turn/${turnCount}`,
  );
}

export function resolveThreadWorkspaceCwd(input: {
  readonly thread: {
    readonly id: ThreadId;
    readonly projectId: ProjectId;
    readonly worktreePath: string | null;
  };
  readonly projects: ReadonlyArray<{
    readonly id: ProjectId;
    readonly workspaceRoot: string;
  }>;
}): string | undefined {
  const project = input.projects.find((project) => project.id === input.thread.projectId);
  if (input.thread.projectId === CHAT_PROJECT_ID) {
    return project ? chatThreadWorkspacePath(project.workspaceRoot, input.thread.id) : undefined;
  }
  const worktreeCwd = input.thread.worktreePath ?? undefined;
  if (worktreeCwd) {
    return worktreeCwd;
  }

  return project?.workspaceRoot;
}
