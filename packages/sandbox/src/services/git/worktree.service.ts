import type * as Effect from "effect/Effect";
import * as ServiceMap from "effect/ServiceMap";

import type {
  CreateWorktreeError,
  RemoveWorktreeError,
  WorktreeCleanupError,
} from "./worktree.errors";
import type { GitHubRepository } from "./repo.service";
import type { PreparedRepository } from "./repo.service";

export interface CreateWorktreeOptions {
  readonly repository: PreparedRepository;
  readonly branchPrefix?: string;
  readonly worktreeName?: string;
  readonly worktreePath?: string;
}

export interface RemoveWorktreeOptions {
  readonly repository: PreparedRepository;
  readonly worktreePath: string;
}

export interface PreparedWorktree {
  readonly sandbox: PreparedRepository["sandbox"];
  readonly sandboxId: string;
  readonly repoPath: string;
  readonly worktreePath: string;
  readonly baseBranch: string;
  readonly headBranch: string;
  readonly githubRepository: GitHubRepository;
  readonly cleanup: Effect.Effect<void, WorktreeCleanupError>;
}

export interface WorktreeServiceShape {
  readonly createWorktree: (
    options: CreateWorktreeOptions,
  ) => Effect.Effect<PreparedWorktree, CreateWorktreeError>;
  readonly removeWorktree: (
    options: RemoveWorktreeOptions,
  ) => Effect.Effect<void, RemoveWorktreeError>;
}

export function createWorktreeDefaultPath(repoKey: string, suffix: string): string {
  return `/workspace/worktrees/${repoKey}/${suffix}`;
}

export function createBootstrapCommandPlan(
  envFiles: ReadonlyArray<{ readonly sourcePath: string; readonly targetPath: string }>,
  setupCommands: ReadonlyArray<string>,
): readonly string[] {
  const commands = envFiles.map(
    (envFile) =>
      `mkdir -p ${quote(pathDirname(envFile.targetPath))} && cp ${quote(envFile.sourcePath)} ${quote(envFile.targetPath)}`,
  );

  return [...commands, ...setupCommands];
}

function quote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function pathDirname(value: string): string {
  const slashIndex = value.lastIndexOf("/");
  return slashIndex <= 0 ? "." : value.slice(0, slashIndex);
}

export class WorktreeService extends ServiceMap.Service<WorktreeService, WorktreeServiceShape>()(
  "@repo/sandbox/services/git/WorktreeService",
) {}
