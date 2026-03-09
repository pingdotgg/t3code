import { Effect, Layer } from "effect";

import { runProcess } from "../../processRunner";
import { GitHubCliError } from "../Errors.ts";
import {
  GitHubCli,
  type GitHubCliShape,
  type GitHubPullRequestSummary,
} from "../Services/GitHubCli.ts";

const DEFAULT_TIMEOUT_MS = 30_000;

function normalizeGitHubCliError(operation: "execute" | "stdout", error: unknown): GitHubCliError {
  if (error instanceof Error) {
    if (error.message.includes("Command not found: gh")) {
      return new GitHubCliError({
        operation,
        detail: "GitHub CLI (`gh`) is required but not available on PATH.",
        cause: error,
      });
    }

    const lower = error.message.toLowerCase();
    if (
      lower.includes("authentication failed") ||
      lower.includes("not logged in") ||
      lower.includes("gh auth login") ||
      lower.includes("no oauth token")
    ) {
      return new GitHubCliError({
        operation,
        detail: "GitHub CLI is not authenticated. Run `gh auth login` and retry.",
        cause: error,
      });
    }

    if (
      lower.includes("could not resolve to a pullrequest") ||
      lower.includes("repository.pullrequest") ||
      lower.includes("no pull requests found for branch") ||
      lower.includes("pull request not found")
    ) {
      return new GitHubCliError({
        operation,
        detail: "Pull request not found. Check the PR number or URL and try again.",
        cause: error,
      });
    }

    return new GitHubCliError({
      operation,
      detail: `GitHub CLI command failed: ${error.message}`,
      cause: error,
    });
  }

  return new GitHubCliError({
    operation,
    detail: "GitHub CLI command failed.",
    cause: error,
  });
}

function normalizePullRequestState(record: Record<string, unknown>): "open" | "closed" | "merged" {
  const mergedAt = record.mergedAt;
  const state = record.state;
  if ((typeof mergedAt === "string" && mergedAt.trim().length > 0) || state === "MERGED") {
    return "merged";
  }
  if (state === "CLOSED") {
    return "closed";
  }
  return "open";
}

function parsePullRequestSummary(
  raw: unknown,
): GitHubPullRequestSummary | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }
  const record = raw as Record<string, unknown>;
  const number = record.number;
  const title = record.title;
  const url = record.url;
  const baseRefName = record.baseRefName;
  const headRefName = record.headRefName;
  if (
    typeof number !== "number" ||
    !Number.isInteger(number) ||
    number <= 0 ||
    typeof title !== "string" ||
    typeof url !== "string" ||
    typeof baseRefName !== "string" ||
    typeof headRefName !== "string"
  ) {
    return null;
  }
  return {
    number,
    title,
    url,
    baseRefName,
    headRefName,
    state: normalizePullRequestState(record),
  };
}

function parseOpenPullRequests(raw: string): ReadonlyArray<GitHubPullRequestSummary> {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return [];

  const parsed: unknown = JSON.parse(trimmed);
  if (!Array.isArray(parsed)) {
    throw new Error("GitHub CLI returned non-array JSON.");
  }

  const result: Array<GitHubPullRequestSummary> = [];
  for (const entry of parsed) {
    const parsedEntry = parsePullRequestSummary(entry);
    if (parsedEntry) {
      result.push(parsedEntry);
    }
  }

  return result;
}

const makeGitHubCli = Effect.sync(() => {
  const execute: GitHubCliShape["execute"] = (input) =>
    Effect.tryPromise({
      try: () =>
        runProcess("gh", input.args, {
          cwd: input.cwd,
          timeoutMs: input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        }),
      catch: (error) => normalizeGitHubCliError("execute", error),
    });

  const service = {
    execute,
    listOpenPullRequests: (input) =>
      execute({
        cwd: input.cwd,
        args: [
          "pr",
          "list",
          "--head",
          input.headBranch,
          "--state",
          "open",
          "--limit",
          String(input.limit ?? 1),
          "--json",
          "number,title,url,baseRefName,headRefName",
        ],
      }).pipe(
        Effect.map((result) => result.stdout),
        Effect.flatMap((raw) =>
          Effect.try({
            try: () => parseOpenPullRequests(raw),
            catch: (error: unknown) =>
              new GitHubCliError({
                operation: "listOpenPullRequests",
                detail:
                  error instanceof Error
                    ? `GitHub CLI returned invalid PR list JSON: ${error.message}`
                    : "GitHub CLI returned invalid PR list JSON.",
                ...(error !== undefined ? { cause: error } : {}),
              }),
          }),
        ),
      ),
    getPullRequest: (input) =>
      execute({
        cwd: input.cwd,
        args: [
          "pr",
          "view",
          input.reference,
          "--json",
          "number,title,url,baseRefName,headRefName,state,mergedAt",
        ],
      }).pipe(
        Effect.map((result) => result.stdout.trim()),
        Effect.flatMap((raw) =>
          Effect.try({
            try: () => {
              const parsed = raw.length > 0 ? JSON.parse(raw) : null;
              const summary = parsePullRequestSummary(parsed);
              if (!summary) {
                throw new Error("GitHub CLI returned invalid pull request JSON.");
              }
              return summary;
            },
            catch: (error: unknown) =>
              new GitHubCliError({
                operation: "getPullRequest",
                detail:
                  error instanceof Error
                    ? `GitHub CLI returned invalid pull request JSON: ${error.message}`
                    : "GitHub CLI returned invalid pull request JSON.",
                ...(error !== undefined ? { cause: error } : {}),
              }),
          }),
        ),
      ),
    createPullRequest: (input) =>
      execute({
        cwd: input.cwd,
        args: [
          "pr",
          "create",
          "--base",
          input.baseBranch,
          "--head",
          input.headBranch,
          "--title",
          input.title,
          "--body-file",
          input.bodyFile,
        ],
      }).pipe(Effect.asVoid),
    getDefaultBranch: (input) =>
      execute({
        cwd: input.cwd,
        args: ["repo", "view", "--json", "defaultBranchRef", "--jq", ".defaultBranchRef.name"],
      }).pipe(
        Effect.map((value) => {
          const trimmed = value.stdout.trim();
          return trimmed.length > 0 ? trimmed : null;
        }),
      ),
    checkoutPullRequest: (input) =>
      execute({
        cwd: input.cwd,
        args: [
          "pr",
          "checkout",
          input.reference,
          ...(input.force ? ["--force"] : []),
        ],
      }).pipe(Effect.asVoid),
  } satisfies GitHubCliShape;

  return service;
});

export const GitHubCliLive = Layer.effect(GitHubCli, makeGitHubCli);
