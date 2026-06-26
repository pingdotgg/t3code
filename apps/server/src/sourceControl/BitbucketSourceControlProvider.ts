import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { SourceControlProviderError, type ChangeRequest } from "@t3tools/contracts";

import * as BitbucketApi from "./BitbucketApi.ts";
import * as BitbucketPullRequests from "./bitbucketPullRequests.ts";
import * as SourceControlProvider from "./SourceControlProvider.ts";
import type * as SourceControlProviderDiscovery from "./SourceControlProviderDiscovery.ts";

function providerError(
  operation: string,
  cause: BitbucketApi.BitbucketApiError,
  context: {
    readonly cwd?: string;
    readonly reference?: string;
    readonly repository?: string;
  } = {},
): SourceControlProviderError {
  const detail =
    operation === "getRepositoryCloneUrls"
      ? "Failed to get repository clone URLs."
      : "detail" in cause && typeof cause.detail === "string" && cause.detail.length > 0
      ? cause.detail
      : cause.message;
  return new SourceControlProviderError({
    provider: "bitbucket",
    operation,
    detail,
    cwd: SourceControlProvider.transportSafeSourceControlErrorValue(context.cwd ?? cause.cwd),
    reference: SourceControlProvider.transportSafeSourceControlErrorValue(
      context.reference ?? ("reference" in cause ? cause.reference : undefined),
    ),
    repository: SourceControlProvider.transportSafeSourceControlErrorValue(
      context.repository ?? ("repository" in cause ? cause.repository : undefined),
    ),
    cause,
  });
}

function toChangeRequest(
  summary: BitbucketPullRequests.NormalizedBitbucketPullRequestRecord,
): ChangeRequest {
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
  const bitbucket = yield* BitbucketApi.BitbucketApi;

  return SourceControlProvider.SourceControlProvider.of({
    kind: "bitbucket",
    listChangeRequests: (input) => {
      const source = SourceControlProvider.sourceControlRefFromInput(input);
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
          Effect.mapError((error) =>
            providerError("listChangeRequests", error, {
              cwd: input.cwd,
              reference: input.headSelector,
            }),
          ),
        );
    },
    getChangeRequest: (input) =>
      bitbucket.getPullRequest(input).pipe(
        Effect.map(toChangeRequest),
        Effect.mapError((error) =>
          providerError("getChangeRequest", error, { cwd: input.cwd, reference: input.reference }),
        ),
      ),
    createChangeRequest: (input) => {
      const source = SourceControlProvider.sourceControlRefFromInput(input);
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
        .pipe(
          Effect.mapError((error) =>
            providerError("createChangeRequest", error, {
              cwd: input.cwd,
              reference: input.headSelector,
            }),
          ),
        );
    },
    getRepositoryCloneUrls: (input) =>
      bitbucket
        .getRepositoryCloneUrls(input)
        .pipe(
          Effect.mapError((error) =>
            providerError("getRepositoryCloneUrls", error, {
              cwd: input.cwd,
              repository: input.repository,
            }),
          ),
        ),
    createRepository: (input) =>
      bitbucket
        .createRepository(input)
        .pipe(
          Effect.mapError((error) =>
            providerError("createRepository", error, {
              cwd: input.cwd,
              repository: input.repository,
            }),
          ),
        ),
    getDefaultBranch: (input) =>
      bitbucket
        .getDefaultBranch({
          cwd: input.cwd,
          ...(input.context ? { context: input.context } : {}),
        })
        .pipe(Effect.mapError((error) => providerError("getDefaultBranch", error, input))),
    checkoutChangeRequest: (input) =>
      bitbucket
        .checkoutPullRequest({
          cwd: input.cwd,
          ...(input.context ? { context: input.context } : {}),
          reference: input.reference,
          ...(input.force !== undefined ? { force: input.force } : {}),
        })
        .pipe(
          Effect.mapError((error) =>
            providerError("checkoutChangeRequest", error, {
              cwd: input.cwd,
              reference: input.reference,
            }),
          ),
        ),
  });
});

export const layer = Layer.effect(SourceControlProvider.SourceControlProvider, make());

export const makeDiscovery = Effect.fn("makeBitbucketSourceControlProviderDiscovery")(function* () {
  const bitbucket = yield* BitbucketApi.BitbucketApi;

  return {
    type: "api",
    kind: "bitbucket",
    label: "Bitbucket",
    installHint:
      "Set MORECODE_T3CODE_BITBUCKET_EMAIL and MORECODE_T3CODE_BITBUCKET_API_TOKEN on the server (use a Bitbucket API token with pull request and repository scopes).",
    probeAuth: bitbucket.probeAuth,
  } satisfies SourceControlProviderDiscovery.SourceControlApiDiscoverySpec;
});
