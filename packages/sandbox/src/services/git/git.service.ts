import type { Sandbox } from "@daytonaio/sdk";
import type * as Effect from "effect/Effect";
import * as ServiceMap from "effect/ServiceMap";

import type {
  CloneRepositoryError,
  GitCleanupError,
  RepositoryBranchesError,
  RepositoryDiscoveryError,
  RepositoryStatusError,
  RepositoryWorktreesError,
} from "./git.errors";

export type GitCloneAuth = {
  readonly username: string;
  readonly password: string;
};

export interface CloneRepositoryOptions {
  readonly url: string;
  readonly auth?: GitCloneAuth;
  readonly path?: string;
  readonly branch?: string;
  readonly commitId?: string;
  readonly sandboxName?: string;
}

export interface RepositoryRef {
  readonly sandbox: Sandbox;
  readonly repoPath: string;
}

export interface ClonedRepositorySession extends RepositoryRef {
  readonly sandboxId: string;
  readonly cleanup: Effect.Effect<void, GitCleanupError>;
}

export type GitFileStatusValue =
  | "Unmodified"
  | "Untracked"
  | "Modified"
  | "Added"
  | "Deleted"
  | "Renamed"
  | "Copied"
  | "Updated but unmerged";

export interface GitFileStatus {
  readonly extra: string;
  readonly name: string;
  readonly staging: GitFileStatusValue;
  readonly worktree: GitFileStatusValue;
}

export interface GitRepositoryStatus {
  readonly currentBranch: string;
  readonly ahead?: number;
  readonly behind?: number;
  readonly branchPublished?: boolean;
  readonly fileStatus: GitFileStatus[];
}

export interface GitRepositoryBranches {
  readonly branches: string[];
}

export interface GitRepositoryPaths {
  readonly repos: string[];
  readonly worktrees: string[];
}

export interface GitWorktreeEntry {
  readonly path: string;
  readonly head: string;
  readonly branch?: string;
  readonly bare: boolean;
  readonly detached: boolean;
  readonly locked?: string;
  readonly prunable?: string;
}

export interface GitServiceShape {
  readonly cloneRepository: (
    options: CloneRepositoryOptions,
  ) => Effect.Effect<ClonedRepositorySession, CloneRepositoryError>;
  readonly discoverRepositoryPaths: (
    sandbox: Sandbox,
  ) => Effect.Effect<GitRepositoryPaths, RepositoryDiscoveryError>;
  readonly getRepositoryStatus: (
    repository: RepositoryRef,
  ) => Effect.Effect<GitRepositoryStatus, RepositoryStatusError>;
  readonly listBranches: (
    repository: RepositoryRef,
  ) => Effect.Effect<GitRepositoryBranches, RepositoryBranchesError>;
  readonly listWorktrees: (
    repository: RepositoryRef,
  ) => Effect.Effect<readonly GitWorktreeEntry[], RepositoryWorktreesError>;
}

export class GitService extends ServiceMap.Service<GitService, GitServiceShape>()(
  "@repo/sandbox/services/git/GitService",
) {}
