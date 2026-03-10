#!/usr/bin/env bun

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Config from "effect/Config";
import * as Console from "effect/Console";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { Command, Flag } from "effect/unstable/cli";
import * as Param from "effect/unstable/cli/Param";

import {
  DaytonaClientLive,
  GitServiceLive,
  RepoService,
  RepoServiceLive,
  SandboxService,
  SandboxServiceLive,
  TerminalService,
  TerminalServiceLive,
  WorktreeService,
  WorktreeServiceLive,
  type TerminalCleanupError,
} from "../index";
import { version } from "../../package.json" with { type: "json" };
import { getTerminalSize, runInteractiveTerminalSession } from "./terminal-session";

class WorktreeCommandError extends Data.TaggedError("WorktreeCommandError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

function formatUnknownError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  if (typeof error === "object" && error !== null && "message" in error) {
    const message = error.message;
    if (typeof message === "string") {
      return message;
    }
  }

  return String(error);
}

function resolveEnvValue(
  envNameOption: Option.Option<string>,
  flagName: string,
): Effect.Effect<string | undefined, WorktreeCommandError> {
  const envName = Option.getOrUndefined(envNameOption);

  if (!envName) {
    return Effect.succeed(undefined);
  }

  return Config.string(envName)
    .asEffect()
    .pipe(
      Effect.mapError(
        (cause) =>
          new WorktreeCommandError({
            message: `Environment variable "${envName}" is required when ${flagName} is set.`,
            cause,
          }),
      ),
      Effect.flatMap((value) =>
        value.length > 0
          ? Effect.succeed(value)
          : Effect.fail(
              new WorktreeCommandError({
                message: `Environment variable "${envName}" must not be empty.`,
              }),
            ),
      ),
    );
}

const urlFlag = Flag.string("url").pipe(
  Flag.withDescription("GitHub repository URL to register inside an existing Daytona sandbox."),
);

const sandboxIdFlag = Flag.string("sandbox-id").pipe(
  Flag.withDescription(
    "Optional Daytona sandbox ID that should host the repository and worktree. If omitted, the CLI creates one.",
  ),
  Flag.optional,
);

const baseBranchFlag = Flag.string("base-branch").pipe(
  Flag.withDescription("Base branch the worktree branch should target."),
);

const usernameFlag = Flag.string("username").pipe(
  Flag.withDescription("Git username for authenticated clone and push operations."),
);

const passwordEnvFlag = Flag.string("password-env").pipe(
  Flag.withDescription("Environment variable name containing the Git password or token."),
);

const prefixFlag = Flag.string("prefix").pipe(
  Flag.withDescription("Optional branch prefix. Defaults to jevin."),
  Flag.optional,
);

const nameFlag = Flag.string("name").pipe(
  Flag.withDescription(
    "Optional worktree suffix. The command always prepends the configured prefix.",
  ),
  Flag.optional,
);

const repoPathFlag = Flag.string("repo-path").pipe(
  Flag.withDescription("Optional repository clone path inside the sandbox."),
  Flag.optional,
);

const worktreePathFlag = Flag.string("worktree-path").pipe(
  Flag.withDescription("Optional worktree path inside the sandbox."),
  Flag.optional,
);

const setupCommandFlag = Flag.string("setup-command").pipe(
  Flag.withDescription(
    "Repeatable setup command to run inside the new worktree after env files are copied.",
  ),
);

const envFileFlag = Flag.string("env-file").pipe(
  Flag.withDescription(
    "Repeatable repo-relative env file path to materialize in each new worktree.",
  ),
);

const envFileContentEnvFlag = Flag.string("env-file-content-env").pipe(
  Flag.withDescription(
    "Repeatable environment variable name providing the content for the corresponding --env-file entry.",
  ),
);

const ptyFlag = Flag.boolean("pty").pipe(
  Flag.withDescription("Open an interactive PTY inside the prepared worktree."),
  Flag.optional,
);

function createSandboxName(): string {
  return `jevin-worktree-${Date.now()}`;
}

const runWorktreeProgram = (input: {
  readonly sandboxId: Option.Option<string>;
  readonly url: string;
  readonly baseBranch: string;
  readonly username: string;
  readonly passwordEnv: string;
  readonly prefix: Option.Option<string>;
  readonly name: Option.Option<string>;
  readonly repoPath: Option.Option<string>;
  readonly worktreePath: Option.Option<string>;
  readonly setupCommands: ReadonlyArray<string>;
  readonly envFiles: ReadonlyArray<string>;
  readonly envFileContentEnvs: ReadonlyArray<string>;
  readonly pty: Option.Option<boolean>;
}) =>
  Effect.gen(function* () {
    const repoService = yield* RepoService;
    const sandboxService = yield* SandboxService;
    const terminalService = yield* TerminalService;
    const worktreeService = yield* WorktreeService;
    const password = yield* resolveEnvValue(Option.some(input.passwordEnv), "--password-env");
    const openPty = Option.getOrElse(input.pty, () => false);

    if (!password) {
      return yield* Effect.fail(
        new WorktreeCommandError({
          message: "A non-empty Git password or token is required.",
        }),
      );
    }

    if (input.envFiles.length !== input.envFileContentEnvs.length) {
      return yield* Effect.fail(
        new WorktreeCommandError({
          message:
            "Each --env-file entry requires a matching --env-file-content-env entry in the same order.",
        }),
      );
    }

    const envFiles = yield* Effect.forEach(input.envFiles, (envFilePath, index) =>
      resolveEnvValue(
        Option.some(input.envFileContentEnvs[index] ?? ""),
        "--env-file-content-env",
      ).pipe(
        Effect.flatMap((content) =>
          content === undefined
            ? Effect.fail(
                new WorktreeCommandError({
                  message: `Environment content is required for env file "${envFilePath}".`,
                }),
              )
            : Effect.succeed({
                path: envFilePath,
                content,
              }),
        ),
      ),
    );

    const sandboxId = Option.getOrUndefined(input.sandboxId);
    const sandbox = sandboxId
      ? yield* sandboxService.getSandbox(sandboxId).pipe(
          Effect.mapError(
            (cause) =>
              new WorktreeCommandError({
                message: cause.message,
                cause: cause.cause,
              }),
          ),
        )
      : yield* sandboxService
          .createSandbox({
            sandboxName: createSandboxName(),
            labels: {
              capability: "worktree",
            },
          })
          .pipe(
            Effect.mapError(
              (cause) =>
                new WorktreeCommandError({
                  message: "Failed to create a Daytona sandbox for the worktree CLI.",
                  cause: cause.cause ?? cause.message,
                }),
            ),
          );

    const preparedRepository = yield* repoService.prepareRepository({
      sandbox,
      url: input.url,
      baseBranch: input.baseBranch,
      gitAuth: {
        username: input.username,
        password,
      },
      repoPath: Option.getOrUndefined(input.repoPath),
      setup: {
        setupCommands: input.setupCommands,
        envFiles,
      },
    });

    const preparedWorktree = yield* worktreeService.createWorktree({
      repository: preparedRepository,
      worktreePath: Option.getOrUndefined(input.worktreePath),
      branchPrefix: Option.getOrUndefined(input.prefix),
      worktreeName: Option.getOrUndefined(input.name),
    });

    yield* Console.log(`Prepared GitHub worktree in Daytona sandbox ${preparedWorktree.sandboxId}`);
    if (!sandboxId) {
      yield* Console.log("Created sandbox for this command because --sandbox-id was not provided.");
    }
    yield* Console.log(
      `Repository: ${preparedWorktree.githubRepository.owner}/${preparedWorktree.githubRepository.repo}`,
    );
    yield* Console.log(`Repository key: ${preparedRepository.repoKey}`);
    yield* Console.log(`Repository path: ${preparedWorktree.repoPath}`);
    yield* Console.log(`Worktree path: ${preparedWorktree.worktreePath}`);
    yield* Console.log(`Base branch: ${preparedWorktree.baseBranch}`);
    yield* Console.log(`Head branch: ${preparedWorktree.headBranch}`);
    yield* Console.log(
      "Cleanup is not automatic. Use the repo/worktree service cleanup handles when you want to remove resources.",
    );

    if (!openPty) {
      return;
    }

    const { cols, rows } = getTerminalSize();
    const decoder = new TextDecoder();
    const terminalSession = yield* terminalService
      .openSandboxPtySession({
        sandboxId: preparedWorktree.sandboxId,
        cwd: preparedWorktree.worktreePath,
        cols,
        rows,
        onData: (data: Uint8Array) => {
          process.stdout.write(decoder.decode(data));
        },
      })
      .pipe(
        Effect.mapError(
          (error) =>
            new WorktreeCommandError({
              message: error.message,
              cause: error instanceof Error && "cause" in error ? error.cause : undefined,
            }),
        ),
      );

    yield* Effect.addFinalizer(() =>
      terminalSession.cleanup.pipe(
        Effect.matchEffect({
          onFailure: (error: TerminalCleanupError) => Console.error(error.message),
          onSuccess: () => Effect.void,
        }),
      ),
    );

    yield* runInteractiveTerminalSession(terminalSession, [
      `Connected to Daytona sandbox ${preparedWorktree.sandboxId}`,
      `Repository path: ${preparedWorktree.repoPath}`,
      `Worktree path: ${preparedWorktree.worktreePath}`,
      `Head branch: ${preparedWorktree.headBranch}`,
      `PTY session ${terminalSession.sessionId}`,
      "Type `exit` to close the terminal and tear the sandbox down.\n",
    ]);
  }).pipe(
    Effect.matchEffect({
      onFailure: (error) =>
        Effect.fail(
          new WorktreeCommandError({
            message: formatUnknownError(error),
            cause: error instanceof Error && "cause" in error ? error.cause : undefined,
          }),
        ),
      onSuccess: (value) => Effect.succeed(value),
    }),
  );

const worktreeCommand = Command.make("worktree", {
  sandboxId: sandboxIdFlag,
  url: urlFlag,
  baseBranch: baseBranchFlag,
  username: usernameFlag,
  passwordEnv: passwordEnvFlag,
  prefix: prefixFlag,
  name: nameFlag,
  repoPath: repoPathFlag,
  worktreePath: worktreePathFlag,
  setupCommands: Param.variadic(setupCommandFlag),
  envFiles: Param.variadic(envFileFlag),
  envFileContentEnvs: Param.variadic(envFileContentEnvFlag),
  pty: ptyFlag,
}).pipe(
  Command.withDescription(
    "Prepare a GitHub repo + worktree in a Daytona sandbox and optionally open a PTY there.",
  ),
  Command.withHandler((input) => Effect.scoped(runWorktreeProgram(input))),
);

Command.run(worktreeCommand, { version }).pipe(
  Effect.provide(TerminalServiceLive()),
  Effect.provide(WorktreeServiceLive()),
  Effect.provide(RepoServiceLive()),
  Effect.provide(GitServiceLive()),
  Effect.provide(SandboxServiceLive()),
  Effect.provide(DaytonaClientLive()),
  Effect.provide(NodeServices.layer),
  NodeRuntime.runMain,
);
