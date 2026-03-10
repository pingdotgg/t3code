import type { Sandbox } from "@daytonaio/sdk";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { quoteShellArg, runSandboxCommand, sanitizeCause, sanitizeText } from "./git.commands";
import { repositoryLabel } from "./github";
import {
  GitHubPullRequestApiError,
  InvalidPullRequestOptionsError,
  PullRequestCommandError,
} from "./pr-service.errors";
import type {
  CreateGitHubPullRequestOptions,
  DeferredGitHubPullRequestResult,
  GitHubPullRequestResult,
  PrServiceShape,
} from "./pr-service";
import { PrService } from "./pr-service";
import type { GitHubRepository } from "./repo.service";

interface GitHubPullRequestSummary {
  readonly number: number;
  readonly title: string;
  readonly url: string;
  readonly baseBranch: string;
  readonly headBranch: string;
}

const DEFAULT_PULL_REQUEST_RESULT = (
  baseBranch: string,
  headBranch: string,
): DeferredGitHubPullRequestResult => ({
  status: "deferred_no_changes",
  baseBranch,
  headBranch,
});

function executePullRequestCommandForStdout(
  sandbox: Sandbox,
  command: string,
  cwd: string,
  secretValues: ReadonlyArray<string>,
): Effect.Effect<string, PullRequestCommandError> {
  return Effect.tryPromise({
    try: () => runSandboxCommand(sandbox, command, cwd),
    catch: (cause) =>
      new PullRequestCommandError({
        message: sanitizeText(
          `Failed to run pull request command in "${cwd}" for sandbox ${sandbox.id}.`,
          secretValues,
        ),
        sandboxId: sandbox.id,
        cwd,
        cause: sanitizeCause(cause, secretValues),
      }),
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
        new PullRequestCommandError({
          message: sanitizeText(
            `Pull request command failed in "${cwd}" for sandbox ${sandbox.id}: ${detail}`,
            secretValues,
          ),
          sandboxId: sandbox.id,
          cwd,
          cause: detail,
        }),
      );
    }),
  );
}

function buildGitHubApiHeaders(token: string): Record<string, string> {
  return {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "User-Agent": "jevin-ai-sandbox",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

function readStringProperty(value: object, key: string): string | undefined {
  const property = Reflect.get(value, key);
  return typeof property === "string" ? property : undefined;
}

function readNumberProperty(value: object, key: string): number | undefined {
  const property = Reflect.get(value, key);
  return typeof property === "number" && Number.isInteger(property) ? property : undefined;
}

function parsePullRequestSummary(value: unknown): GitHubPullRequestSummary | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }

  const number = readNumberProperty(value, "number");
  const title = readStringProperty(value, "title");
  const url = readStringProperty(value, "html_url");
  const base = Reflect.get(value, "base");
  const head = Reflect.get(value, "head");

  if (
    number === undefined ||
    title === undefined ||
    url === undefined ||
    typeof base !== "object" ||
    base === null ||
    typeof head !== "object" ||
    head === null
  ) {
    return undefined;
  }

  const baseBranch = readStringProperty(base, "ref");
  const headBranch = readStringProperty(head, "ref");

  if (baseBranch === undefined || headBranch === undefined) {
    return undefined;
  }

  return {
    number,
    title,
    url,
    baseBranch,
    headBranch,
  } satisfies GitHubPullRequestSummary;
}

function parsePullRequestList(value: unknown): ReadonlyArray<GitHubPullRequestSummary> {
  if (!Array.isArray(value)) {
    return [];
  }

  const pullRequests: GitHubPullRequestSummary[] = [];
  for (const entry of value) {
    const parsedEntry = parsePullRequestSummary(entry);
    if (parsedEntry) {
      pullRequests.push(parsedEntry);
    }
  }

  return pullRequests;
}

function readResponseText(
  response: Response,
  error: GitHubPullRequestApiError,
): Effect.Effect<string, GitHubPullRequestApiError> {
  return Effect.tryPromise({
    try: () => response.text(),
    catch: (cause) =>
      new GitHubPullRequestApiError({
        message: error.message,
        operation: error.operation,
        repository: error.repository,
        statusCode: error.statusCode,
        cause,
      }),
  });
}

function validateCreatePullRequestOptions(
  options: CreateGitHubPullRequestOptions,
): Effect.Effect<CreateGitHubPullRequestOptions, InvalidPullRequestOptionsError> {
  const worktreePath = options.worktreePath.trim();
  const baseBranch = options.baseBranch.trim();
  const headBranch = options.headBranch.trim();
  const githubToken = options.githubToken.trim();
  const title = options.title.trim();

  if (worktreePath.length === 0) {
    return Effect.fail(
      new InvalidPullRequestOptionsError({
        message: "Worktree path is required to create a pull request.",
      }),
    );
  }

  if (baseBranch.length === 0 || headBranch.length === 0) {
    return Effect.fail(
      new InvalidPullRequestOptionsError({
        message: "Both base and head branch names are required to create a pull request.",
      }),
    );
  }

  if (githubToken.length === 0) {
    return Effect.fail(
      new InvalidPullRequestOptionsError({
        message: "GitHub token is required to create a pull request.",
      }),
    );
  }

  if (title.length === 0) {
    return Effect.fail(
      new InvalidPullRequestOptionsError({
        message: "Pull request title must not be empty.",
      }),
    );
  }

  return Effect.succeed({
    ...options,
    worktreePath,
    baseBranch,
    headBranch,
    githubToken,
    title,
    body: options.body?.trim() || undefined,
    draft: options.draft ?? false,
  });
}

function findExistingPullRequest(
  repository: GitHubRepository,
  baseBranch: string,
  headBranch: string,
  githubToken: string,
  secretValues: ReadonlyArray<string>,
): Effect.Effect<GitHubPullRequestSummary | undefined, GitHubPullRequestApiError> {
  const url = new URL(
    `https://api.github.com/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.repo)}/pulls`,
  );
  url.searchParams.set("state", "open");
  url.searchParams.set("head", `${repository.owner}:${headBranch}`);
  url.searchParams.set("base", baseBranch);

  return Effect.tryPromise({
    try: () =>
      fetch(url, {
        headers: buildGitHubApiHeaders(githubToken),
      }),
    catch: (cause) =>
      new GitHubPullRequestApiError({
        message: sanitizeText(
          `Failed to look up open pull requests for ${repositoryLabel(repository)}.`,
          secretValues,
        ),
        operation: "pullRequestLookup",
        repository: repositoryLabel(repository),
        cause: sanitizeCause(cause, secretValues),
      }),
  }).pipe(
    Effect.flatMap((response) => {
      if (!response.ok) {
        const lookupError = new GitHubPullRequestApiError({
          message: `GitHub pull request lookup failed for ${repositoryLabel(repository)} (${response.status} ${response.statusText}).`,
          operation: "pullRequestLookup",
          repository: repositoryLabel(repository),
          statusCode: response.status,
        });

        return readResponseText(response, lookupError).pipe(
          Effect.flatMap((body) =>
            Effect.fail(
              new GitHubPullRequestApiError({
                message: sanitizeText(
                  `GitHub pull request lookup failed for ${repositoryLabel(repository)} (${response.status} ${response.statusText}): ${body.trim() || "No response body."}`,
                  secretValues,
                ),
                operation: "pullRequestLookup",
                repository: repositoryLabel(repository),
                statusCode: response.status,
              }),
            ),
          ),
        );
      }

      return Effect.tryPromise({
        try: () => response.json(),
        catch: (cause) =>
          new GitHubPullRequestApiError({
            message: `GitHub pull request lookup returned invalid JSON for ${repositoryLabel(repository)}.`,
            operation: "pullRequestLookup",
            repository: repositoryLabel(repository),
            cause,
          }),
      }).pipe(Effect.map((body) => parsePullRequestList(body)[0]));
    }),
  );
}

function createGitHubPullRequest(
  repository: GitHubRepository,
  input: {
    readonly baseBranch: string;
    readonly headBranch: string;
    readonly title: string;
    readonly body?: string;
    readonly draft: boolean;
  },
  githubToken: string,
  secretValues: ReadonlyArray<string>,
): Effect.Effect<GitHubPullRequestSummary, GitHubPullRequestApiError> {
  return Effect.tryPromise({
    try: () =>
      fetch(
        `https://api.github.com/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.repo)}/pulls`,
        {
          method: "POST",
          headers: {
            ...buildGitHubApiHeaders(githubToken),
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            base: input.baseBranch,
            head: input.headBranch,
            title: input.title,
            body: input.body,
            draft: input.draft,
          }),
        },
      ),
    catch: (cause) =>
      new GitHubPullRequestApiError({
        message: sanitizeText(
          `Failed to create a pull request for ${repositoryLabel(repository)}.`,
          secretValues,
        ),
        operation: "pullRequestCreate",
        repository: repositoryLabel(repository),
        cause: sanitizeCause(cause, secretValues),
      }),
  }).pipe(
    Effect.flatMap((response) => {
      if (!response.ok) {
        const createError = new GitHubPullRequestApiError({
          message: `GitHub pull request creation failed for ${repositoryLabel(repository)} (${response.status} ${response.statusText}).`,
          operation: "pullRequestCreate",
          repository: repositoryLabel(repository),
          statusCode: response.status,
        });

        return readResponseText(response, createError).pipe(
          Effect.flatMap((body) =>
            Effect.fail(
              new GitHubPullRequestApiError({
                message: sanitizeText(
                  `GitHub pull request creation failed for ${repositoryLabel(repository)} (${response.status} ${response.statusText}): ${body.trim() || "No response body."}`,
                  secretValues,
                ),
                operation: "pullRequestCreate",
                repository: repositoryLabel(repository),
                statusCode: response.status,
              }),
            ),
          ),
        );
      }

      return Effect.tryPromise({
        try: () => response.json(),
        catch: (cause) =>
          new GitHubPullRequestApiError({
            message: `GitHub pull request creation returned invalid JSON for ${repositoryLabel(repository)}.`,
            operation: "pullRequestCreate",
            repository: repositoryLabel(repository),
            cause,
          }),
      }).pipe(
        Effect.flatMap((body) => {
          const createdPullRequest = parsePullRequestSummary(body);
          return createdPullRequest
            ? Effect.succeed(createdPullRequest)
            : Effect.fail(
                new GitHubPullRequestApiError({
                  message: `GitHub pull request creation returned an unexpected response for ${repositoryLabel(repository)}.`,
                  operation: "pullRequestCreate",
                  repository: repositoryLabel(repository),
                }),
              );
        }),
      );
    }),
  );
}

function makePrService(): PrServiceShape {
  return {
    createPullRequest(options) {
      return Effect.gen(function* () {
        const preparedOptions = yield* validateCreatePullRequestOptions(options);
        const secretValues = [preparedOptions.githubToken];
        const aheadCountRaw = yield* executePullRequestCommandForStdout(
          preparedOptions.sandbox,
          `git rev-list --count ${quoteShellArg(`origin/${preparedOptions.baseBranch}`)}..HEAD`,
          preparedOptions.worktreePath,
          secretValues,
        );

        const aheadCount = Number.parseInt(aheadCountRaw, 10);
        if (!Number.isFinite(aheadCount) || aheadCount <= 0) {
          return DEFAULT_PULL_REQUEST_RESULT(
            preparedOptions.baseBranch,
            preparedOptions.headBranch,
          );
        }

        const existingPullRequest = yield* findExistingPullRequest(
          preparedOptions.githubRepository,
          preparedOptions.baseBranch,
          preparedOptions.headBranch,
          preparedOptions.githubToken,
          secretValues,
        );

        if (existingPullRequest) {
          return {
            status: "opened_existing",
            url: existingPullRequest.url,
            number: existingPullRequest.number,
            baseBranch: existingPullRequest.baseBranch,
            headBranch: existingPullRequest.headBranch,
            title: existingPullRequest.title,
          } satisfies GitHubPullRequestResult;
        }

        const createdPullRequest = yield* createGitHubPullRequest(
          preparedOptions.githubRepository,
          {
            baseBranch: preparedOptions.baseBranch,
            headBranch: preparedOptions.headBranch,
            title: preparedOptions.title,
            body: preparedOptions.body,
            draft: preparedOptions.draft ?? false,
          },
          preparedOptions.githubToken,
          secretValues,
        );

        return {
          status: "created",
          url: createdPullRequest.url,
          number: createdPullRequest.number,
          baseBranch: createdPullRequest.baseBranch,
          headBranch: createdPullRequest.headBranch,
          title: createdPullRequest.title,
        } satisfies GitHubPullRequestResult;
      });
    },
  } satisfies PrServiceShape;
}

export function makePrServiceLayer(): Layer.Layer<PrService> {
  return Layer.succeed(PrService, makePrService());
}

export const PrServiceLive = makePrServiceLayer;
