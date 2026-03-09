/**
 * GitHostingCliDispatcher - Selects the correct hosting CLI (gh or glab)
 * based on the repository's origin remote URL.
 *
 * Detects the hosting provider by running `git remote get-url origin` and
 * matching known patterns (github.com → gh, gitlab.com → glab). Falls back
 * to GitHub CLI for unknown or missing remotes, preserving backwards
 * compatibility.
 */
import { spawnSync } from "node:child_process";

import { Effect, Layer } from "effect";

import { runProcess } from "../../processRunner";
import { GitHostingCliError } from "../Errors.ts";
import { GitHostingCli, type GitHostingCliShape } from "../Services/GitHostingCli.ts";

const DEFAULT_TIMEOUT_MS = 30_000;

type HostingProvider = "github" | "gitlab";

/**
 * Detect the hosting provider from the origin remote URL.
 *
 * Uses synchronous spawn to keep the detection simple and cache-friendly.
 * Returns "github" as the default when detection is inconclusive.
 */
function detectHostingProvider(cwd: string): HostingProvider {
  try {
    const result = spawnSync("git", ["remote", "get-url", "origin"], {
      cwd,
      encoding: "utf-8",
      timeout: 5_000,
    });

    if (result.status !== 0 || !result.stdout) {
      return "github";
    }

    const url = result.stdout.trim().toLowerCase();
    if (url.includes("gitlab")) {
      return "gitlab";
    }

    return "github";
  } catch {
    return "github";
  }
}

// ── GitHub implementation (inline, no extra import needed) ─────────────

function normalizeGitHubError(operation: string, error: unknown): GitHostingCliError {
  if (error instanceof Error) {
    if (error.message.includes("Command not found: gh")) {
      return new GitHostingCliError({
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
      return new GitHostingCliError({
        operation,
        detail: "GitHub CLI is not authenticated. Run `gh auth login` and retry.",
        cause: error,
      });
    }
    return new GitHostingCliError({
      operation,
      detail: `GitHub CLI command failed: ${error.message}`,
      cause: error,
    });
  }
  return new GitHostingCliError({ operation, detail: "GitHub CLI command failed.", cause: error });
}

function normalizeGitLabError(operation: string, error: unknown): GitHostingCliError {
  if (error instanceof Error) {
    if (error.message.includes("Command not found: glab")) {
      return new GitHostingCliError({
        operation,
        detail: "GitLab CLI (`glab`) is required but not available on PATH.",
        cause: error,
      });
    }
    const lower = error.message.toLowerCase();
    if (
      lower.includes("authentication failed") ||
      lower.includes("not logged in") ||
      lower.includes("glab auth login") ||
      lower.includes("401")
    ) {
      return new GitHostingCliError({
        operation,
        detail: "GitLab CLI is not authenticated. Run `glab auth login` and retry.",
        cause: error,
      });
    }
    return new GitHostingCliError({
      operation,
      detail: `GitLab CLI command failed: ${error.message}`,
      cause: error,
    });
  }
  return new GitHostingCliError({ operation, detail: "GitLab CLI command failed.", cause: error });
}

function parseGitHubPrList(raw: string): ReadonlyArray<{
  number: number;
  title: string;
  url: string;
  baseRefName: string;
  headRefName: string;
}> {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return [];
  const parsed: unknown = JSON.parse(trimmed);
  if (!Array.isArray(parsed)) throw new Error("GitHub CLI returned non-array JSON.");
  const result: Array<{ number: number; title: string; url: string; baseRefName: string; headRefName: string }> = [];
  for (const entry of parsed) {
    if (!entry || typeof entry !== "object") continue;
    const r = entry as Record<string, unknown>;
    if (
      typeof r.number !== "number" || !Number.isInteger(r.number) || r.number <= 0 ||
      typeof r.title !== "string" || typeof r.url !== "string" ||
      typeof r.baseRefName !== "string" || typeof r.headRefName !== "string"
    ) continue;
    result.push({ number: r.number, title: r.title, url: r.url, baseRefName: r.baseRefName, headRefName: r.headRefName });
  }
  return result;
}

function parseGitLabMrList(raw: string): ReadonlyArray<{
  number: number;
  title: string;
  url: string;
  baseRefName: string;
  headRefName: string;
}> {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return [];
  const parsed: unknown = JSON.parse(trimmed);
  if (!Array.isArray(parsed)) throw new Error("GitLab CLI returned non-array JSON.");
  const result: Array<{ number: number; title: string; url: string; baseRefName: string; headRefName: string }> = [];
  for (const entry of parsed) {
    if (!entry || typeof entry !== "object") continue;
    const r = entry as Record<string, unknown>;
    if (
      typeof r.iid !== "number" || !Number.isInteger(r.iid) || r.iid <= 0 ||
      typeof r.title !== "string" || typeof r.web_url !== "string" ||
      typeof r.source_branch !== "string" || typeof r.target_branch !== "string"
    ) continue;
    result.push({ number: r.iid, title: r.title, url: r.web_url, baseRefName: r.target_branch, headRefName: r.source_branch });
  }
  return result;
}

const makeGitHostingCliDispatcher = Effect.sync(() => {
  const service: GitHostingCliShape = {
    execute: (input) => {
      const provider = detectHostingProvider(input.cwd);
      const binary = provider === "gitlab" ? "glab" : "gh";
      const normalizeError = provider === "gitlab" ? normalizeGitLabError : normalizeGitHubError;
      return Effect.tryPromise({
        try: () =>
          runProcess(binary, input.args, {
            cwd: input.cwd,
            timeoutMs: input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
          }),
        catch: (error) => normalizeError("execute", error),
      });
    },

    listOpenPullRequests: (input) => {
      const provider = detectHostingProvider(input.cwd);
      if (provider === "gitlab") {
        return Effect.tryPromise({
          try: () =>
            runProcess("glab", [
              "mr", "list",
              "--source-branch", input.headBranch,
              "--per-page", String(input.limit ?? 1),
              "--output", "json",
            ], { cwd: input.cwd, timeoutMs: DEFAULT_TIMEOUT_MS }),
          catch: (error) => normalizeGitLabError("listOpenPullRequests", error),
        }).pipe(
          Effect.map((result) => result.stdout),
          Effect.flatMap((raw) =>
            Effect.try({
              try: () => parseGitLabMrList(raw),
              catch: (error: unknown) =>
                new GitHostingCliError({
                  operation: "listOpenPullRequests",
                  detail: error instanceof Error
                    ? `GitLab CLI returned invalid MR list JSON: ${error.message}`
                    : "GitLab CLI returned invalid MR list JSON.",
                  ...(error !== undefined ? { cause: error } : {}),
                }),
            }),
          ),
        );
      }

      return Effect.tryPromise({
        try: () =>
          runProcess("gh", [
            "pr", "list",
            "--head", input.headBranch,
            "--state", "open",
            "--limit", String(input.limit ?? 1),
            "--json", "number,title,url,baseRefName,headRefName",
          ], { cwd: input.cwd, timeoutMs: DEFAULT_TIMEOUT_MS }),
        catch: (error) => normalizeGitHubError("listOpenPullRequests", error),
      }).pipe(
        Effect.map((result) => result.stdout),
        Effect.flatMap((raw) =>
          Effect.try({
            try: () => parseGitHubPrList(raw),
            catch: (error: unknown) =>
              new GitHostingCliError({
                operation: "listOpenPullRequests",
                detail: error instanceof Error
                  ? `GitHub CLI returned invalid PR list JSON: ${error.message}`
                  : "GitHub CLI returned invalid PR list JSON.",
                ...(error !== undefined ? { cause: error } : {}),
              }),
          }),
        ),
      );
    },

    createPullRequest: (input) => {
      const provider = detectHostingProvider(input.cwd);
      if (provider === "gitlab") {
        return Effect.tryPromise({
          try: async () => {
            const { promises: fsp } = await import("node:fs");
            const body = await fsp.readFile(input.bodyFile, "utf-8");
            return runProcess("glab", [
              "mr", "create",
              "--target-branch", input.baseBranch,
              "--source-branch", input.headBranch,
              "--title", input.title,
              "--description", body,
              "--yes",
            ], { cwd: input.cwd, timeoutMs: DEFAULT_TIMEOUT_MS });
          },
          catch: (error) => normalizeGitLabError("createPullRequest", error),
        }).pipe(Effect.asVoid);
      }

      return Effect.tryPromise({
        try: () =>
          runProcess("gh", [
            "pr", "create",
            "--base", input.baseBranch,
            "--head", input.headBranch,
            "--title", input.title,
            "--body-file", input.bodyFile,
          ], { cwd: input.cwd, timeoutMs: DEFAULT_TIMEOUT_MS }),
        catch: (error) => normalizeGitHubError("createPullRequest", error),
      }).pipe(Effect.asVoid);
    },

    getDefaultBranch: (input) => {
      const provider = detectHostingProvider(input.cwd);
      if (provider === "gitlab") {
        return Effect.tryPromise({
          try: () =>
            runProcess("glab", ["repo", "view", "--output", "json"], {
              cwd: input.cwd,
              timeoutMs: DEFAULT_TIMEOUT_MS,
            }),
          catch: (error) => normalizeGitLabError("getDefaultBranch", error),
        }).pipe(
          Effect.flatMap((value) =>
            Effect.try({
              try: () => {
                const parsed = JSON.parse(value.stdout.trim()) as Record<string, unknown>;
                const defaultBranch = parsed.default_branch;
                return typeof defaultBranch === "string" && defaultBranch.length > 0
                  ? defaultBranch
                  : null;
              },
              catch: () =>
                new GitHostingCliError({
                  operation: "getDefaultBranch",
                  detail: "GitLab CLI returned invalid repo view JSON.",
                }),
            }),
          ),
        );
      }

      return Effect.tryPromise({
        try: () =>
          runProcess("gh", [
            "repo", "view",
            "--json", "defaultBranchRef",
            "--jq", ".defaultBranchRef.name",
          ], { cwd: input.cwd, timeoutMs: DEFAULT_TIMEOUT_MS }),
        catch: (error) => normalizeGitHubError("getDefaultBranch", error),
      }).pipe(
        Effect.map((value) => {
          const trimmed = value.stdout.trim();
          return trimmed.length > 0 ? trimmed : null;
        }),
      );
    },
  };

  return service;
});

export const GitHostingCliLive = Layer.effect(GitHostingCli, makeGitHostingCliDispatcher);
