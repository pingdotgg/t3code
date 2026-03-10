import * as Effect from "effect/Effect";

import {
  createRepoKey,
  createRepositoryStatePaths,
  parseGitHubRepository,
} from "../services/git/github";
import type { DaytonaClientShape } from "../client";
import type { GitServiceShape } from "../services/git";

export interface SandboxCatalogRepository {
  readonly repoUrl: string;
  readonly owner: string;
  readonly repo: string;
  readonly repoPath: string;
  readonly baseBranch: string;
  readonly repoKey: string;
  readonly statePath: string;
  readonly envRoot: string;
  readonly worktrees: readonly {
    readonly path: string;
    readonly branch: string;
  }[];
}

async function executeCommand(
  sandbox: Awaited<ReturnType<DaytonaClientShape["client"]["get"]>>,
  command: string,
  cwd: string,
): Promise<string> {
  const result = await sandbox.process.executeCommand(command, cwd);
  if (result.exitCode !== 0) {
    return "";
  }

  return result.result.trim();
}

async function readBaseBranch(
  sandbox: Awaited<ReturnType<DaytonaClientShape["client"]["get"]>>,
  repoPath: string,
): Promise<string> {
  const symbolic = await executeCommand(
    sandbox,
    "git symbolic-ref --quiet refs/remotes/origin/HEAD 2>/dev/null | sed 's@^refs/remotes/origin/@@'",
    repoPath,
  );
  if (symbolic.length > 0) {
    return symbolic;
  }

  const current = await executeCommand(sandbox, "git rev-parse --abbrev-ref HEAD", repoPath);
  return current.length > 0 ? current : "main";
}

export class SandboxCatalogManager {
  constructor(
    private readonly daytonaClient: DaytonaClientShape,
    private readonly gitService: GitServiceShape,
  ) {}

  async listRepositories(sandboxId: string): Promise<readonly SandboxCatalogRepository[]> {
    const sandbox = await this.daytonaClient.client.get(sandboxId);
    const discovered = await Effect.runPromise(this.gitService.discoverRepositoryPaths(sandbox));

    const repositories = await Promise.all(
      discovered.repos.map(async (repoPath) => {
        const repoUrl = await executeCommand(sandbox, "git remote get-url origin", repoPath);
        if (repoUrl.length === 0) {
          return null;
        }

        const githubRepository = await Effect.runPromise(parseGitHubRepository(repoUrl)).catch(
          () => null,
        );
        if (!githubRepository) {
          return null;
        }

        const worktrees = await Effect.runPromise(
          this.gitService.listWorktrees({
            sandbox,
            repoPath,
          }),
        );

        const repoKey = createRepoKey(githubRepository);
        const statePaths = createRepositoryStatePaths(repoKey);

        return {
          repoUrl,
          owner: githubRepository.owner,
          repo: githubRepository.repo,
          repoPath,
          baseBranch: await readBaseBranch(sandbox, repoPath),
          repoKey,
          statePath: statePaths.statePath,
          envRoot: statePaths.envRoot,
          worktrees: worktrees.map((worktree) => ({
            path: worktree.path,
            branch: worktree.branch ?? "HEAD",
          })),
        } satisfies SandboxCatalogRepository;
      }),
    );

    return repositories.reduce<SandboxCatalogRepository[]>((current, entry) => {
      if (entry) {
        current.push(entry);
      }
      return current;
    }, []);
  }
}
