#!/usr/bin/env bun

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Console from "effect/Console";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { Command, Flag } from "effect/unstable/cli";

import {
  DaytonaClientLive,
  GitService,
  GitServiceLive,
  SandboxService,
  SandboxServiceLive,
} from "../index";
import { version } from "../../package.json" with { type: "json" };

class GitStatusCommandError extends Data.TaggedError("GitStatusCommandError")<{
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

const sandboxIdFlag = Flag.string("sandbox-id").pipe(
  Flag.withDescription("Daytona sandbox id that contains the repository or worktree."),
);

const pathFlag = Flag.string("path").pipe(
  Flag.withDescription("Repository path or worktree path inside the sandbox."),
);

const worktreesFlag = Flag.boolean("worktrees").pipe(
  Flag.withDescription("Also list git worktrees visible from the provided path."),
  Flag.optional,
);

const runGitStatusProgram = (input: {
  readonly sandboxId: string;
  readonly path: string;
  readonly worktrees: Option.Option<boolean>;
}) =>
  Effect.gen(function* () {
    const gitService = yield* GitService;
    const sandboxService = yield* SandboxService;

    const sandbox = yield* sandboxService.getSandbox(input.sandboxId).pipe(
      Effect.mapError(
        (cause) =>
          new GitStatusCommandError({
            message: cause.message,
            cause: cause.cause,
          }),
      ),
    );

    const repository = {
      sandbox,
      repoPath: input.path,
    };

    const status = yield* gitService.getRepositoryStatus(repository).pipe(
      Effect.mapError(
        (error) =>
          new GitStatusCommandError({
            message: error.message,
            cause: error instanceof Error && "cause" in error ? error.cause : undefined,
          }),
      ),
    );

    yield* Console.log(`Sandbox: ${input.sandboxId}`);
    yield* Console.log(`Path: ${input.path}`);
    yield* Console.log(`Branch: ${status.currentBranch}`);
    yield* Console.log(
      `Published: ${status.branchPublished === undefined ? "unknown" : status.branchPublished ? "yes" : "no"}`,
    );

    if (typeof status.ahead === "number" || typeof status.behind === "number") {
      yield* Console.log(`Ahead/behind: +${status.ahead ?? 0} -${status.behind ?? 0}`);
    }

    if (status.fileStatus.length === 0) {
      yield* Console.log("Working tree: clean");
    } else {
      yield* Console.log("Working tree changes:");
      for (const file of status.fileStatus) {
        const extra = file.extra.length > 0 ? ` (${file.extra})` : "";
        yield* Console.log(
          `- ${file.name}: index=${file.staging}, worktree=${file.worktree}${extra}`,
        );
      }
    }

    if (!Option.getOrElse(input.worktrees, () => false)) {
      return;
    }

    const worktrees = yield* gitService.listWorktrees(repository).pipe(
      Effect.mapError(
        (error) =>
          new GitStatusCommandError({
            message: error.message,
            cause: error instanceof Error && "cause" in error ? error.cause : undefined,
          }),
      ),
    );

    if (worktrees.length === 0) {
      yield* Console.log("Worktrees: none");
      return;
    }

    yield* Console.log("Worktrees:");
    for (const worktree of worktrees) {
      const branch = worktree.branch ?? "HEAD";
      yield* Console.log(`- ${worktree.path} (${branch})`);
    }
  }).pipe(
    Effect.matchEffect({
      onFailure: (error) =>
        Effect.fail(
          new GitStatusCommandError({
            message: formatUnknownError(error),
            cause: error instanceof Error && "cause" in error ? error.cause : undefined,
          }),
        ),
      onSuccess: (value) => Effect.succeed(value),
    }),
  );

const gitStatusCommand = Command.make("git-status", {
  sandboxId: sandboxIdFlag,
  path: pathFlag,
  worktrees: worktreesFlag,
}).pipe(
  Command.withDescription(
    "Read git status for an existing repository or worktree inside a Daytona sandbox.",
  ),
  Command.withHandler((input) => Effect.scoped(runGitStatusProgram(input))),
);

Command.run(gitStatusCommand, { version }).pipe(
  Effect.provide(GitServiceLive()),
  Effect.provide(SandboxServiceLive()),
  Effect.provide(DaytonaClientLive()),
  Effect.provide(NodeServices.layer),
  NodeRuntime.runMain,
);
