import { posix as path } from "node:path";
import type { Sandbox } from "@daytonaio/sdk";
import type * as Effect from "effect/Effect";
import * as ServiceMap from "effect/ServiceMap";

import type { GitCloneAuth } from "./git.service";
import type {
  GitHubRepositoryCleanupError,
  PrepareRepositoryError,
  SyncRepositoryError,
} from "./repo.errors";

export interface GitHubRepository {
  readonly owner: string;
  readonly repo: string;
}

export interface GitHubRepositoryEnvFile {
  readonly path: string;
  readonly content: string;
}

export interface GitHubRepositorySetup {
  readonly setupCommands: readonly string[];
  readonly envFiles: readonly GitHubRepositoryEnvFile[];
}

export interface PreparedGitHubRepositorySetup {
  readonly setupCommands: readonly string[];
  readonly envFiles: readonly {
    readonly path: string;
    readonly storagePath: string;
  }[];
}

export interface PrepareRepositoryOptions {
  readonly sandbox: Sandbox;
  readonly url: string;
  readonly baseBranch: string;
  readonly gitAuth: GitCloneAuth;
  readonly githubToken?: string;
  readonly repoPath?: string;
  readonly setup?: GitHubRepositorySetup;
}

export interface PreparedRepository {
  readonly sandbox: Sandbox;
  readonly sandboxId: string;
  readonly repoPath: string;
  readonly baseBranch: string;
  readonly githubRepository: GitHubRepository;
  readonly repoKey: string;
  readonly statePath: string;
  readonly envRoot: string;
  readonly gitAuth: GitCloneAuth;
  readonly setup: PreparedGitHubRepositorySetup;
  readonly cleanup: Effect.Effect<void, GitHubRepositoryCleanupError>;
}

export interface RepoServiceShape {
  readonly prepareRepository: (
    options: PrepareRepositoryOptions,
  ) => Effect.Effect<PreparedRepository, PrepareRepositoryError>;
  readonly syncRepository: (
    repository: PreparedRepository,
  ) => Effect.Effect<void, SyncRepositoryError>;
  readonly cleanupRepository: (
    repository: PreparedRepository,
  ) => Effect.Effect<void, GitHubRepositoryCleanupError>;
}

export interface StoredRepositoryState {
  readonly url: string;
  readonly baseBranch: string;
  readonly repoPath: string;
  readonly repoKey: string;
  readonly githubRepository: GitHubRepository;
  readonly setupCommands: readonly string[];
  readonly envFiles: readonly {
    readonly path: string;
    readonly storagePath: string;
  }[];
}

export function createRepositorySyncCommands(baseBranch: string): readonly string[] {
  return [
    `git fetch origin --prune`,
    `git worktree prune`,
    `git checkout ${quote(baseBranch)}`,
    `git reset --hard ${quote(`origin/${baseBranch}`)}`,
    "git clean -ffd",
  ];
}

export function createManagedWorktreeRoot(repoKey: string): string {
  return path.join("/workspace/worktrees", repoKey);
}

export function quote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export class RepoService extends ServiceMap.Service<RepoService, RepoServiceShape>()(
  "@repo/sandbox/services/git/RepoService",
) {}
