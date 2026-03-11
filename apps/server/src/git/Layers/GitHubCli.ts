import { Effect, Layer, Schema } from "effect";
import { PositiveInt, TrimmedNonEmptyString } from "@t3tools/contracts";

import { runProcess } from "../../processRunner";
import { GitHubCliError } from "../Errors.ts";
import {
  GitHubCli,
  type GitHubRepositoryCloneUrls,
  type GitHubCliShape,
  type GitHubPullRequestSummary,
} from "../Services/GitHubCli.ts";

const DEFAULT_TIMEOUT_MS = 30_000;
const LOGIN_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_HOSTNAME = "github.com";

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

function normalizePullRequestState(input: {
  state?: string | null | undefined;
  mergedAt?: string | null | undefined;
}): "open" | "closed" | "merged" {
  const mergedAt = input.mergedAt;
  const state = input.state;
  if ((typeof mergedAt === "string" && mergedAt.trim().length > 0) || state === "MERGED") {
    return "merged";
  }
  if (state === "CLOSED") {
    return "closed";
  }
  return "open";
}

const RawGitHubPullRequestSchema = Schema.Struct({
  number: PositiveInt,
  title: TrimmedNonEmptyString,
  url: TrimmedNonEmptyString,
  baseRefName: TrimmedNonEmptyString,
  headRefName: TrimmedNonEmptyString,
  state: Schema.optional(Schema.NullOr(Schema.String)),
  mergedAt: Schema.optional(Schema.NullOr(Schema.String)),
  isCrossRepository: Schema.optional(Schema.Boolean),
  headRepository: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        nameWithOwner: Schema.String,
      }),
    ),
  ),
  headRepositoryOwner: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        login: Schema.String,
      }),
    ),
  ),
});

const RawGitHubRepositoryCloneUrlsSchema = Schema.Struct({
  nameWithOwner: TrimmedNonEmptyString,
  url: TrimmedNonEmptyString,
  sshUrl: TrimmedNonEmptyString,
});

function normalizePullRequestSummary(
  raw: Schema.Schema.Type<typeof RawGitHubPullRequestSchema>,
): GitHubPullRequestSummary {
  const headRepositoryNameWithOwner = raw.headRepository?.nameWithOwner ?? null;
  const headRepositoryOwnerLogin =
    raw.headRepositoryOwner?.login ??
    (typeof headRepositoryNameWithOwner === "string" && headRepositoryNameWithOwner.includes("/")
      ? (headRepositoryNameWithOwner.split("/")[0] ?? null)
      : null);
  return {
    number: raw.number,
    title: raw.title,
    url: raw.url,
    baseRefName: raw.baseRefName,
    headRefName: raw.headRefName,
    state: normalizePullRequestState(raw),
    ...(typeof raw.isCrossRepository === "boolean"
      ? { isCrossRepository: raw.isCrossRepository }
      : {}),
    ...(headRepositoryNameWithOwner ? { headRepositoryNameWithOwner } : {}),
    ...(headRepositoryOwnerLogin ? { headRepositoryOwnerLogin } : {}),
  };
}

function normalizeRepositoryCloneUrls(
  raw: Schema.Schema.Type<typeof RawGitHubRepositoryCloneUrlsSchema>,
): GitHubRepositoryCloneUrls {
  return {
    nameWithOwner: raw.nameWithOwner,
    url: raw.url,
    sshUrl: raw.sshUrl,
  };
}

function decodeGitHubJson<S extends Schema.Top>(
  raw: string,
  schema: S,
  operation: "listOpenPullRequests" | "getPullRequest" | "getRepositoryCloneUrls",
  invalidDetail: string,
): Effect.Effect<S["Type"], GitHubCliError, S["DecodingServices"]> {
  return Schema.decodeEffect(Schema.fromJsonString(schema))(raw).pipe(
    Effect.mapError(
      (error) =>
        new GitHubCliError({
          operation,
          detail: error instanceof Error ? `${invalidDetail}: ${error.message}` : invalidDetail,
          cause: error,
        }),
    ),
  );
}

function parseAuthStatus(raw: string, hostname: string): {
  state: string;
  active: boolean;
  host: string;
  login: string | null;
  tokenSource: string | null;
  scopes: ReadonlyArray<string>;
  gitProtocol: "https" | "ssh" | null;
} | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;

  const parsed: unknown = JSON.parse(trimmed);
  if (!parsed || typeof parsed !== "object") {
    throw new Error("GitHub CLI returned invalid auth status JSON.");
  }

  const hosts = (parsed as { hosts?: unknown }).hosts;
  if (!hosts || typeof hosts !== "object") {
    return null;
  }

  const accounts = (hosts as Record<string, unknown>)[hostname];
  if (!Array.isArray(accounts) || accounts.length === 0) {
    return null;
  }

  const candidate =
    accounts.find(
      (entry) =>
        entry && typeof entry === "object" && (entry as { active?: unknown }).active === true,
    ) ?? accounts[0];
  if (!candidate || typeof candidate !== "object") {
    return null;
  }

  const record = candidate as Record<string, unknown>;
  const gitProtocol = record.gitProtocol;
  const scopes = record.scopes;

  return {
    state: typeof record.state === "string" ? record.state : "unknown",
    active: record.active === true,
    host: typeof record.host === "string" ? record.host : hostname,
    login: typeof record.login === "string" && record.login.trim().length > 0 ? record.login : null,
    tokenSource:
      typeof record.tokenSource === "string" && record.tokenSource.trim().length > 0
        ? record.tokenSource
        : null,
    scopes:
      typeof scopes === "string"
        ? scopes
            .split(",")
            .map((scope) => scope.trim())
            .filter((scope) => scope.length > 0)
        : [],
    gitProtocol: gitProtocol === "https" || gitProtocol === "ssh" ? gitProtocol : null,
  };
}

function parseRepository(raw: string): {
  nameWithOwner: string;
  url: string;
  description: string | null;
  defaultBranch: string | null;
} | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;

  const parsed: unknown = JSON.parse(trimmed);
  if (!parsed || typeof parsed !== "object") {
    throw new Error("GitHub CLI returned invalid repository JSON.");
  }

  const record = parsed as Record<string, unknown>;
  const nameWithOwner = record.nameWithOwner;
  const url = record.url;
  const description = record.description;
  const defaultBranchRef = record.defaultBranchRef;

  if (typeof nameWithOwner !== "string" || typeof url !== "string") {
    return null;
  }

  let defaultBranch: string | null = null;
  if (defaultBranchRef && typeof defaultBranchRef === "object") {
    const name = (defaultBranchRef as { name?: unknown }).name;
    if (typeof name === "string" && name.trim().length > 0) {
      defaultBranch = name;
    }
  }

  return {
    nameWithOwner,
    url,
    description: typeof description === "string" ? description : null,
    defaultBranch,
  };
}

function parseIssues(raw: string): ReadonlyArray<{
  number: number;
  title: string;
  state: "open" | "closed";
  url: string;
  createdAt: string;
  updatedAt: string;
  labels: ReadonlyArray<{
    name: string;
    color: string | null;
  }>;
  assignees: ReadonlyArray<{
    login: string;
  }>;
  author: string | null;
}> {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return [];

  const parsed: unknown = JSON.parse(trimmed);
  if (!Array.isArray(parsed)) {
    throw new Error("GitHub CLI returned invalid issue list JSON.");
  }

  const issues: Array<{
    number: number;
    title: string;
    state: "open" | "closed";
    url: string;
    createdAt: string;
    updatedAt: string;
    labels: ReadonlyArray<{
      name: string;
      color: string | null;
    }>;
    assignees: ReadonlyArray<{
      login: string;
    }>;
    author: string | null;
  }> = [];

  for (const entry of parsed) {
    if (!entry || typeof entry !== "object") {
      continue;
    }

    const record = entry as Record<string, unknown>;
    const state = record.state;
    const number = record.number;
    const title = record.title;
    const url = record.url;
    const createdAt = record.createdAt;
    const updatedAt = record.updatedAt;

    if (
      typeof number !== "number" ||
      !Number.isInteger(number) ||
      number <= 0 ||
      typeof title !== "string" ||
      typeof url !== "string" ||
      typeof createdAt !== "string" ||
      typeof updatedAt !== "string"
    ) {
      continue;
    }

    const normalizedState = state === "CLOSED" ? "closed" : state === "OPEN" ? "open" : null;
    if (!normalizedState) {
      continue;
    }

    const labels = Array.isArray(record.labels)
      ? record.labels
          .flatMap((label) => {
            if (!label || typeof label !== "object") {
              return [];
            }
            const labelRecord = label as Record<string, unknown>;
            const name = labelRecord.name;
            const color = labelRecord.color;
            if (typeof name !== "string" || name.trim().length === 0) {
              return [];
            }
            return [{ name, color: typeof color === "string" && color.trim().length > 0 ? color : null }];
          })
      : [];

    const assignees = Array.isArray(record.assignees)
      ? record.assignees.flatMap((assignee) => {
          if (!assignee || typeof assignee !== "object") {
            return [];
          }
          const login = (assignee as Record<string, unknown>).login;
          if (typeof login !== "string" || login.trim().length === 0) {
            return [];
          }
          return [{ login }];
        })
      : [];

    const authorRecord = record.author;
    const author =
      authorRecord && typeof authorRecord === "object"
        ? (authorRecord as { login?: unknown }).login
        : null;

    issues.push({
      number,
      title,
      state: normalizedState,
      url,
      createdAt,
      updatedAt,
      labels,
      assignees,
      author: typeof author === "string" && author.trim().length > 0 ? author : null,
    });
  }

  return issues;
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
          input.headSelector,
          "--state",
          "open",
          "--limit",
          String(input.limit ?? 1),
          "--json",
          "number,title,url,baseRefName,headRefName",
        ],
      }).pipe(
        Effect.map((result) => result.stdout.trim()),
        Effect.flatMap((raw) =>
          raw.length === 0
            ? Effect.succeed([])
            : decodeGitHubJson(
                raw,
                Schema.Array(RawGitHubPullRequestSchema),
                "listOpenPullRequests",
                "GitHub CLI returned invalid PR list JSON.",
              ),
        ),
        Effect.map((pullRequests) => pullRequests.map(normalizePullRequestSummary)),
      ),
    getPullRequest: (input) =>
      execute({
        cwd: input.cwd,
        args: [
          "pr",
          "view",
          input.reference,
          "--json",
          "number,title,url,baseRefName,headRefName,state,mergedAt,isCrossRepository,headRepository,headRepositoryOwner",
        ],
      }).pipe(
        Effect.map((result) => result.stdout.trim()),
        Effect.flatMap((raw) =>
          decodeGitHubJson(
            raw,
            RawGitHubPullRequestSchema,
            "getPullRequest",
            "GitHub CLI returned invalid pull request JSON.",
          ),
        ),
        Effect.map(normalizePullRequestSummary),
      ),
    getRepositoryCloneUrls: (input) =>
      execute({
        cwd: input.cwd,
        args: ["repo", "view", input.repository, "--json", "nameWithOwner,url,sshUrl"],
      }).pipe(
        Effect.map((result) => result.stdout.trim()),
        Effect.flatMap((raw) =>
          decodeGitHubJson(
            raw,
            RawGitHubRepositoryCloneUrlsSchema,
            "getRepositoryCloneUrls",
            "GitHub CLI returned invalid repository JSON.",
          ),
        ),
        Effect.map(normalizeRepositoryCloneUrls),
      ),
    checkoutPullRequest: (input) =>
      execute({
        cwd: input.cwd,
        args: ["pr", "checkout", input.reference, ...(input.force ? ["--force"] : [])],
      }).pipe(Effect.asVoid),
    createPullRequest: (input) =>
      execute({
        cwd: input.cwd,
        args: [
          "pr",
          "create",
          "--base",
          input.baseBranch,
          "--head",
          input.headSelector,
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
    getAuthStatus: (input) => {
      const hostname = input?.hostname ?? DEFAULT_HOSTNAME;
      return execute({
        ...(input?.cwd ? { cwd: input.cwd } : {}),
        args: ["auth", "status", "--hostname", hostname, "--json", "hosts"],
      }).pipe(
        Effect.map((result) => result.stdout),
        Effect.flatMap((raw) =>
          Effect.try({
            try: () => parseAuthStatus(raw, hostname),
            catch: (error: unknown) =>
              new GitHubCliError({
                operation: "getAuthStatus",
                detail:
                  error instanceof Error
                    ? `GitHub CLI returned invalid auth status JSON: ${error.message}`
                    : "GitHub CLI returned invalid auth status JSON.",
                ...(error !== undefined ? { cause: error } : {}),
              }),
          }),
        ),
      );
    },
    loginWithBrowser: (input) =>
      execute({
        ...(input?.cwd ? { cwd: input.cwd } : {}),
        timeoutMs: LOGIN_TIMEOUT_MS,
        args: [
          "auth",
          "login",
          "--hostname",
          input?.hostname ?? DEFAULT_HOSTNAME,
          "--git-protocol",
          input?.gitProtocol ?? "https",
          "--web",
        ],
      }).pipe(Effect.asVoid),
    getRepository: (input) =>
      execute({
        ...(input.cwd ? { cwd: input.cwd } : {}),
        args: [
          "repo",
          "view",
          ...(input.repo ? [input.repo] : []),
          "--json",
          "nameWithOwner,url,description,defaultBranchRef",
        ],
      }).pipe(
        Effect.map((result) => result.stdout),
        Effect.flatMap((raw) =>
          Effect.try({
            try: () => parseRepository(raw),
            catch: (error: unknown) =>
              new GitHubCliError({
                operation: "getRepository",
                detail:
                  error instanceof Error
                    ? `GitHub CLI returned invalid repository JSON: ${error.message}`
                    : "GitHub CLI returned invalid repository JSON.",
                ...(error !== undefined ? { cause: error } : {}),
              }),
          }),
        ),
      ),
    listIssues: (input) =>
      execute({
        ...(input.cwd ? { cwd: input.cwd } : {}),
        args: [
          "issue",
          "list",
          ...(input.repo ? ["--repo", input.repo] : []),
          "--state",
          input.state ?? "open",
          "--limit",
          String(input.limit ?? 25),
          "--json",
          "number,title,state,url,createdAt,updatedAt,labels,assignees,author",
        ],
      }).pipe(
        Effect.map((result) => result.stdout),
        Effect.flatMap((raw) =>
          Effect.try({
            try: () => parseIssues(raw),
            catch: (error: unknown) =>
              new GitHubCliError({
                operation: "listIssues",
                detail:
                  error instanceof Error
                    ? `GitHub CLI returned invalid issue list JSON: ${error.message}`
                    : "GitHub CLI returned invalid issue list JSON.",
                ...(error !== undefined ? { cause: error } : {}),
              }),
          }),
        ),
      ),
  } satisfies GitHubCliShape;

  return service;
});

export const GitHubCliLive = Layer.effect(GitHubCli, makeGitHubCli);
