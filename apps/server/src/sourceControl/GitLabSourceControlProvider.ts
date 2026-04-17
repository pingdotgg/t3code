import { Effect, Layer, Option } from "effect";
import { SourceControlProviderError, type ChangeRequest } from "@t3tools/contracts";

import * as GitLabCli from "./GitLabCli.ts";
import * as SourceControlProvider from "./SourceControlProvider.ts";
import * as SourceControlProviderDiscovery from "./SourceControlProviderDiscovery.ts";

function providerError(
  operation: string,
  cause: GitLabCli.GitLabCliError,
): SourceControlProviderError {
  return new SourceControlProviderError({
    provider: "gitlab",
    operation,
    detail: cause.detail,
    cause,
  });
}

function toChangeRequest(summary: GitLabCli.GitLabMergeRequestSummary): ChangeRequest {
  return {
    provider: "gitlab",
    number: summary.number,
    title: summary.title,
    url: summary.url,
    baseRefName: summary.baseRefName,
    headRefName: summary.headRefName,
    state: summary.state ?? "open",
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

function parseGitLabAuth(input: SourceControlProviderDiscovery.SourceControlAuthProbeInput) {
  const output = SourceControlProviderDiscovery.combinedAuthOutput(input);
  const account = SourceControlProviderDiscovery.matchFirst(output, [
    /Logged in to .* as\s+([^\s(]+)/iu,
    /Logged in to .* account\s+([^\s(]+)/iu,
    /account:\s*([^\s(]+)/iu,
  ]);
  const host = SourceControlProviderDiscovery.parseCliHost(output);

  if (input.exitCode !== 0) {
    return SourceControlProviderDiscovery.providerAuth({
      status: "unauthenticated",
      host,
      detail:
        SourceControlProviderDiscovery.firstSafeAuthLine(output) ??
        "Run `glab auth login` to authenticate GitLab CLI.",
    });
  }

  if (account) {
    return SourceControlProviderDiscovery.providerAuth({ status: "authenticated", account, host });
  }

  return SourceControlProviderDiscovery.providerAuth({
    status: "unknown",
    host,
    detail:
      SourceControlProviderDiscovery.firstSafeAuthLine(output) ??
      "GitLab CLI auth status could not be parsed.",
  });
}

export const discovery = {
  type: "cli",
  kind: "gitlab",
  label: "GitLab",
  executable: "glab",
  versionArgs: ["--version"],
  authArgs: ["auth", "status"],
  parseAuth: parseGitLabAuth,
  installHint:
    "Install the GitLab command-line tool (`glab`) from https://gitlab.com/gitlab-org/cli or your package manager (for example `brew install glab`).",
} satisfies SourceControlProviderDiscovery.SourceControlCliDiscoverySpec;

export const make = Effect.fn("makeGitLabSourceControlProvider")(function* () {
  const gitlab = yield* GitLabCli.GitLabCli;

  return SourceControlProvider.SourceControlProvider.of({
    kind: "gitlab",
    listChangeRequests: (input) => {
      const source = SourceControlProvider.sourceControlRefFromInput(input);
      return gitlab
        .listMergeRequests({
          cwd: input.cwd,
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
      gitlab.getMergeRequest(input).pipe(
        Effect.map(toChangeRequest),
        Effect.mapError((error) => providerError("getChangeRequest", error)),
      ),
    createChangeRequest: (input) => {
      const source = SourceControlProvider.sourceControlRefFromInput(input);
      return gitlab
        .createMergeRequest({
          cwd: input.cwd,
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
      gitlab
        .getRepositoryCloneUrls(input)
        .pipe(Effect.mapError((error) => providerError("getRepositoryCloneUrls", error))),
    createRepository: (input) =>
      gitlab
        .createRepository(input)
        .pipe(Effect.mapError((error) => providerError("createRepository", error))),
    getDefaultBranch: (input) =>
      gitlab
        .getDefaultBranch(input)
        .pipe(Effect.mapError((error) => providerError("getDefaultBranch", error))),
    checkoutChangeRequest: (input) =>
      gitlab
        .checkoutMergeRequest(input)
        .pipe(Effect.mapError((error) => providerError("checkoutChangeRequest", error))),
  });
});

export const layer = Layer.effect(SourceControlProvider.SourceControlProvider, make());
