import { Buffer } from "node:buffer";
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
import {
  createRepoKey,
  createRepositoryStatePaths,
  parseGitHubRepository,
  repositoryLabel,
} from "./github";
import { normalizeRepositorySetup } from "./repo.helpers";
import {
  GitHubRepositoryParseError,
  InvalidRepositorySetupError,
  RepositoryCleanupError,
  RepositoryCommandError,
  RepositoryIdentityMismatchError,
  RepositoryStateError,
  RepositorySyncError,
} from "./repo.errors";
import {
  createManagedWorktreeRoot,
  createRepositorySyncCommands,
  type PrepareRepositoryOptions,
  type PreparedGitHubRepositorySetup,
  type PreparedRepository,
  type RepoServiceShape,
  type StoredRepositoryState,
  RepoService,
} from "./repo.service";

interface NormalizedRepositorySetup {
  readonly setupCommands: readonly string[];
  readonly envFiles: readonly {
    readonly path: string;
    readonly content: string;
  }[];
}

interface PreparedRepositoryOptions {
  readonly sandbox: Sandbox;
  readonly url: string;
  readonly baseBranch: string;
  readonly repoPath: string | undefined;
  readonly gitAuth: {
    readonly username: string;
    readonly password: string;
  };
  readonly setup: NormalizedRepositorySetup;
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

function createRepositoryCommandError(
  sandboxId: string,
  cwd: string,
  message: string,
  cause: unknown,
): RepositoryCommandError {
  return new RepositoryCommandError({
    message,
    sandboxId,
    cwd,
    cause,
  });
}

function executeRepositoryCommand(
  sandbox: Sandbox,
  command: string,
  cwd: string,
  secretValues: ReadonlyArray<string>,
  env?: Record<string, string>,
): Effect.Effect<void, RepositoryCommandError> {
  return Effect.tryPromise({
    try: () => runSandboxCommand(sandbox, command, cwd, env),
    catch: (cause) =>
      createRepositoryCommandError(
        sandbox.id,
        cwd,
        sanitizeText(
          `Failed to run repository command in "${cwd}" for sandbox ${sandbox.id}.`,
          secretValues,
        ),
        sanitizeCause(cause, secretValues),
      ),
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
        createRepositoryCommandError(
          sandbox.id,
          cwd,
          sanitizeText(
            `Repository command failed in "${cwd}" for sandbox ${sandbox.id}: ${detail}`,
            secretValues,
          ),
          detail,
        ),
      );
    }),
  );
}

function executeRepositoryCommandForStdout(
  sandbox: Sandbox,
  command: string,
  cwd: string,
  secretValues: ReadonlyArray<string>,
  env?: Record<string, string>,
): Effect.Effect<string, RepositoryCommandError> {
  return Effect.tryPromise({
    try: () => runSandboxCommand(sandbox, command, cwd, env),
    catch: (cause) =>
      createRepositoryCommandError(
        sandbox.id,
        cwd,
        sanitizeText(
          `Failed to run repository command in "${cwd}" for sandbox ${sandbox.id}.`,
          secretValues,
        ),
        sanitizeCause(cause, secretValues),
      ),
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
        createRepositoryCommandError(
          sandbox.id,
          cwd,
          sanitizeText(
            `Repository command failed in "${cwd}" for sandbox ${sandbox.id}: ${detail}`,
            secretValues,
          ),
          detail,
        ),
      );
    }),
  );
}

function validatePrepareRepositoryOptions(
  options: PrepareRepositoryOptions,
): Effect.Effect<PreparedRepositoryOptions, InvalidRepositorySetupError> {
  return Effect.gen(function* () {
    const url = options.url.trim();
    const baseBranch = options.baseBranch.trim();
    const username = options.gitAuth.username.trim();
    const password = options.gitAuth.password;

    if (url.length === 0) {
      return yield* Effect.fail(
        new InvalidRepositorySetupError({
          message: "Repository URL is required.",
        }),
      );
    }

    if (baseBranch.length === 0) {
      return yield* Effect.fail(
        new InvalidRepositorySetupError({
          message: "Base branch is required.",
        }),
      );
    }

    if (username.length === 0 || password.length === 0) {
      return yield* Effect.fail(
        new InvalidRepositorySetupError({
          message: "Git auth requires both a non-empty username and password.",
        }),
      );
    }

    const setup = yield* normalizeRepositorySetup(options.setup);

    return {
      sandbox: options.sandbox,
      url,
      baseBranch,
      repoPath: options.repoPath?.trim() || undefined,
      gitAuth: {
        username,
        password,
      },
      setup,
    } satisfies PreparedRepositoryOptions;
  });
}

function repositoryExists(
  sandbox: Sandbox,
  repoPath: string,
  secretValues: ReadonlyArray<string>,
): Effect.Effect<boolean, RepositoryCommandError> {
  return executeRepositoryCommand(
    sandbox,
    `[ -d ${quoteShellArg(path.join(repoPath, ".git"))} ]`,
    repoPath,
    secretValues,
  ).pipe(
    Effect.as(true),
    Effect.catchTag("RepositoryCommandError", () => Effect.succeed(false)),
  );
}

function readOriginUrl(
  sandbox: Sandbox,
  repoPath: string,
  secretValues: ReadonlyArray<string>,
): Effect.Effect<string, RepositoryCommandError> {
  return executeRepositoryCommandForStdout(
    sandbox,
    "git remote get-url origin",
    repoPath,
    secretValues,
  );
}

function persistRepositoryState(
  repository: Omit<PreparedRepository, "cleanup">,
): Effect.Effect<void, RepositoryStateError> {
  return Effect.gen(function* () {
    const state = {
      url: `https://github.com/${repository.githubRepository.owner}/${repository.githubRepository.repo}.git`,
      baseBranch: repository.baseBranch,
      repoPath: repository.repoPath,
      repoKey: repository.repoKey,
      githubRepository: repository.githubRepository,
      setupCommands: repository.setup.setupCommands,
      envFiles: repository.setup.envFiles,
    } satisfies StoredRepositoryState;

    yield* Effect.tryPromise({
      try: () => repository.sandbox.fs.createFolder(path.dirname(repository.statePath), "755"),
      catch: (cause) =>
        new RepositoryStateError({
          message: `Failed to create state directory for ${repository.repoPath} in sandbox ${repository.sandbox.id}.`,
          sandboxId: repository.sandbox.id,
          repoPath: repository.repoPath,
          cause,
        }),
    });

    yield* Effect.tryPromise({
      try: () => repository.sandbox.fs.createFolder(repository.envRoot, "755"),
      catch: (cause) =>
        new RepositoryStateError({
          message: `Failed to create env directory for ${repository.repoPath} in sandbox ${repository.sandbox.id}.`,
          sandboxId: repository.sandbox.id,
          repoPath: repository.repoPath,
          cause,
        }),
    });

    yield* Effect.tryPromise({
      try: () =>
        repository.sandbox.fs.uploadFile(
          Buffer.from(JSON.stringify(state, null, 2)),
          repository.statePath,
        ),
      catch: (cause) =>
        new RepositoryStateError({
          message: `Failed to persist repository state for ${repository.repoPath} in sandbox ${repository.sandbox.id}.`,
          sandboxId: repository.sandbox.id,
          repoPath: repository.repoPath,
          cause,
        }),
    });
  });
}

function cloneIntoSandbox(
  sandbox: Sandbox,
  options: PreparedRepositoryOptions,
  repoPath: string,
): Effect.Effect<void, RepositoryCommandError> {
  const askPassPath = "/tmp/jevin-git-askpass.sh";
  const secretValues = collectSecretValues(options.gitAuth);
  const cloneParentPath = path.dirname(repoPath);
  const command = [
    createGitAskPassCommand(askPassPath),
    `mkdir -p ${quoteShellArg(cloneParentPath)}`,
    `git clone --branch ${quoteShellArg(options.baseBranch)} --single-branch ${quoteShellArg(options.url)} ${quoteShellArg(repoPath)}`,
  ].join("\n");

  return executeRepositoryCommand(
    sandbox,
    command,
    "/",
    secretValues,
    createGitAuthEnv(options.gitAuth, askPassPath),
  ).pipe(
    Effect.mapError(
      (error) =>
        new RepositoryCommandError({
          message: `Failed to clone ${options.url} into "${repoPath}" in sandbox ${sandbox.id}.`,
          sandboxId: sandbox.id,
          cwd: repoPath,
          cause: error.cause ?? error.message,
        }),
    ),
  );
}

function buildPreparedRepository(
  options: PreparedRepositoryOptions,
  repoPath: string,
): Effect.Effect<Omit<PreparedRepository, "cleanup">, GitHubRepositoryParseError> {
  return Effect.gen(function* () {
    const githubRepository = yield* parseGitHubRepository(options.url);
    const repoKey = createRepoKey(githubRepository);
    const statePaths = createRepositoryStatePaths(repoKey);
    const preparedSetup = {
      setupCommands: options.setup.setupCommands,
      envFiles: options.setup.envFiles.map((envFile) => ({
        path: envFile.path,
        storagePath: path.join(statePaths.envRoot, envFile.path),
      })),
    } satisfies PreparedGitHubRepositorySetup;

    return {
      sandbox: options.sandbox,
      sandboxId: options.sandbox.id,
      repoPath,
      baseBranch: options.baseBranch,
      githubRepository,
      repoKey,
      statePath: statePaths.statePath,
      envRoot: statePaths.envRoot,
      gitAuth: options.gitAuth,
      setup: preparedSetup,
    } satisfies Omit<PreparedRepository, "cleanup">;
  });
}

function makeRepoService(): RepoServiceShape {
  const cleanupRepository = (
    repository: PreparedRepository,
  ): Effect.Effect<void, RepositoryCleanupError> =>
    Effect.gen(function* () {
      const managedWorktreeRoot = createManagedWorktreeRoot(repository.repoKey);
      const worktreeRemoveCommand = [
        `if [ -d ${quoteShellArg(managedWorktreeRoot)} ]; then`,
        `find ${quoteShellArg(managedWorktreeRoot)} -mindepth 1 -maxdepth 1 -type d -print0 | xargs -0 -I{} git worktree remove --force "{}" || true`,
        "fi",
        "git worktree prune",
      ].join("\n");

      yield* executeRepositoryCommand(
        repository.sandbox,
        worktreeRemoveCommand,
        repository.repoPath,
        collectSecretValues(repository.gitAuth),
      ).pipe(
        Effect.mapError(
          (error) =>
            new RepositoryCleanupError({
              message: `Failed to remove managed worktrees for "${repository.repoPath}" in sandbox ${repository.sandbox.id}.`,
              sandboxId: repository.sandbox.id,
              repoPath: repository.repoPath,
              cause: error.cause ?? error.message,
            }),
        ),
      );

      yield* Effect.tryPromise({
        try: () => repository.sandbox.fs.deleteFile(repository.repoPath, true),
        catch: (cause) =>
          new RepositoryCleanupError({
            message: `Failed to delete repository path "${repository.repoPath}" in sandbox ${repository.sandbox.id}.`,
            sandboxId: repository.sandbox.id,
            repoPath: repository.repoPath,
            cause,
          }),
      });

      yield* Effect.tryPromise({
        try: () => repository.sandbox.fs.deleteFile(path.dirname(repository.statePath), true),
        catch: (cause) =>
          new RepositoryCleanupError({
            message: `Failed to delete repository state for "${repository.repoPath}" in sandbox ${repository.sandbox.id}.`,
            sandboxId: repository.sandbox.id,
            repoPath: repository.repoPath,
            cause,
          }),
      }).pipe(
        Effect.catchTag("RepositoryCleanupError", (error) =>
          String(error.cause).includes("not found") ? Effect.void : Effect.fail(error),
        ),
      );
    });

  return {
    prepareRepository(options) {
      return Effect.gen(function* () {
        const preparedOptions = yield* validatePrepareRepositoryOptions(options);
        const githubRepository = yield* parseGitHubRepository(preparedOptions.url);
        const repoKey = createRepoKey(githubRepository);
        const repoPath = yield* resolvePathInSandbox(
          preparedOptions.sandbox,
          preparedOptions.repoPath ?? path.join("/workspace/repos", repoKey),
        );
        const secretValues = collectSecretValues(preparedOptions.gitAuth);
        const exists = yield* repositoryExists(preparedOptions.sandbox, repoPath, secretValues);

        if (!exists) {
          yield* cloneIntoSandbox(preparedOptions.sandbox, preparedOptions, repoPath);
        } else {
          const remoteUrl = yield* readOriginUrl(preparedOptions.sandbox, repoPath, secretValues);
          const currentRepository = yield* parseGitHubRepository(remoteUrl).pipe(
            Effect.mapError(
              () =>
                new RepositoryIdentityMismatchError({
                  message: `Existing repository at "${repoPath}" is not a supported GitHub remote.`,
                  sandboxId: preparedOptions.sandbox.id,
                  repoPath,
                }),
            ),
          );

          if (
            currentRepository.owner.toLowerCase() !== githubRepository.owner.toLowerCase() ||
            currentRepository.repo.toLowerCase() !== githubRepository.repo.toLowerCase()
          ) {
            return yield* Effect.fail(
              new RepositoryIdentityMismatchError({
                message: `Existing repository at "${repoPath}" points to ${repositoryLabel(currentRepository)}, not ${repositoryLabel(githubRepository)}.`,
                sandboxId: preparedOptions.sandbox.id,
                repoPath,
              }),
            );
          }
        }

        const preparedRepositoryBase = yield* buildPreparedRepository(preparedOptions, repoPath);
        const preparedRepository: PreparedRepository = {
          ...preparedRepositoryBase,
          cleanup: cleanupRepository({
            ...preparedRepositoryBase,
            cleanup: Effect.void,
          }),
        };

        for (const envFile of preparedOptions.setup.envFiles) {
          const storagePath = preparedRepository.setup.envFiles.find(
            (entry) => entry.path === envFile.path,
          )?.storagePath;
          if (!storagePath) {
            return yield* Effect.fail(
              new RepositoryStateError({
                message: `Failed to resolve state storage path for env file "${envFile.path}".`,
                sandboxId: preparedOptions.sandbox.id,
                repoPath,
                cause: envFile.path,
              }),
            );
          }

          yield* Effect.tryPromise({
            try: () => preparedOptions.sandbox.fs.createFolder(path.dirname(storagePath), "755"),
            catch: (cause) =>
              new RepositoryStateError({
                message: `Failed to create env file directory for "${envFile.path}" in sandbox ${preparedOptions.sandbox.id}.`,
                sandboxId: preparedOptions.sandbox.id,
                repoPath,
                cause,
              }),
          });

          yield* Effect.tryPromise({
            try: () =>
              preparedOptions.sandbox.fs.uploadFile(Buffer.from(envFile.content), storagePath),
            catch: (cause) =>
              new RepositoryStateError({
                message: `Failed to persist env file "${envFile.path}" in sandbox ${preparedOptions.sandbox.id}.`,
                sandboxId: preparedOptions.sandbox.id,
                repoPath,
                cause,
              }),
          });
        }

        yield* persistRepositoryState(preparedRepositoryBase);

        return preparedRepository;
      });
    },
    syncRepository(repository) {
      const secretValues = collectSecretValues(repository.gitAuth);
      const askPassPath = "/tmp/jevin-git-askpass.sh";
      const command = [
        createGitAskPassCommand(askPassPath),
        ...createRepositorySyncCommands(repository.baseBranch),
      ].join("\n");

      return executeRepositoryCommand(
        repository.sandbox,
        command,
        repository.repoPath,
        secretValues,
        createGitAuthEnv(repository.gitAuth, askPassPath),
      ).pipe(
        Effect.mapError(
          (error) =>
            new RepositorySyncError({
              message: `Failed to sync repository "${repository.repoPath}" in sandbox ${repository.sandbox.id}.`,
              sandboxId: repository.sandbox.id,
              repoPath: repository.repoPath,
              cause: error.cause ?? error.message,
            }),
        ),
      );
    },
    cleanupRepository,
  } satisfies RepoServiceShape;
}

export function makeRepoServiceLayer(): Layer.Layer<RepoService> {
  return Layer.succeed(RepoService, makeRepoService());
}

export const RepoServiceLive = makeRepoServiceLayer;
