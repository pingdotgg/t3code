import { posix as path } from "node:path";
import type { Sandbox } from "@daytonaio/sdk";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import {
  collectSecretValues,
  createGitAskPassCommand,
  createGitAuthEnv,
  quoteShellArg,
  runSandboxCommand,
  sanitizeCause,
  sanitizeText,
} from "./git.commands";
import { RepositoryStatusError } from "./git.errors";
import { GitService, type GitServiceShape } from "./git.service";
import {
  createBranchName,
  generateNatureCodename,
  normalizeListedBranchName,
  sanitizeBranchPrefix,
  sanitizeWorktreeSuffix,
} from "./github";
import { RepoService, type RepoServiceShape } from "./repo.service";
import {
  createWorktreeDefaultPath,
  type CreateWorktreeOptions,
  type PreparedWorktree,
  type RemoveWorktreeOptions,
  type WorktreeServiceShape,
  WorktreeService,
} from "./worktree.service";
import {
  InvalidWorktreeOptionsError,
  WorktreeBootstrapError,
  WorktreeCleanupError,
  WorktreeCommandError,
} from "./worktree.errors";

const DEFAULT_BRANCH_PREFIX = "jevin";

interface PreparedWorktreeOptions {
  readonly repository: CreateWorktreeOptions["repository"];
  readonly branchPrefix: string;
  readonly worktreeName: string | undefined;
  readonly worktreePath: string | undefined;
}

function resolvePathInSandbox(sandbox: Sandbox, value: string): Effect.Effect<string> {
  if (path.isAbsolute(value)) {
    return Effect.succeed(value);
  }

  return Effect.tryPromise({
    try: (): Promise<string | undefined> => sandbox.getWorkDir(),
    catch: (cause) => cause,
  }).pipe(
    Effect.orElseSucceed((): string | undefined => undefined),
    Effect.map((workDir) => path.join(workDir ?? "/workspace", value)),
  );
}

function executeWorktreeCommand(
  sandbox: Sandbox,
  command: string,
  cwd: string,
  secretValues: ReadonlyArray<string>,
  env?: Record<string, string>,
): Effect.Effect<void, WorktreeCommandError> {
  return Effect.tryPromise({
    try: () => runSandboxCommand(sandbox, command, cwd, env),
    catch: (cause) =>
      new WorktreeCommandError({
        message: sanitizeText(
          `Failed to run worktree command in "${cwd}" for sandbox ${sandbox.id}.`,
          secretValues,
        ),
        sandboxId: sandbox.id,
        cwd,
        cause: sanitizeCause(cause, secretValues),
      }),
  }).pipe(
    Effect.flatMap((response) => {
      if (response.exitCode === 0) {
        return Effect.void;
      }

      const detail =
        response.result.trim().length > 0
          ? sanitizeText(response.result.trim(), secretValues)
          : "The command exited with a non-zero status.";

      return Effect.fail(
        new WorktreeCommandError({
          message: sanitizeText(
            `Worktree command failed in "${cwd}" for sandbox ${sandbox.id}: ${detail}`,
            secretValues,
          ),
          sandboxId: sandbox.id,
          cwd,
          cause: detail,
        }),
      );
    }),
  );
}

function executeWorktreeCommandForStdout(
  sandbox: Sandbox,
  command: string,
  cwd: string,
  secretValues: ReadonlyArray<string>,
): Effect.Effect<string, WorktreeCommandError> {
  return Effect.tryPromise({
    try: () => runSandboxCommand(sandbox, command, cwd),
    catch: (cause) =>
      new WorktreeCommandError({
        message: sanitizeText(
          `Failed to run worktree command in "${cwd}" for sandbox ${sandbox.id}.`,
          secretValues,
        ),
        sandboxId: sandbox.id,
        cwd,
        cause: sanitizeCause(cause, secretValues),
      }),
  }).pipe(
    Effect.flatMap((response) => {
      if (response.exitCode === 0) {
        return Effect.succeed(response.result.trim());
      }

      const detail =
        response.result.trim().length > 0
          ? sanitizeText(response.result.trim(), secretValues)
          : "The command exited with a non-zero status.";

      return Effect.fail(
        new WorktreeCommandError({
          message: sanitizeText(
            `Worktree command failed in "${cwd}" for sandbox ${sandbox.id}: ${detail}`,
            secretValues,
          ),
          sandboxId: sandbox.id,
          cwd,
          cause: detail,
        }),
      );
    }),
  );
}

function validateCreateWorktreeOptions(
  options: CreateWorktreeOptions,
): Effect.Effect<PreparedWorktreeOptions, InvalidWorktreeOptionsError> {
  const branchPrefix = sanitizeBranchPrefix(options.branchPrefix ?? DEFAULT_BRANCH_PREFIX);
  const worktreeName = options.worktreeName?.trim();

  if ((options.branchPrefix ?? DEFAULT_BRANCH_PREFIX).includes("/")) {
    return Effect.fail(
      new InvalidWorktreeOptionsError({
        message: 'Worktree branch prefix must not include "/".',
      }),
    );
  }

  if (branchPrefix.length === 0) {
    return Effect.fail(
      new InvalidWorktreeOptionsError({
        message: "Worktree branch prefix must contain at least one letter or number.",
      }),
    );
  }

  if (worktreeName?.includes("/")) {
    return Effect.fail(
      new InvalidWorktreeOptionsError({
        message: "Worktree name must be a suffix only.",
      }),
    );
  }

  if (worktreeName && sanitizeWorktreeSuffix(worktreeName).length === 0) {
    return Effect.fail(
      new InvalidWorktreeOptionsError({
        message: "Worktree name must contain at least one letter or number after sanitization.",
      }),
    );
  }

  return Effect.succeed({
    repository: options.repository,
    branchPrefix,
    worktreeName,
    worktreePath: options.worktreePath?.trim() || undefined,
  });
}

function chooseHeadBranch(
  existingBranches: ReadonlyArray<string>,
  prefix: string,
  explicitName: string | undefined,
): Effect.Effect<string, InvalidWorktreeOptionsError> {
  const branchNames = new Set<string>();

  for (const branch of existingBranches) {
    for (const normalizedBranch of normalizeListedBranchName(branch)) {
      branchNames.add(normalizedBranch.toLowerCase());
    }
  }

  const explicitSuffix = explicitName ? sanitizeWorktreeSuffix(explicitName) : undefined;
  const attempt = (suffix: string) => {
    const branchName = createBranchName(prefix, suffix);
    return branchNames.has(branchName.toLowerCase()) ? undefined : branchName;
  };

  if (explicitSuffix) {
    const explicitBranch = attempt(explicitSuffix);
    if (!explicitBranch) {
      return Effect.fail(
        new InvalidWorktreeOptionsError({
          message: `Worktree branch "${createBranchName(prefix, explicitSuffix)}" already exists.`,
        }),
      );
    }

    return Effect.succeed(explicitBranch);
  }

  for (let index = 0; index < 12; index += 1) {
    const generatedBranch = attempt(generateNatureCodename());
    if (generatedBranch) {
      return Effect.succeed(generatedBranch);
    }
  }

  return Effect.fail(
    new InvalidWorktreeOptionsError({
      message: "Failed to generate a unique worktree branch name.",
    }),
  );
}

function getCurrentBranchName(
  sandbox: Sandbox,
  worktreePath: string,
  secretValues: ReadonlyArray<string>,
): Effect.Effect<string, WorktreeCommandError> {
  return executeWorktreeCommandForStdout(
    sandbox,
    "git branch --show-current",
    worktreePath,
    secretValues,
  ).pipe(
    Effect.flatMap((branchName) =>
      branchName.length > 0
        ? Effect.succeed(branchName)
        : Effect.fail(
            new WorktreeCommandError({
              message: `Failed to determine the current branch for "${worktreePath}" in sandbox ${sandbox.id}.`,
              sandboxId: sandbox.id,
              cwd: worktreePath,
              cause: branchName,
            }),
          ),
    ),
  );
}

function validateWorktreeStatus(
  sandboxId: string,
  worktreePath: string,
  currentBranch: string,
  headBranch: string,
): Effect.Effect<void, RepositoryStatusError> {
  if (currentBranch === headBranch) {
    return Effect.void;
  }

  return Effect.fail(
    new RepositoryStatusError({
      message: `Expected worktree branch "${headBranch}" but found "${currentBranch}".`,
      sandboxId,
      repoPath: worktreePath,
      cause: currentBranch,
    }),
  );
}

function makeWorktreeService(
  repoService: RepoServiceShape,
  gitService: GitServiceShape,
): WorktreeServiceShape {
  const removeWorktree = (
    options: RemoveWorktreeOptions,
  ): Effect.Effect<
    void,
    WorktreeCleanupError | InvalidWorktreeOptionsError | WorktreeCommandError
  > => {
    const worktreePath = options.worktreePath.trim();

    if (worktreePath.length === 0) {
      return Effect.fail(
        new InvalidWorktreeOptionsError({
          message: "Worktree path is required.",
        }),
      );
    }

    return executeWorktreeCommand(
      options.repository.sandbox,
      `git worktree remove --force ${quoteShellArg(worktreePath)}\ngit worktree prune`,
      options.repository.repoPath,
      collectSecretValues(options.repository.gitAuth),
    ).pipe(
      Effect.mapError((error) =>
        error instanceof InvalidWorktreeOptionsError
          ? error
          : new WorktreeCleanupError({
              message: `Failed to remove worktree "${worktreePath}" from "${options.repository.repoPath}" in sandbox ${options.repository.sandbox.id}.`,
              sandboxId: options.repository.sandbox.id,
              repoPath: options.repository.repoPath,
              cause: error.cause ?? error.message,
            }),
      ),
    );
  };

  return {
    createWorktree(options) {
      return Effect.gen(function* () {
        const preparedOptions = yield* validateCreateWorktreeOptions(options);
        const repository = preparedOptions.repository;
        const secretValues = collectSecretValues(repository.gitAuth);

        yield* repoService.syncRepository(repository);

        const branches = yield* gitService
          .listBranches({
            sandbox: repository.sandbox,
            repoPath: repository.repoPath,
          })
          .pipe(Effect.map((result) => result.branches));

        const headBranch = yield* chooseHeadBranch(
          branches,
          preparedOptions.branchPrefix,
          preparedOptions.worktreeName,
        );

        const worktreeSuffix = headBranch.slice(preparedOptions.branchPrefix.length + 1);
        const worktreePath = yield* resolvePathInSandbox(
          repository.sandbox,
          preparedOptions.worktreePath ??
            createWorktreeDefaultPath(repository.repoKey, worktreeSuffix),
        );

        const addWorktreeCommand = [
          "mkdir -p",
          quoteShellArg(path.dirname(worktreePath)),
          "&& git worktree add -b",
          quoteShellArg(headBranch),
          quoteShellArg(worktreePath),
          quoteShellArg(repository.baseBranch),
        ].join(" ");

        yield* executeWorktreeCommand(
          repository.sandbox,
          addWorktreeCommand,
          repository.repoPath,
          secretValues,
        ).pipe(
          Effect.mapError(
            (error) =>
              new WorktreeBootstrapError({
                message: `Failed to create worktree "${worktreePath}" in sandbox ${repository.sandbox.id}.`,
                sandboxId: repository.sandbox.id,
                repoPath: repository.repoPath,
                cause: error.cause ?? error.message,
              }),
          ),
        );

        const cleanupPartialWorktree = removeWorktree({
          repository,
          worktreePath,
        }).pipe(
          Effect.matchEffect({
            onFailure: () => Effect.void,
            onSuccess: () => Effect.void,
          }),
        );

        yield* Effect.gen(function* () {
          for (const envFile of repository.setup.envFiles) {
            const destinationPath = path.join(worktreePath, envFile.path);
            const copyCommand = `mkdir -p ${quoteShellArg(path.dirname(destinationPath))} && cp ${quoteShellArg(envFile.storagePath)} ${quoteShellArg(destinationPath)}`;
            yield* executeWorktreeCommand(
              repository.sandbox,
              copyCommand,
              repository.repoPath,
              secretValues,
            );
          }

          for (const setupCommand of repository.setup.setupCommands) {
            yield* executeWorktreeCommand(
              repository.sandbox,
              setupCommand,
              worktreePath,
              secretValues,
            );
          }

          const askPassPath = "/tmp/jevin-git-askpass.sh";
          const pushCommand = [
            createGitAskPassCommand(askPassPath),
            `git push -u origin ${quoteShellArg(headBranch)}`,
          ].join("\n");

          yield* executeWorktreeCommand(
            repository.sandbox,
            pushCommand,
            worktreePath,
            secretValues,
            createGitAuthEnv(repository.gitAuth, askPassPath),
          );

          const currentBranch = yield* getCurrentBranchName(
            repository.sandbox,
            worktreePath,
            secretValues,
          );
          yield* validateWorktreeStatus(
            repository.sandbox.id,
            worktreePath,
            currentBranch,
            headBranch,
          );
        }).pipe(
          Effect.matchEffect({
            onFailure: (error) =>
              cleanupPartialWorktree.pipe(
                Effect.matchEffect({
                  onFailure: () =>
                    Effect.fail(
                      new WorktreeBootstrapError({
                        message: `Failed to bootstrap worktree "${worktreePath}" in sandbox ${repository.sandbox.id}.`,
                        sandboxId: repository.sandbox.id,
                        repoPath: repository.repoPath,
                        cause: error.message,
                      }),
                    ),
                  onSuccess: () =>
                    Effect.fail(
                      new WorktreeBootstrapError({
                        message: `Failed to bootstrap worktree "${worktreePath}" in sandbox ${repository.sandbox.id}.`,
                        sandboxId: repository.sandbox.id,
                        repoPath: repository.repoPath,
                        cause: error.message,
                      }),
                    ),
                }),
              ),
            onSuccess: () => Effect.void,
          }),
        );

        return {
          sandbox: repository.sandbox,
          sandboxId: repository.sandbox.id,
          repoPath: repository.repoPath,
          worktreePath,
          baseBranch: repository.baseBranch,
          headBranch,
          githubRepository: repository.githubRepository,
          cleanup: removeWorktree({
            repository,
            worktreePath,
          }).pipe(
            Effect.mapError((error) =>
              error instanceof WorktreeCleanupError
                ? error
                : new WorktreeCleanupError({
                    message: `Failed to remove worktree "${worktreePath}" from sandbox ${repository.sandbox.id}.`,
                    sandboxId: repository.sandbox.id,
                    repoPath: repository.repoPath,
                    cause: error.message,
                  }),
            ),
          ),
        } satisfies PreparedWorktree;
      });
    },
    removeWorktree,
  } satisfies WorktreeServiceShape;
}

export function makeWorktreeServiceLayer(): Layer.Layer<
  WorktreeService,
  never,
  RepoService | GitService
> {
  return Layer.effect(
    WorktreeService,
    Effect.gen(function* () {
      const repoService = yield* RepoService;
      const gitService = yield* GitService;
      return makeWorktreeService(repoService, gitService);
    }),
  );
}

export const WorktreeServiceLive = makeWorktreeServiceLayer;
