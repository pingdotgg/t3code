/**
 * GitHostingCliDispatcher - Selects the correct hosting CLI (gh or glab)
 * based on the repository's origin remote URL.
 *
 * For GitHub repositories, delegates to the existing GitHubCli service
 * (which owns Schema-validated parsing and error normalization).
 * For GitLab repositories, implements glab CLI calls inline.
 *
 * Detection runs `git remote get-url origin` and matches the hostname.
 * Falls back to GitHub for unknown or missing remotes, preserving full
 * backwards compatibility.
 */
import { spawnSync } from "node:child_process";

import { Effect, Layer } from "effect";

import { runProcess } from "../../processRunner";
import { GitHostingCliError } from "../Errors.ts";
import { GitHubCli } from "../Services/GitHubCli.ts";
import {
  GitHostingCli,
  type GitHostingCliShape,
  type PullRequestSummary,
  type RepositoryCloneUrls,
} from "../Services/GitHostingCli.ts";

const DEFAULT_TIMEOUT_MS = 30_000;

type HostingProvider = "github" | "gitlab";

// ── Provider detection with per-repo caching ──────────────────────────

const providerCache = new Map<string, HostingProvider>();

// ── Auth status cache with TTL ────────────────────────────────────────

const AUTH_STATUS_TTL_MS = 60_000;

interface AuthCacheEntry {
  value: boolean | null;
  expiresAt: number;
}

const authStatusCache = new Map<HostingProvider, AuthCacheEntry>();

/**
 * Check whether the hosting CLI is authenticated by running
 * `gh auth status` or `glab auth status`.
 *
 * Uses a per-provider in-memory cache with 60s TTL to avoid
 * running the check on every status poll.
 */
function checkHostingAuthStatus(provider: HostingProvider): boolean | null {
  const now = Date.now();
  const cached = authStatusCache.get(provider);
  if (cached && now < cached.expiresAt) {
    return cached.value;
  }

  let value: boolean | null = null;
  try {
    const cmd = provider === "github" ? "gh" : "glab";
    const result = spawnSync(cmd, ["auth", "status"], {
      encoding: "utf-8",
      timeout: 5_000,
      // Merge stderr into stdout — both CLIs write status output to stderr.
      stdio: ["ignore", "pipe", "pipe"],
    });

    if (result.error) {
      // CLI not found or timed out.
      value = null;
    } else {
      value = result.status === 0;
    }
  } catch {
    value = null;
  }

  authStatusCache.set(provider, { value, expiresAt: now + AUTH_STATUS_TTL_MS });
  return value;
}

/**
 * Detect the hosting provider from the origin remote URL.
 *
 * Uses synchronous spawn to keep the detection simple. Results are
 * cached per `cwd` so we only run `git remote get-url origin` once
 * per repository path.
 *
 * Returns "github" as the default when detection is inconclusive.
 */
function detectHostingProvider(cwd: string): HostingProvider {
  const cached = providerCache.get(cwd);
  if (cached !== undefined) {
    return cached;
  }

  let provider: HostingProvider = "github";
  try {
    const result = spawnSync("git", ["remote", "get-url", "origin"], {
      cwd,
      encoding: "utf-8",
      timeout: 5_000,
    });

    if (result.status === 0 && result.stdout) {
      const url = result.stdout.trim().toLowerCase();
      try {
        const hostname = new URL(url.replace(/^git@([^:]+):/, "https://$1/")).hostname;
        if (hostname === "gitlab.com" || hostname.endsWith(".gitlab.com")) {
          provider = "gitlab";
        }
      } catch {
        // Fall through to default
      }
    }
  } catch {
    // Fall through to default
  }

  providerCache.set(cwd, provider);
  return provider;
}

// ── GitLab helpers ────────────────────────────────────────────────────

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
    if (
      lower.includes("merge request not found") ||
      lower.includes("404 not found") ||
      lower.includes("no merge requests found")
    ) {
      return new GitHostingCliError({
        operation,
        detail: "Merge request not found. Check the MR number or URL and try again.",
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

function normalizeGitLabState(state: string | null | undefined): "open" | "closed" | "merged" {
  if (!state) return "open";
  const lower = state.toLowerCase();
  if (lower === "merged") return "merged";
  if (lower === "closed") return "closed";
  return "open";
}

function parseGitLabMrList(raw: string): ReadonlyArray<PullRequestSummary> {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return [];
  const parsed: unknown = JSON.parse(trimmed);
  if (!Array.isArray(parsed)) throw new Error("GitLab CLI returned non-array JSON.");
  const result: PullRequestSummary[] = [];
  for (const entry of parsed) {
    if (!entry || typeof entry !== "object") continue;
    const r = entry as Record<string, unknown>;
    if (
      typeof r.iid !== "number" ||
      !Number.isInteger(r.iid) ||
      r.iid <= 0 ||
      typeof r.title !== "string" ||
      typeof r.web_url !== "string" ||
      typeof r.source_branch !== "string" ||
      typeof r.target_branch !== "string"
    )
      continue;

    const isCrossRepository =
      typeof r.source_project_id === "number" &&
      typeof r.target_project_id === "number" &&
      r.source_project_id !== r.target_project_id;

    result.push({
      number: r.iid,
      title: r.title,
      url: r.web_url,
      baseRefName: r.target_branch,
      headRefName: r.source_branch,
      state: normalizeGitLabState(r.state as string | null | undefined),
      updatedAt: typeof r.updated_at === "string" && r.updated_at.length > 0 ? r.updated_at : null,
      isCrossRepository,
    });
  }
  return result;
}

function parseGitLabMrView(raw: string): PullRequestSummary {
  const trimmed = raw.trim();
  const parsed = JSON.parse(trimmed) as Record<string, unknown>;
  if (
    typeof parsed.iid !== "number" ||
    typeof parsed.title !== "string" ||
    typeof parsed.web_url !== "string" ||
    typeof parsed.source_branch !== "string" ||
    typeof parsed.target_branch !== "string"
  ) {
    throw new Error("GitLab CLI returned invalid MR JSON.");
  }

  const isCrossRepository =
    typeof parsed.source_project_id === "number" &&
    typeof parsed.target_project_id === "number" &&
    parsed.source_project_id !== parsed.target_project_id;

  return {
    number: parsed.iid,
    title: parsed.title,
    url: parsed.web_url,
    baseRefName: parsed.target_branch,
    headRefName: parsed.source_branch,
    state: normalizeGitLabState(parsed.state as string | null | undefined),
    isCrossRepository,
  };
}

function resolveGlabStateArgs(state: "open" | "closed" | "merged" | "all"): string[] {
  switch (state) {
    case "all":
      return ["--all"];
    case "closed":
      return ["--closed"];
    case "merged":
      return ["--merged"];
    case "open":
      return [];
  }
}

// ── Dispatcher ────────────────────────────────────────────────────────

const makeGitHostingCliDispatcher = Effect.gen(function* () {
  const gitHubCli = yield* GitHubCli;

  const service: GitHostingCliShape = {
    execute: (input) => {
      const provider = detectHostingProvider(input.cwd);
      if (provider === "github") {
        return gitHubCli.execute(input);
      }
      return Effect.tryPromise({
        try: () =>
          runProcess("glab", input.args, {
            cwd: input.cwd,
            timeoutMs: input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
          }),
        catch: (error) => normalizeGitLabError("execute", error),
      });
    },

    listOpenPullRequests: (input) => {
      const provider = detectHostingProvider(input.cwd);
      if (provider === "github") {
        return gitHubCli.listOpenPullRequests(input);
      }
      return Effect.tryPromise({
        try: () =>
          runProcess(
            "glab",
            [
              "mr",
              "list",
              "--source-branch",
              input.headSelector,
              "--per-page",
              String(input.limit ?? 1),
              "--output",
              "json",
            ],
            { cwd: input.cwd, timeoutMs: DEFAULT_TIMEOUT_MS },
          ),
        catch: (error) => normalizeGitLabError("listOpenPullRequests", error),
      }).pipe(
        Effect.map((result) => result.stdout),
        Effect.flatMap((raw) =>
          Effect.try({
            try: () => parseGitLabMrList(raw),
            catch: (error: unknown) =>
              new GitHostingCliError({
                operation: "listOpenPullRequests",
                detail:
                  error instanceof Error
                    ? `GitLab CLI returned invalid MR list JSON: ${error.message}`
                    : "GitLab CLI returned invalid MR list JSON.",
                ...(error !== undefined ? { cause: error } : {}),
              }),
          }),
        ),
      );
    },

    listPullRequests: (input) => {
      const provider = detectHostingProvider(input.cwd);
      if (provider === "github") {
        return gitHubCli.listPullRequests(input);
      }
      const stateArgs = resolveGlabStateArgs(input.state);
      return Effect.tryPromise({
        try: () =>
          runProcess(
            "glab",
            [
              "mr",
              "list",
              "--source-branch",
              input.headSelector,
              ...stateArgs,
              "--per-page",
              String(input.limit ?? 20),
              "--output",
              "json",
            ],
            { cwd: input.cwd, timeoutMs: DEFAULT_TIMEOUT_MS },
          ),
        catch: (error) => normalizeGitLabError("listPullRequests", error),
      }).pipe(
        Effect.map((result) => result.stdout),
        Effect.flatMap((raw) =>
          Effect.try({
            try: () => parseGitLabMrList(raw),
            catch: (error: unknown) =>
              new GitHostingCliError({
                operation: "listPullRequests",
                detail:
                  error instanceof Error
                    ? `GitLab CLI returned invalid MR list JSON: ${error.message}`
                    : "GitLab CLI returned invalid MR list JSON.",
                ...(error !== undefined ? { cause: error } : {}),
              }),
          }),
        ),
      );
    },

    getPullRequest: (input) => {
      const provider = detectHostingProvider(input.cwd);
      if (provider === "github") {
        return gitHubCli.getPullRequest(input);
      }
      return Effect.tryPromise({
        try: () =>
          runProcess("glab", ["mr", "view", input.reference, "--output", "json"], {
            cwd: input.cwd,
            timeoutMs: DEFAULT_TIMEOUT_MS,
          }),
        catch: (error) => normalizeGitLabError("getPullRequest", error),
      }).pipe(
        Effect.map((result) => result.stdout),
        Effect.flatMap((raw) =>
          Effect.try({
            try: () => parseGitLabMrView(raw),
            catch: (error: unknown) =>
              new GitHostingCliError({
                operation: "getPullRequest",
                detail:
                  error instanceof Error
                    ? `GitLab CLI returned invalid MR JSON: ${error.message}`
                    : "GitLab CLI returned invalid MR JSON.",
                ...(error !== undefined ? { cause: error } : {}),
              }),
          }),
        ),
      );
    },

    getRepositoryCloneUrls: (input) => {
      const provider = detectHostingProvider(input.cwd);
      if (provider === "github") {
        return gitHubCli.getRepositoryCloneUrls(input);
      }

      // GitLab's glab CLI does not have a direct equivalent of `gh repo view`
      // that returns clone URLs for an arbitrary repository. For cross-repo
      // forks, the MR response already carries the source project info. We
      // construct a best-effort response from the repository identifier.
      return Effect.tryPromise({
        try: () =>
          runProcess("glab", ["repo", "view", input.repository, "--output", "json"], {
            cwd: input.cwd,
            timeoutMs: DEFAULT_TIMEOUT_MS,
          }),
        catch: (error) => normalizeGitLabError("getRepositoryCloneUrls", error),
      }).pipe(
        Effect.flatMap((result) =>
          Effect.try({
            try: () => {
              const parsed = JSON.parse(result.stdout.trim()) as Record<string, unknown>;
              const httpUrl =
                typeof parsed.http_url_to_repo === "string" ? parsed.http_url_to_repo : "";
              const sshUrl =
                typeof parsed.ssh_url_to_repo === "string" ? parsed.ssh_url_to_repo : "";
              const pathWithNamespace =
                typeof parsed.path_with_namespace === "string"
                  ? parsed.path_with_namespace
                  : input.repository;
              return {
                nameWithOwner: pathWithNamespace,
                url: httpUrl,
                sshUrl,
              } satisfies RepositoryCloneUrls;
            },
            catch: (error: unknown) =>
              new GitHostingCliError({
                operation: "getRepositoryCloneUrls",
                detail:
                  error instanceof Error
                    ? `GitLab CLI returned invalid repo JSON: ${error.message}`
                    : "GitLab CLI returned invalid repo JSON.",
                ...(error !== undefined ? { cause: error } : {}),
              }),
          }),
        ),
      );
    },

    createPullRequest: (input) => {
      const provider = detectHostingProvider(input.cwd);
      if (provider === "github") {
        return gitHubCli.createPullRequest(input);
      }
      return Effect.tryPromise({
        try: async () => {
          const { promises: fsp } = await import("node:fs");
          const body = await fsp.readFile(input.bodyFile, "utf-8");
          return runProcess(
            "glab",
            [
              "mr",
              "create",
              "--target-branch",
              input.baseBranch,
              "--source-branch",
              input.headSelector,
              "--title",
              input.title,
              "--description",
              body,
              "--yes",
            ],
            { cwd: input.cwd, timeoutMs: DEFAULT_TIMEOUT_MS },
          );
        },
        catch: (error) => normalizeGitLabError("createPullRequest", error),
      }).pipe(Effect.asVoid);
    },

    getDefaultBranch: (input) => {
      const provider = detectHostingProvider(input.cwd);
      if (provider === "github") {
        return gitHubCli.getDefaultBranch(input);
      }
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
    },

    checkoutPullRequest: (input) => {
      const provider = detectHostingProvider(input.cwd);
      if (provider === "github") {
        return gitHubCli.checkoutPullRequest(input);
      }
      return Effect.tryPromise({
        try: () =>
          runProcess("glab", ["mr", "checkout", input.reference], {
            cwd: input.cwd,
            timeoutMs: DEFAULT_TIMEOUT_MS,
          }),
        catch: (error) => normalizeGitLabError("checkoutPullRequest", error),
      }).pipe(Effect.asVoid);
    },

    getHostingPlatform: (cwd) => detectHostingProvider(cwd),

    checkAuthStatus: (cwd) => checkHostingAuthStatus(detectHostingProvider(cwd)),
  };

  return service;
});

export const GitHostingCliLive = Layer.effect(GitHostingCli, makeGitHostingCliDispatcher);
