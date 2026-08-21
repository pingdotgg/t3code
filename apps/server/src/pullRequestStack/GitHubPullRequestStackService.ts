import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import {
  PullRequestStackError,
  type PullRequestMergeMethod,
  type PullRequestStackActionInput,
  type PullRequestStackActionResult,
  type PullRequestStackCurrentResult,
  type PullRequestStackListResult,
  type PullRequestStackMergeResult,
} from "@t3tools/contracts";

import * as VcsProcess from "../vcs/VcsProcess.ts";
import {
  decodeGitHubLocalStackJson,
  decodeGitHubRemoteStacksJson,
} from "./gitHubPullRequestStackJson.ts";

const READ_TIMEOUT_MS = 30_000;
const ACTION_TIMEOUT_MS = 600_000;

interface StackWorkingDirectoryInput {
  readonly cwd: string;
  readonly host?: string;
}

interface StackMergeInput extends StackWorkingDirectoryInput {
  readonly pullRequestNumber: number;
  readonly mergeMethod: PullRequestMergeMethod;
}

export class GitHubPullRequestStackService extends Context.Service<
  GitHubPullRequestStackService,
  {
    readonly list: (
      input: StackWorkingDirectoryInput,
    ) => Effect.Effect<PullRequestStackListResult, PullRequestStackError>;
    readonly current: (
      input: StackWorkingDirectoryInput,
    ) => Effect.Effect<PullRequestStackCurrentResult, PullRequestStackError>;
    readonly runAction: (
      input: PullRequestStackActionInput,
    ) => Effect.Effect<PullRequestStackActionResult, PullRequestStackError>;
    readonly merge: (
      input: StackMergeInput,
    ) => Effect.Effect<PullRequestStackMergeResult, PullRequestStackError>;
  }
>()("t3/pullRequestStack/GitHubPullRequestStackService") {}

function commandError(
  operation: string,
  cwd: string,
  output: VcsProcess.VcsProcessOutput,
): PullRequestStackError {
  return new PullRequestStackError({
    operation,
    cwd,
    detail: "The GitHub stack command failed.",
    exitCode: output.exitCode,
    cause: output.stderr.trim() || output.stdout.trim(),
  });
}

function processError(operation: string, cwd: string, cause: unknown): PullRequestStackError {
  return new PullRequestStackError({
    operation,
    cwd,
    detail: "GitHub CLI could not run.",
    cause,
  });
}

function decodeError(operation: string, cwd: string, cause: unknown): PullRequestStackError {
  return new PullRequestStackError({
    operation,
    cwd,
    detail: "GitHub returned unreadable pull request stack data.",
    cause,
  });
}

function isMissingExtension(output: VcsProcess.VcsProcessOutput): boolean {
  const detail = `${output.stdout}\n${output.stderr}`.toLowerCase();
  return detail.includes("unknown command") && detail.includes("stack");
}

function isStacksUnavailable(output: VcsProcess.VcsProcessOutput): boolean {
  const detail = `${output.stdout}\n${output.stderr}`.toLowerCase();
  return detail.includes("stacks are not enabled");
}

function isNotFound(output: VcsProcess.VcsProcessOutput): boolean {
  return `${output.stdout}\n${output.stderr}`.toLowerCase().includes("http 404");
}

function actionArgs(input: PullRequestStackActionInput): ReadonlyArray<string> | null {
  switch (input.action) {
    case "start":
      return input.branch === undefined
        ? null
        : [
            "stack",
            "init",
            ...(input.baseBranch === undefined ? [] : ["--base", input.baseBranch]),
            input.branch,
          ];
    case "add_step":
      return input.branch === undefined ? null : ["stack", "add", input.branch];
    case "submit":
      return ["stack", "submit", "--auto"];
    case "sync":
      return ["stack", "sync"];
    case "unstack":
      return ["stack", "unstack"];
  }
}

function mergeArgs(input: StackMergeInput): ReadonlyArray<string> {
  return ["stack", "merge", String(input.pullRequestNumber), "--yes", `--${input.mergeMethod}`];
}

export const make = Effect.gen(function* () {
  const process = yield* VcsProcess.VcsProcess;

  const run = Effect.fn("GitHubPullRequestStackService.run")(function* (
    operation: string,
    cwd: string,
    args: ReadonlyArray<string>,
    timeoutMs: number,
  ) {
    return yield* process
      .run({
        operation,
        command: "gh",
        args,
        cwd,
        allowNonZeroExit: true,
        timeoutMs,
      })
      .pipe(Effect.mapError((error) => processError(operation, cwd, error)));
  });

  const current: GitHubPullRequestStackService["Service"]["current"] = Effect.fn(
    "GitHubPullRequestStackService.current",
  )(function* (input) {
    const operation = "GitHubPullRequestStackService.current";
    const output = yield* run(operation, input.cwd, ["stack", "view", "--json"], READ_TIMEOUT_MS);
    if (output.exitCode === 2) return { availability: "available", stack: null };
    if (output.exitCode === 9) return { availability: "unsupported", stack: null };
    if (output.exitCode !== 0) {
      if (isMissingExtension(output)) return { availability: "extension_missing", stack: null };
      return yield* commandError(operation, input.cwd, output);
    }
    if (output.stdoutTruncated || output.stdoutInvalidUtf8) {
      return yield* decodeError(operation, input.cwd, output.stdout);
    }
    const decoded = decodeGitHubLocalStackJson(output.stdout);
    if (Result.isFailure(decoded)) {
      return yield* decodeError(operation, input.cwd, decoded.failure);
    }
    return { availability: "available", stack: decoded.success };
  });

  const list: GitHubPullRequestStackService["Service"]["list"] = Effect.fn(
    "GitHubPullRequestStackService.list",
  )(function* (input) {
    const operation = "GitHubPullRequestStackService.list";
    const output = yield* run(
      operation,
      input.cwd,
      [
        "api",
        "repos/{owner}/{repo}/stacks",
        ...(input.host === undefined ? [] : ["--hostname", input.host]),
      ],
      READ_TIMEOUT_MS,
    );
    if (output.exitCode !== 0) {
      if (isStacksUnavailable(output)) return { availability: "unsupported", stacks: [] };
      if (isNotFound(output)) {
        const access = yield* run(
          operation,
          input.cwd,
          [
            "api",
            "repos/{owner}/{repo}",
            ...(input.host === undefined ? [] : ["--hostname", input.host]),
          ],
          READ_TIMEOUT_MS,
        );
        if (access.exitCode === 0) return { availability: "unsupported", stacks: [] };
        return yield* new PullRequestStackError({
          operation,
          cwd: input.cwd,
          detail: "GitHub credentials or repository permissions could not be verified.",
          exitCode: access.exitCode,
          cause: access.stderr.trim() || access.stdout.trim(),
        });
      }
      return yield* commandError(operation, input.cwd, output);
    }
    if (output.stdoutTruncated || output.stdoutInvalidUtf8) {
      return yield* decodeError(operation, input.cwd, output.stdout);
    }
    const decoded = decodeGitHubRemoteStacksJson(output.stdout);
    if (Result.isFailure(decoded)) {
      return yield* decodeError(operation, input.cwd, decoded.failure);
    }
    return { availability: "available", stacks: decoded.success };
  });

  const runAction: GitHubPullRequestStackService["Service"]["runAction"] = Effect.fn(
    "GitHubPullRequestStackService.runAction",
  )(function* (input) {
    const args = actionArgs(input);
    const operation = `GitHubPullRequestStackService.${input.action}`;
    if (args === null) {
      return yield* new PullRequestStackError({
        operation,
        cwd: input.cwd,
        detail: "This stack action needs a branch name.",
      });
    }
    const output = yield* run(operation, input.cwd, args, ACTION_TIMEOUT_MS);
    if (output.exitCode !== 0) return yield* commandError(operation, input.cwd, output);
    const outputText = `${output.stdout}\n${output.stderr}`;
    if (
      input.action === "sync" &&
      /diverged/i.test(outputText) &&
      /no changes were made/i.test(outputText)
    ) {
      return yield* new PullRequestStackError({
        operation,
        cwd: input.cwd,
        detail: "Local and remote stacks diverged. No changes were made.",
      });
    }
    const refreshed = yield* current({ cwd: input.cwd });
    return { action: input.action, stack: refreshed.stack };
  });

  const merge: GitHubPullRequestStackService["Service"]["merge"] = Effect.fn(
    "GitHubPullRequestStackService.merge",
  )(function* (input) {
    const operation = "GitHubPullRequestStackService.merge";
    const output = yield* run(operation, input.cwd, mergeArgs(input), ACTION_TIMEOUT_MS);
    if (output.exitCode !== 0) return yield* commandError(operation, input.cwd, output);
    const outputText = `${output.stdout}\n${output.stderr}`;
    if (/merge queue/i.test(outputText)) return { status: "queued" };
    if (/\bmerged?\b/i.test(outputText)) return { status: "merged" };
    return yield* new PullRequestStackError({
      operation,
      cwd: input.cwd,
      detail: "GitHub returned an unknown successful stack merge response.",
    });
  });

  return GitHubPullRequestStackService.of({ list, current, runAction, merge });
});

export const layer = Layer.effect(GitHubPullRequestStackService, make);
