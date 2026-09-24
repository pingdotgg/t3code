import * as Encoding from "effect/Encoding";
import { CheckpointRef, ProjectId, type ThreadId } from "@t3tools/contracts";

const CHECKPOINT_REFS_PREFIX = "refs/t3/checkpoints";

export function checkpointRefPrefixForThread(threadId: ThreadId): string {
  return `${CHECKPOINT_REFS_PREFIX}/${Encoding.encodeBase64Url(threadId)}/`;
}

export function checkpointRefForThreadTurn(threadId: ThreadId, turnCount: number): CheckpointRef {
  return CheckpointRef.make(`${checkpointRefPrefixForThread(threadId)}turn/${turnCount}`);
}

export function resolveThreadWorkspaceCwd(input: {
  readonly thread: {
    readonly projectId: ProjectId;
    readonly worktreePath: string | null;
  };
  readonly projects: ReadonlyArray<{
    readonly id: ProjectId;
    readonly workspaceRoot: string;
  }>;
}): string | undefined {
  const worktreeCwd = input.thread.worktreePath ?? undefined;
  if (worktreeCwd) {
    return worktreeCwd;
  }

  return input.projects.find((project) => project.id === input.thread.projectId)?.workspaceRoot;
}
