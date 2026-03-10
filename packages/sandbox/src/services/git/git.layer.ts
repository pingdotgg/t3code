import { posix as path } from "node:path";
import type { Sandbox } from "@daytonaio/sdk";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { SandboxService, type SandboxServiceShape } from "../sandbox";
import {
  collectSecretValues,
  runSandboxCommand,
  sanitizeCause,
  sanitizeText,
} from "./git.commands";
import {
  GitCleanupError,
  GitCloneError,
  GitSandboxCreationError,
  GitStartupCleanupError,
  InvalidGitCloneOptionsError,
  RepositoryBranchesError,
  RepositoryDiscoveryError,
  RepositoryStatusError,
  RepositoryWorktreesError,
} from "./git.errors";
import type {
  CloneRepositoryOptions,
  ClonedRepositorySession,
  GitCloneAuth,
  GitRepositoryBranches,
  GitRepositoryPaths,
  GitRepositoryStatus,
  GitServiceShape,
  GitWorktreeEntry,
  RepositoryRef,
} from "./git.service";
import { GitService } from "./git.service";
import {
  parseGitBranchesOutput,
  parseGitStatusPorcelain,
  parseGitWorktreeList,
  parseRepositoryPathsOutput,
} from "./git.status";

interface GitServiceOptions {
  readonly sandboxService: SandboxServiceShape;
}

interface PreparedCloneOptions {
  readonly url: string;
  readonly clonePath: string;
  readonly branch: string | undefined;
  readonly commitId: string | undefined;
  readonly auth: GitCloneAuth | undefined;
  readonly sandboxName: string | undefined;
}

function createSandboxName(customName?: string): string {
  if (customName) {
    return customName;
  }

  return `jevin-git-${Date.now()}`;
}

function hasEmbeddedCredentials(url: string): boolean {
  try {
    const parsedUrl = new URL(url);
    return (
      (parsedUrl.protocol === "http:" || parsedUrl.protocol === "https:") &&
      (parsedUrl.username.length > 0 || parsedUrl.password.length > 0)
    );
  } catch {
    return false;
  }
}

function deriveRepositoryName(url: string): string {
  try {
    const parsedUrl = new URL(url);
    const segments = parsedUrl.pathname.split("/").filter((segment) => segment.length > 0);
    const repositorySegment = segments[segments.length - 1];
    if (repositorySegment) {
      const normalizedSegment = repositorySegment.endsWith(".git")
        ? repositorySegment.slice(0, -4)
        : repositorySegment;

      if (normalizedSegment.length > 0) {
        return normalizedSegment;
      }
    }
  } catch {
    const scpLikeSeparatorIndex = url.indexOf(":");
    if (scpLikeSeparatorIndex >= 0) {
      const repoPath = url.slice(scpLikeSeparatorIndex + 1);
      const segments = repoPath.split("/").filter((segment) => segment.length > 0);
      const repositorySegment = segments[segments.length - 1];
      if (repositorySegment) {
        const normalizedSegment = repositorySegment.endsWith(".git")
          ? repositorySegment.slice(0, -4)
          : repositorySegment;

        if (normalizedSegment.length > 0) {
          return normalizedSegment;
        }
      }
    }
  }

  return "repo";
}

function prepareCloneOptions(
  options: CloneRepositoryOptions,
): Effect.Effect<PreparedCloneOptions, InvalidGitCloneOptionsError> {
  return Effect.gen(function* () {
    if (options.branch && options.commitId) {
      return yield* Effect.fail(
        new InvalidGitCloneOptionsError({
          message: "Specify either `branch` or `commitId`, but not both.",
        }),
      );
    }

    if (hasEmbeddedCredentials(options.url)) {
      return yield* Effect.fail(
        new InvalidGitCloneOptionsError({
          message: "Repository URLs must not contain embedded credentials. Pass auth separately.",
        }),
      );
    }

    const clonePath = options.path?.trim() || `repos/${deriveRepositoryName(options.url)}`;

    if (clonePath.length === 0) {
      return yield* Effect.fail(
        new InvalidGitCloneOptionsError({
          message: "Clone path must not be empty.",
        }),
      );
    }

    if (options.auth) {
      const username = options.auth.username.trim();
      const password = options.auth.password;

      if (username.length === 0 || password.length === 0) {
        return yield* Effect.fail(
          new InvalidGitCloneOptionsError({
            message: "Clone auth requires both a non-empty username and password.",
          }),
        );
      }

      return {
        url: options.url,
        clonePath,
        branch: options.branch,
        commitId: options.commitId,
        auth: {
          username,
          password,
        },
        sandboxName: options.sandboxName,
      } satisfies PreparedCloneOptions;
    }

    return {
      url: options.url,
      clonePath,
      branch: options.branch,
      commitId: options.commitId,
      auth: undefined,
      sandboxName: options.sandboxName,
    } satisfies PreparedCloneOptions;
  });
}

function createCleanupEffect(
  sandbox: Sandbox,
  sandboxService: SandboxServiceShape,
): Effect.Effect<void, GitCleanupError> {
  let isCleanedUp = false;

  return Effect.suspend(() => {
    if (isCleanedUp) {
      return Effect.void;
    }

    isCleanedUp = true;
    return sandboxService.deleteSandbox(sandbox).pipe(
      Effect.mapError(
        (cause) =>
          new GitCleanupError({
            message: `Failed to delete sandbox ${sandbox.id}: ${cause.message}`,
          }),
      ),
    );
  });
}

function cleanupAfterStartupFailure<E extends { readonly message: string }>(
  effect: Effect.Effect<void, E>,
  cleanup: Effect.Effect<void, GitCleanupError>,
): Effect.Effect<void, E | GitStartupCleanupError> {
  return effect.pipe(
    Effect.matchEffect({
      onFailure: (error) =>
        cleanup.pipe(
          Effect.matchEffect({
            onFailure: (cleanupError) =>
              Effect.fail(
                new GitStartupCleanupError({
                  message: `${error.message}\n${cleanupError.message}`,
                  cause: error,
                }),
              ),
            onSuccess: () => Effect.fail(error),
          }),
        ),
      onSuccess: () => Effect.void,
    }),
  );
}

function resolveRepositoryPath(sandbox: Sandbox, clonePath: string): Effect.Effect<string> {
  if (path.isAbsolute(clonePath)) {
    return Effect.succeed(clonePath);
  }

  return Effect.tryPromise({
    try: (): Promise<string | undefined> => sandbox.getWorkDir(),
    catch: (cause) => cause,
  }).pipe(
    Effect.orElseSucceed((): string | undefined => undefined),
    Effect.map((workDir) => path.join(workDir ?? "/workspace", clonePath)),
  );
}

function createStatusEffect(
  repository: RepositoryRef,
  secretValues: ReadonlyArray<string>,
): Effect.Effect<GitRepositoryStatus, RepositoryStatusError> {
  return Effect.tryPromise({
    try: () =>
      runSandboxCommand(
        repository.sandbox,
        "git status --porcelain=v2 --branch",
        repository.repoPath,
      ),
    catch: (cause) =>
      new RepositoryStatusError({
        message: sanitizeText(
          `Failed to read Git status for "${repository.repoPath}" in sandbox ${repository.sandbox.id}.`,
          secretValues,
        ),
        sandboxId: repository.sandbox.id,
        repoPath: repository.repoPath,
        cause: sanitizeCause(cause, secretValues),
      }),
  }).pipe(
    Effect.flatMap((response) => {
      if (response.exitCode !== 0) {
        const detail =
          response.result.trim().length > 0
            ? sanitizeText(response.result.trim(), secretValues)
            : "The command exited with a non-zero status.";

        return Effect.fail(
          new RepositoryStatusError({
            message: sanitizeText(
              `Failed to read Git status for "${repository.repoPath}" in sandbox ${repository.sandbox.id}: ${detail}`,
              secretValues,
            ),
            sandboxId: repository.sandbox.id,
            repoPath: repository.repoPath,
            cause: detail,
          }),
        );
      }

      return Effect.try({
        try: () => parseGitStatusPorcelain(response.result),
        catch: (cause) =>
          new RepositoryStatusError({
            message: sanitizeText(
              `Failed to parse Git status for "${repository.repoPath}" in sandbox ${repository.sandbox.id}.`,
              secretValues,
            ),
            sandboxId: repository.sandbox.id,
            repoPath: repository.repoPath,
            cause: sanitizeCause(cause, secretValues),
          }),
      });
    }),
  );
}

function createBranchesEffect(
  repository: RepositoryRef,
  secretValues: ReadonlyArray<string>,
): Effect.Effect<GitRepositoryBranches, RepositoryBranchesError> {
  return Effect.tryPromise({
    try: () =>
      runSandboxCommand(
        repository.sandbox,
        "git for-each-ref --sort=refname --format='%(refname:short)' refs/heads refs/remotes",
        repository.repoPath,
      ),
    catch: (cause) =>
      new RepositoryBranchesError({
        message: sanitizeText(
          `Failed to list Git branches for "${repository.repoPath}" in sandbox ${repository.sandbox.id}.`,
          secretValues,
        ),
        sandboxId: repository.sandbox.id,
        repoPath: repository.repoPath,
        cause: sanitizeCause(cause, secretValues),
      }),
  }).pipe(
    Effect.flatMap((response) => {
      if (response.exitCode !== 0) {
        const detail =
          response.result.trim().length > 0
            ? sanitizeText(response.result.trim(), secretValues)
            : "The command exited with a non-zero status.";

        return Effect.fail(
          new RepositoryBranchesError({
            message: sanitizeText(
              `Failed to list Git branches for "${repository.repoPath}" in sandbox ${repository.sandbox.id}: ${detail}`,
              secretValues,
            ),
            sandboxId: repository.sandbox.id,
            repoPath: repository.repoPath,
            cause: detail,
          }),
        );
      }

      return Effect.try({
        try: () => parseGitBranchesOutput(response.result),
        catch: (cause) =>
          new RepositoryBranchesError({
            message: sanitizeText(
              `Failed to parse Git branches for "${repository.repoPath}" in sandbox ${repository.sandbox.id}.`,
              secretValues,
            ),
            sandboxId: repository.sandbox.id,
            repoPath: repository.repoPath,
            cause: sanitizeCause(cause, secretValues),
          }),
      });
    }),
  );
}

function createRepositoryDiscoveryEffect(
  sandbox: Sandbox,
): Effect.Effect<GitRepositoryPaths, RepositoryDiscoveryError> {
  return Effect.all([
    Effect.tryPromise({
      try: () =>
        runSandboxCommand(
          sandbox,
          "if [ -d /workspace/repos ]; then find /workspace/repos -name .git -exec dirname {} \\; 2>/dev/null | sort -u; else true; fi",
        ),
      catch: (cause) =>
        new RepositoryDiscoveryError({
          message: `Failed to discover repositories in sandbox ${sandbox.id}.`,
          sandboxId: sandbox.id,
          cause,
        }),
    }),
    Effect.tryPromise({
      try: () =>
        runSandboxCommand(
          sandbox,
          "if [ -d /workspace/worktrees ]; then find /workspace/worktrees -name .git -exec dirname {} \\; 2>/dev/null | sort -u; else true; fi",
        ),
      catch: (cause) =>
        new RepositoryDiscoveryError({
          message: `Failed to discover worktrees in sandbox ${sandbox.id}.`,
          sandboxId: sandbox.id,
          cause,
        }),
    }),
  ]).pipe(
    Effect.flatMap(([repoResponse, worktreeResponse]) => {
      if (repoResponse.exitCode !== 0 || worktreeResponse.exitCode !== 0) {
        const detail =
          [repoResponse.result, worktreeResponse.result].join("\n").trim() ||
          "The command exited with a non-zero status.";

        return Effect.fail(
          new RepositoryDiscoveryError({
            message: `Failed to discover Git paths in sandbox ${sandbox.id}: ${detail}`,
            sandboxId: sandbox.id,
            cause: detail,
          }),
        );
      }

      return Effect.try({
        try: () => parseRepositoryPathsOutput(repoResponse.result, worktreeResponse.result),
        catch: (cause) =>
          new RepositoryDiscoveryError({
            message: `Failed to parse discovered Git paths in sandbox ${sandbox.id}.`,
            sandboxId: sandbox.id,
            cause,
          }),
      });
    }),
  );
}

function createWorktreesEffect(
  repository: RepositoryRef,
  secretValues: ReadonlyArray<string>,
): Effect.Effect<readonly GitWorktreeEntry[], RepositoryWorktreesError> {
  return Effect.tryPromise({
    try: () =>
      runSandboxCommand(repository.sandbox, "git worktree list --porcelain", repository.repoPath),
    catch: (cause) =>
      new RepositoryWorktreesError({
        message: sanitizeText(
          `Failed to list Git worktrees for "${repository.repoPath}" in sandbox ${repository.sandbox.id}.`,
          secretValues,
        ),
        sandboxId: repository.sandbox.id,
        repoPath: repository.repoPath,
        cause: sanitizeCause(cause, secretValues),
      }),
  }).pipe(
    Effect.flatMap((response) => {
      if (response.exitCode !== 0) {
        const detail =
          response.result.trim().length > 0
            ? sanitizeText(response.result.trim(), secretValues)
            : "The command exited with a non-zero status.";

        return Effect.fail(
          new RepositoryWorktreesError({
            message: sanitizeText(
              `Failed to list Git worktrees for "${repository.repoPath}" in sandbox ${repository.sandbox.id}: ${detail}`,
              secretValues,
            ),
            sandboxId: repository.sandbox.id,
            repoPath: repository.repoPath,
            cause: detail,
          }),
        );
      }

      return Effect.try({
        try: () => parseGitWorktreeList(response.result),
        catch: (cause) =>
          new RepositoryWorktreesError({
            message: sanitizeText(
              `Failed to parse Git worktrees for "${repository.repoPath}" in sandbox ${repository.sandbox.id}.`,
              secretValues,
            ),
            sandboxId: repository.sandbox.id,
            repoPath: repository.repoPath,
            cause: sanitizeCause(cause, secretValues),
          }),
      });
    }),
  );
}

export function makeGitService(options: GitServiceOptions): GitServiceShape {
  const sandboxService = options.sandboxService;

  return {
    cloneRepository(cloneOptions) {
      return Effect.gen(function* () {
        const preparedOptions = yield* prepareCloneOptions(cloneOptions);
        const secretValues = collectSecretValues(preparedOptions.auth);
        const sandbox = yield* sandboxService
          .createSandbox({
            sandboxName: createSandboxName(preparedOptions.sandboxName),
            labels: {
              capability: "git",
            },
          })
          .pipe(
            Effect.mapError(
              (cause) =>
                new GitSandboxCreationError({
                  message: "Failed to create the Daytona sandbox for Git operations.",
                  cause: cause.cause ?? cause.message,
                }),
            ),
          );

        const cleanup = createCleanupEffect(sandbox, sandboxService);

        yield* cleanupAfterStartupFailure(
          Effect.tryPromise({
            try: () =>
              sandbox.git.clone(
                preparedOptions.url,
                preparedOptions.clonePath,
                preparedOptions.branch,
                preparedOptions.commitId,
                preparedOptions.auth?.username,
                preparedOptions.auth?.password,
              ),
            catch: (cause) =>
              new GitCloneError({
                message: sanitizeText(
                  `Failed to clone repository into "${preparedOptions.clonePath}" in sandbox ${sandbox.id}.`,
                  secretValues,
                ),
                sandboxId: sandbox.id,
                cause: sanitizeCause(cause, secretValues),
              }),
          }),
          cleanup,
        );

        yield* cleanupAfterStartupFailure(
          createStatusEffect(
            {
              sandbox,
              repoPath: preparedOptions.clonePath,
            },
            secretValues,
          ).pipe(Effect.asVoid),
          cleanup,
        );

        const repoPath = yield* resolveRepositoryPath(sandbox, preparedOptions.clonePath);

        return {
          sandbox,
          sandboxId: sandbox.id,
          repoPath,
          cleanup,
        } satisfies ClonedRepositorySession;
      });
    },
    discoverRepositoryPaths(sandbox) {
      return createRepositoryDiscoveryEffect(sandbox);
    },
    getRepositoryStatus(repository) {
      return createStatusEffect(repository, []);
    },
    listBranches(repository) {
      return createBranchesEffect(repository, []);
    },
    listWorktrees(repository) {
      return createWorktreesEffect(repository, []);
    },
  } satisfies GitServiceShape;
}

export function makeGitServiceLayer(): Layer.Layer<GitService, never, SandboxService> {
  return Layer.effect(
    GitService,
    Effect.gen(function* () {
      const sandboxService = yield* SandboxService;

      return makeGitService({
        sandboxService,
      });
    }),
  );
}

export const GitServiceLive = makeGitServiceLayer;
