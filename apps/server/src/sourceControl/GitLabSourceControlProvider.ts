import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { SourceControlProviderError, type ChangeRequest } from "@t3tools/contracts";

import * as GitLabCli from "./GitLabCli.ts";
import * as SourceControlProvider from "./SourceControlProvider.ts";
import {
  combinedAuthOutput,
  firstSafeAuthLine,
  matchFirst,
  parseCliHost,
  providerAuth,
  type SourceControlAuthProbeInput,
  type SourceControlCliDiscoverySpec,
  type SourceControlUnknownRemoteRefinementInput,
} from "./SourceControlProviderDiscovery.ts";
import { findAuthenticatedGitLabHost, parseGitLabAuthStatusHosts } from "./gitLabAuthStatus.ts";

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

function parseGitLabAuth(input: SourceControlAuthProbeInput) {
  const output = combinedAuthOutput(input);
  const authenticatedHost = findAuthenticatedGitLabHost(parseGitLabAuthStatusHosts(output));
  const account =
    authenticatedHost?.account ??
    matchFirst(output, [
      /Logged in to .* as\s+([^\s(]+)/iu,
      /Logged in to .* account\s+([^\s(]+)/iu,
      /account:\s*([^\s(]+)/iu,
    ]);
  const host = authenticatedHost?.host ?? parseCliHost(output);

  if (account) {
    return providerAuth({ status: "authenticated", account, host });
  }

  if (input.exitCode !== 0) {
    return providerAuth({
      status: "unauthenticated",
      host,
      detail: firstSafeAuthLine(output) ?? "Run `glab auth login` to authenticate GitLab CLI.",
    });
  }

  return providerAuth({
    status: "unknown",
    host,
    detail: firstSafeAuthLine(output) ?? "GitLab CLI auth status could not be parsed.",
  });
}

function refineUnknownGitLabRemote(input: SourceControlUnknownRemoteRefinementInput) {
  const host = input.context.provider.name.toLowerCase();
  const authenticated = parseGitLabAuthStatusHosts(combinedAuthOutput(input.auth)).some(
    (entry) => entry.account !== null && entry.host === host,
  );

  if (!authenticated) {
    return null;
  }

  return {
    kind: "gitlab",
    name: "GitLab Self-Hosted",
    baseUrl: input.context.provider.baseUrl,
  } as const;
}

export const discovery = {
  type: "cli",
  kind: "gitlab",
  label: "GitLab",
  executable: "glab",
  versionArgs: ["--version"],
  authArgs: ["auth", "status"],
  parseAuth: parseGitLabAuth,
  refineUnknownRemote: refineUnknownGitLabRemote,
  installHint:
    "Install the GitLab command-line tool (`glab`) from https://gitlab.com/gitlab-org/cli or your package manager (for example `brew install glab`).",
} satisfies SourceControlCliDiscoverySpec;

export const make = Effect.gen(function* () {
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
          Effect.mapError(
            (error) =>
              new SourceControlProviderError({
                provider: "gitlab",
                operation: "listChangeRequests",
                command: error.command,
                cwd: input.cwd,
                reference: SourceControlProvider.transportSafeSourceControlErrorValue(
                  input.headSelector,
                ),
                detail: error.detail,
                cause: error,
              }),
          ),
        );
    },
    getChangeRequest: (input) =>
      gitlab.getMergeRequest(input).pipe(
        Effect.map(toChangeRequest),
        Effect.mapError(
          (error) =>
            new SourceControlProviderError({
              provider: "gitlab",
              operation: "getChangeRequest",
              command: error.command,
              cwd: input.cwd,
              reference: SourceControlProvider.transportSafeSourceControlErrorValue(
                input.reference,
              ),
              detail: error.detail,
              cause: error,
            }),
        ),
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
        .pipe(
          Effect.mapError(
            (error) =>
              new SourceControlProviderError({
                provider: "gitlab",
                operation: "createChangeRequest",
                command: error.command,
                cwd: input.cwd,
                reference: SourceControlProvider.transportSafeSourceControlErrorValue(
                  input.headSelector,
                ),
                detail: error.detail,
                cause: error,
              }),
          ),
        );
    },
    getRepositoryCloneUrls: (input) =>
      gitlab.getRepositoryCloneUrls(input).pipe(
        Effect.mapError(
          (error) =>
            new SourceControlProviderError({
              provider: "gitlab",
              operation: "getRepositoryCloneUrls",
              command: error.command,
              cwd: input.cwd,
              repository: SourceControlProvider.transportSafeSourceControlErrorValue(
                input.repository,
              ),
              detail: error.detail,
              cause: error,
            }),
        ),
      ),
    createRepository: (input) =>
      gitlab.createRepository(input).pipe(
        Effect.mapError(
          (error) =>
            new SourceControlProviderError({
              provider: "gitlab",
              operation: "createRepository",
              command: error.command,
              cwd: input.cwd,
              repository: SourceControlProvider.transportSafeSourceControlErrorValue(
                input.repository,
              ),
              detail: error.detail,
              cause: error,
            }),
        ),
      ),
    getDefaultBranch: (input) =>
      gitlab.getDefaultBranch(input).pipe(
        Effect.mapError(
          (error) =>
            new SourceControlProviderError({
              provider: "gitlab",
              operation: "getDefaultBranch",
              command: error.command,
              cwd: input.cwd,
              detail: error.detail,
              cause: error,
            }),
        ),
      ),
    checkoutChangeRequest: (input) =>
      gitlab.checkoutMergeRequest(input).pipe(
        Effect.mapError(
          (error) =>
            new SourceControlProviderError({
              provider: "gitlab",
              operation: "checkoutChangeRequest",
              command: error.command,
              cwd: input.cwd,
              reference: SourceControlProvider.transportSafeSourceControlErrorValue(
                input.reference,
              ),
              detail: error.detail,
              cause: error,
            }),
        ),
      ),
  });
});

export const layer = Layer.effect(SourceControlProvider.SourceControlProvider, make);
