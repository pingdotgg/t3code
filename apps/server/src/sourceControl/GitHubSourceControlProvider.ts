import { Effect, Layer, Option, Result, Schema } from "effect";
import {
  SourceControlProviderError,
  type ChangeRequest,
  type ChangeRequestState,
  type GitHubCliError,
} from "@t3tools/contracts";

import { GitHubCli, type GitHubPullRequestSummary } from "./GitHubCli.ts";
import { decodeGitHubPullRequestListJson } from "../git/githubPullRequests.ts";
import { SourceControlProvider, type SourceControlProviderShape } from "./SourceControlProvider.ts";

function providerError(operation: string, cause: GitHubCliError): SourceControlProviderError {
  return new SourceControlProviderError({
    provider: "github",
    operation,
    detail: cause.detail,
    cause,
  });
}

function toChangeRequest(summary: GitHubPullRequestSummary): ChangeRequest {
  return {
    provider: "github",
    number: summary.number,
    title: summary.title,
    url: summary.url,
    baseRefName: summary.baseRefName,
    headRefName: summary.headRefName,
    state: summary.state ?? "open",
    updatedAt: Option.none(),
    ...(summary.isCrossRepository !== undefined
      ? { isCrossRepository: summary.isCrossRepository }
      : {}),
    ...(summary.headRepositoryNameWithOwner !== undefined
      ? { headRepositoryNameWithOwner: summary.headRepositoryNameWithOwner }
      : {}),
    ...(summary.headRepositoryOwnerLogin !== undefined
      ? { headRepositoryOwnerLogin: summary.headRepositoryOwnerLogin }
      : {}),
  };
}

export const make = Effect.fn("makeGitHubSourceControlProvider")(function* () {
  const github = yield* GitHubCli;

  const listChangeRequests: SourceControlProviderShape["listChangeRequests"] = (input) => {
    if (input.state === "open") {
      return github
        .listOpenPullRequests({
          cwd: input.cwd,
          headSelector: input.headSelector,
          ...(input.limit !== undefined ? { limit: input.limit } : {}),
        })
        .pipe(
          Effect.map((items) => items.map(toChangeRequest)),
          Effect.mapError((error) => providerError("listChangeRequests", error)),
        );
    }

    const stateArg: ChangeRequestState | "all" = input.state;
    return github
      .execute({
        cwd: input.cwd,
        args: [
          "pr",
          "list",
          "--head",
          input.headSelector,
          "--state",
          stateArg,
          "--limit",
          String(input.limit ?? 20),
          "--json",
          "number,title,url,baseRefName,headRefName,state,mergedAt,updatedAt,isCrossRepository,headRepository,headRepositoryOwner",
        ],
      })
      .pipe(
        Effect.flatMap((result) => {
          const raw = result.stdout.trim();
          if (raw.length === 0) {
            return Effect.succeed([]);
          }
          return Effect.sync(() => decodeGitHubPullRequestListJson(raw)).pipe(
            Effect.flatMap((decoded) =>
              Result.isSuccess(decoded)
                ? Effect.succeed(
                    decoded.success.map((item) => ({
                      ...toChangeRequest(item),
                      updatedAt: item.updatedAt,
                    })),
                  )
                : Effect.fail(
                    new SourceControlProviderError({
                      provider: "github",
                      operation: "listChangeRequests",
                      detail: "GitHub CLI returned invalid change request JSON.",
                      cause: decoded.failure,
                    }),
                  ),
            ),
          );
        }),
        Effect.mapError((error) =>
          Schema.is(SourceControlProviderError)(error)
            ? error
            : providerError("listChangeRequests", error),
        ),
      );
  };

  return SourceControlProvider.of({
    kind: "github",
    listChangeRequests,
    getChangeRequest: (input) =>
      github.getPullRequest(input).pipe(
        Effect.map(toChangeRequest),
        Effect.mapError((error) => providerError("getChangeRequest", error)),
      ),
    createChangeRequest: (input) =>
      github
        .createPullRequest({
          cwd: input.cwd,
          baseBranch: input.baseRefName,
          headSelector: input.headSelector,
          title: input.title,
          bodyFile: input.bodyFile,
        })
        .pipe(Effect.mapError((error) => providerError("createChangeRequest", error))),
    getRepositoryCloneUrls: (input) =>
      github
        .getRepositoryCloneUrls(input)
        .pipe(Effect.mapError((error) => providerError("getRepositoryCloneUrls", error))),
    getDefaultBranch: (input) =>
      github
        .getDefaultBranch(input)
        .pipe(Effect.mapError((error) => providerError("getDefaultBranch", error))),
    checkoutChangeRequest: (input) =>
      github
        .checkoutPullRequest(input)
        .pipe(Effect.mapError((error) => providerError("checkoutChangeRequest", error))),
  });
});

export const layer = Layer.effect(SourceControlProvider, make());
