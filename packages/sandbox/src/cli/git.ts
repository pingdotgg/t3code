#!/usr/bin/env bun

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Config from "effect/Config";
import * as Console from "effect/Console";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { Command, Flag } from "effect/unstable/cli";

import {
  DaytonaClientLive,
  GitCleanupError,
  GitService,
  GitServiceLive,
  SandboxServiceLive,
  TerminalService,
  TerminalServiceLive,
  type TerminalCleanupError,
} from "../index";
import { version } from "../../package.json" with { type: "json" };
import { getTerminalSize, runInteractiveTerminalSession } from "./terminal-session";

class GitCommandError extends Data.TaggedError("GitCommandError")<{
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

function resolvePassword(
  passwordEnvNameOption: Option.Option<string>,
): Effect.Effect<string | undefined, GitCommandError> {
  const passwordEnvName = Option.getOrUndefined(passwordEnvNameOption);

  if (!passwordEnvName) {
    return Effect.succeed(undefined);
  }

  return Config.string(passwordEnvName)
    .asEffect()
    .pipe(
      Effect.mapError(
        (cause) =>
          new GitCommandError({
            message: `Environment variable "${passwordEnvName}" is required when --password-env is set.`,
            cause,
          }),
      ),
      Effect.flatMap((value) =>
        value.length > 0
          ? Effect.succeed(value)
          : Effect.fail(
              new GitCommandError({
                message: `Environment variable "${passwordEnvName}" must not be empty.`,
              }),
            ),
      ),
    );
}

const urlFlag = Flag.string("url").pipe(
  Flag.withDescription("Repository URL to clone into the sandbox."),
);

const pathFlag = Flag.string("path").pipe(
  Flag.withDescription("Optional destination path inside the sandbox."),
  Flag.optional,
);

const branchFlag = Flag.string("branch").pipe(
  Flag.withDescription("Optional branch to clone."),
  Flag.optional,
);

const commitIdFlag = Flag.string("commit-id").pipe(
  Flag.withDescription("Optional commit SHA to clone in detached HEAD state."),
  Flag.optional,
);

const usernameFlag = Flag.string("username").pipe(
  Flag.withDescription("Optional Git username, such as x-access-token for GitHub tokens."),
  Flag.optional,
);

const passwordEnvFlag = Flag.string("password-env").pipe(
  Flag.withDescription("Environment variable name that contains the Git password or token."),
  Flag.optional,
);

const ptyFlag = Flag.boolean("pty").pipe(
  Flag.withDescription(
    "Open an interactive PTY in the cloned repository after the clone succeeds.",
  ),
  Flag.optional,
);

const runGitProgram = (input: {
  readonly url: string;
  readonly path: Option.Option<string>;
  readonly branch: Option.Option<string>;
  readonly commitId: Option.Option<string>;
  readonly username: Option.Option<string>;
  readonly passwordEnv: Option.Option<string>;
  readonly pty: Option.Option<boolean>;
}) =>
  Effect.gen(function* () {
    const gitService = yield* GitService;
    const terminalService = yield* TerminalService;
    const username = Option.getOrUndefined(input.username);
    const password = yield* resolvePassword(input.passwordEnv);
    const openPty = Option.getOrElse(input.pty, () => false);

    if ((username && !password) || (!username && password)) {
      return yield* Effect.fail(
        new GitCommandError({
          message: "Provide both --username and --password-env together for authenticated clones.",
        }),
      );
    }

    const session = yield* gitService.cloneRepository({
      url: input.url,
      path: Option.getOrUndefined(input.path),
      branch: Option.getOrUndefined(input.branch),
      commitId: Option.getOrUndefined(input.commitId),
      auth:
        username && password
          ? {
              username,
              password,
            }
          : undefined,
    });

    yield* Effect.addFinalizer(() =>
      session.cleanup.pipe(
        Effect.matchEffect({
          onFailure: (error: GitCleanupError) => Console.error(error.message),
          onSuccess: () => Effect.void,
        }),
      ),
    );

    const status = yield* gitService.getRepositoryStatus(session);
    const branches = yield* gitService.listBranches(session);

    yield* Console.log(`Cloned into Daytona sandbox ${session.sandboxId}`);
    yield* Console.log(`Repository path: ${session.repoPath}`);
    yield* Console.log(`Current branch: ${status.currentBranch}`);
    yield* Console.log(`Branches: ${branches.branches.join(", ")}`);

    if (!openPty) {
      return;
    }

    const { cols, rows } = getTerminalSize();
    const decoder = new TextDecoder();
    const terminalSession = yield* terminalService
      .openSandboxPtySession({
        sandboxId: session.sandboxId,
        cwd: session.repoPath,
        cols,
        rows,
        onData: (data: Uint8Array) => {
          process.stdout.write(decoder.decode(data));
        },
      })
      .pipe(
        Effect.mapError(
          (error) =>
            new GitCommandError({
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
      `Connected to Daytona sandbox ${session.sandboxId}`,
      `Repository path: ${session.repoPath}`,
      `PTY session ${terminalSession.sessionId}`,
      "Type `exit` to close the terminal and tear the sandbox down.\n",
    ]);
  }).pipe(
    Effect.matchEffect({
      onFailure: (error) =>
        Effect.fail(
          new GitCommandError({
            message: formatUnknownError(error),
            cause: error instanceof Error && "cause" in error ? error.cause : undefined,
          }),
        ),
      onSuccess: (value) => Effect.succeed(value),
    }),
  );

const gitCommand = Command.make("git", {
  url: urlFlag,
  path: pathFlag,
  branch: branchFlag,
  commitId: commitIdFlag,
  username: usernameFlag,
  passwordEnv: passwordEnvFlag,
  pty: ptyFlag,
}).pipe(
  Command.withDescription("Clone a repository into a Daytona sandbox using safe auth handling."),
  Command.withHandler((input) => Effect.scoped(runGitProgram(input))),
);

Command.run(gitCommand, { version }).pipe(
  Effect.provide(TerminalServiceLive()),
  Effect.provide(GitServiceLive()),
  Effect.provide(SandboxServiceLive()),
  Effect.provide(DaytonaClientLive()),
  Effect.provide(NodeServices.layer),
  NodeRuntime.runMain,
);
