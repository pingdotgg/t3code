import type {
  ServerProviderStatus,
  TerminalOpenInput,
  TerminalSessionSnapshot,
} from "@t3tools/contracts";
import { Effect } from "effect";

import { GitCommandError, GitHubCliError } from "../../src/git/Errors.ts";
import { type GitHubCliShape } from "../../src/git/Services/GitHubCli.ts";
import {
  type ExecuteGitInput,
  type ExecuteGitResult,
  type GitServiceShape,
} from "../../src/git/Services/GitService.ts";
import { type OpenShape } from "../../src/open.ts";
import type { ProcessRunResult } from "../../src/processRunner.ts";
import { type TerminalManagerShape } from "../../src/terminal/Services/Manager.ts";

import { createReplayCliInvoker } from "@t3tools/rr-e2e";
import type { ReplayFixture } from "@t3tools/rr-e2e";

export function defaultProviderStatuses(): ReadonlyArray<ServerProviderStatus> {
  return [
    {
      provider: "codex",
      status: "ready",
      available: true,
      authStatus: "authenticated",
      checkedAt: "2026-03-10T12:00:00.000Z",
    },
  ];
}

function noOpTerminalSnapshot(input: TerminalOpenInput): TerminalSessionSnapshot {
  return {
    threadId: input.threadId,
    terminalId: input.terminalId ?? "default",
    cwd: input.cwd,
    status: "running",
    pid: null,
    history: "",
    exitCode: null,
    exitSignal: null,
    updatedAt: new Date().toISOString(),
  };
}

export const noOpTerminalManager: TerminalManagerShape = {
  open: (input) => Effect.succeed(noOpTerminalSnapshot(input)),
  write: () => Effect.void,
  resize: () => Effect.void,
  clear: () => Effect.void,
  restart: (input) => Effect.succeed(noOpTerminalSnapshot(input)),
  close: () => Effect.void,
  subscribe: () => Effect.succeed(() => undefined),
  dispose: Effect.void,
};

export const noOpOpenService: OpenShape = {
  openBrowser: () => Effect.void,
  openInEditor: () => Effect.void,
};

function replayGitCommandFailure(input: ExecuteGitInput, cause: unknown): GitCommandError {
  return new GitCommandError({
    operation: input.operation,
    command: `git ${input.args.join(" ")}`,
    cwd: input.cwd,
    detail: cause instanceof Error ? cause.message : String(cause),
  });
}

function replayGitHubCliFailure(operation: string, cause: unknown): GitHubCliError {
  return new GitHubCliError({
    operation: operation as "execute" | "stdout",
    detail: cause instanceof Error ? cause.message : String(cause),
    cause,
  });
}

export function makeReplayGitService(
  fixture: ReplayFixture,
  state: Record<string, unknown>,
): GitServiceShape {
  const invoke = createReplayCliInvoker(fixture, state);
  return {
    execute: (input) =>
      invoke({
        service: "git",
        operation: "execute",
        input,
        mapResult: (result) => result as ExecuteGitResult,
        mapError: (cause) => replayGitCommandFailure(input, cause),
      }),
  };
}

export function makeReplayGitHubCli(
  fixture: ReplayFixture,
  state: Record<string, unknown>,
): GitHubCliShape {
  const invoke = createReplayCliInvoker(fixture, state);
  const target = {} as GitHubCliShape;

  return new Proxy(target, {
    get: (_target, property) => {
      if (typeof property !== "string") {
        return undefined;
      }

      return (input: unknown) =>
        invoke({
          service: "github",
          operation: property,
          input,
          mapResult: (result) => result as ProcessRunResult,
          mapError: (cause) => replayGitHubCliFailure(property, cause),
        });
    },
  });
}
