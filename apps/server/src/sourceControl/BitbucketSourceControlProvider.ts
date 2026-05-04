import { Effect, Layer, Option } from "effect";
import { SourceControlProviderError, type ChangeRequest } from "@t3tools/contracts";

import { BitbucketApi, type BitbucketApiError } from "./BitbucketApi.ts";
import { SourceControlProvider, sourceControlRefFromInput } from "./SourceControlProvider.ts";
import type { SourceControlApiDiscoverySpec } from "./SourceControlProviderDiscovery.ts";
import type { NormalizedBitbucketPullRequestRecord } from "./bitbucketPullRequests.ts";

function providerError(operation: string, cause: BitbucketApiError): SourceControlProviderError {
  return new SourceControlProviderError({
    provider: "bitbucket",
    operation,
    detail: cause.detail,
    cause,
  });
}

function toChangeRequest(summary: NormalizedBitbucketPullRequestRecord): ChangeRequest {
  return {
    provider: "bitbucket",
    number: summary.number,
    title: summary.title,
    url: summary.url,
    baseRefName: summary.baseRefName,
    headRefName: summary.headRefName,
    state: summary.state,
    updatedAt: summary.updatedAt ?? Option.none(),
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

export const make = Effect.fn("makeBitbucketSourceControlProvider")(function* () {
  const bitbucket = yield* BitbucketApi;

  return SourceControlProvider.of({
    kind: "bitbucket",
    listChangeRequests: (input) => {
      const source = sourceControlRefFromInput(input);
      return bitbucket
        .listPullRequests({
          cwd: input.cwd,
          ...(input.context ? { context: input.context } : {}),
          headSelector: input.headSelector,
          ...(source ? { source } : {}),
          state: input.state,
          ...(input.limit !== undefined ? { limit: input.limit } : {}),
        })
        .pipe(
          Effect.map((items) => items.map(toChangeRequest)),
          Effect.mapError((error) => providerError("listChangeRequests", error)),
        );
    },
    getChangeRequest: (input) =>
      bitbucket.getPullRequest(input).pipe(
        Effect.map(toChangeRequest),
        Effect.mapError((error) => providerError("getChangeRequest", error)),
      ),
    createChangeRequest: (input) => {
      const source = sourceControlRefFromInput(input);
      return bitbucket
        .createPullRequest({
          cwd: input.cwd,
          ...(input.context ? { context: input.context } : {}),
          baseBranch: input.baseRefName,
          headSelector: input.headSelector,
          ...(source ? { source } : {}),
          ...(input.target ? { target: input.target } : {}),
          title: input.title,
          bodyFile: input.bodyFile,
        })
        .pipe(Effect.mapError((error) => providerError("createChangeRequest", error)));
    },
    getRepositoryCloneUrls: (input) =>
      bitbucket
        .getRepositoryCloneUrls(input)
        .pipe(Effect.mapError((error) => providerError("getRepositoryCloneUrls", error))),
    createRepository: (input) =>
      bitbucket
        .createRepository(input)
        .pipe(Effect.mapError((error) => providerError("createRepository", error))),
    getDefaultBranch: (input) =>
      bitbucket
        .getDefaultBranch({
          cwd: input.cwd,
          ...(input.context ? { context: input.context } : {}),
        })
        .pipe(Effect.mapError((error) => providerError("getDefaultBranch", error))),
    checkoutChangeRequest: (input) =>
      bitbucket
        .checkoutPullRequest({
          cwd: input.cwd,
          ...(input.context ? { context: input.context } : {}),
          reference: input.reference,
          ...(input.force !== undefined ? { force: input.force } : {}),
        })
        .pipe(Effect.mapError((error) => providerError("checkoutChangeRequest", error))),
  });
});

export const layer = Layer.effect(SourceControlProvider, make());

export const makeDiscovery = Effect.fn("makeBitbucketSourceControlProviderDiscovery")(function* () {
  const bitbucket = yield* BitbucketApi;

  return {
    type: "api",
    kind: "bitbucket",
    label: "Bitbucket",
    executable: "Bitbucket REST API",
    implemented: true,
    installHint:
      "Create a Bitbucket API token with pull request/repository scopes, then set T3CODE_BITBUCKET_EMAIL and T3CODE_BITBUCKET_API_TOKEN.",
    probeAuth: bitbucket.probeAuth,
  } satisfies SourceControlApiDiscoverySpec;
});
