import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import {
  SourceControlProviderError,
  type ChangeRequest,
  type ChangeRequestState,
} from "@t3tools/contracts";

import * as GitHubCli from "./GitHubCli.ts";
import { findAuthenticatedGitHubAccount, parseGitHubAuthStatus } from "./gitHubAuthStatus.ts";
import { decodeGitHubPullRequestListJson } from "./gitHubPullRequests.ts";
import * as SourceControlProvider from "./SourceControlProvider.ts";
import {
  combinedAuthOutput,
  firstSafeAuthLine,
  providerAuth,
  type SourceControlAuthProbeInput,
  type SourceControlCliDiscoverySpec,
  type SourceControlDiscoveryInstance,
  type SourceControlUnknownRemoteRefinementInput,
} from "./SourceControlProviderDiscovery.ts";

type GitHubProviderKind = "github" | "github-enterprise";

function toChangeRequest(
  kind: GitHubProviderKind,
  summary: GitHubCli.GitHubPullRequestSummary,
): ChangeRequest {
  return {
    provider: kind,
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

function parseGitHubAuth(input: SourceControlAuthProbeInput) {
  const output = combinedAuthOutput(input);
  const authStatus = parseGitHubAuthStatus(input.stdout);
  const authenticatedAccount = findAuthenticatedGitHubAccount(authStatus.accounts);
  const host = authenticatedAccount?.host;

  if (authenticatedAccount) {
    return providerAuth({
      status: "authenticated",
      account: authenticatedAccount.account,
      host,
    });
  }

  const failedAccount = authStatus.accounts.find((entry) => entry.active) ?? authStatus.accounts[0];
  if (authStatus.parsed) {
    return providerAuth({
      status: "unauthenticated",
      host: failedAccount?.host,
      detail:
        failedAccount?.error ??
        "Run `gh auth login` to authenticate GitHub CLI with an active account.",
    });
  }

  if (input.exitCode !== 0) {
    return providerAuth({
      status: "unauthenticated",
      host,
      detail: firstSafeAuthLine(output) ?? "Run `gh auth login` to authenticate GitHub CLI.",
    });
  }

  return providerAuth({
    status: "unknown",
    host,
    detail: firstSafeAuthLine(output) ?? "GitHub CLI auth status could not be parsed.",
  });
}

function githubComAuth(status: ReturnType<typeof parseGitHubAuthStatus>) {
  const accounts = status.accounts.filter((account) => account.host === "github.com");
  const authenticated = findAuthenticatedGitHubAccount(accounts);
  if (authenticated) {
    return providerAuth({
      status: "authenticated",
      account: authenticated.account,
      host: "github.com",
    });
  }
  return providerAuth({
    status: "unauthenticated",
    host: "github.com",
    detail:
      accounts[0]?.error ??
      "Run `gh auth login` to authenticate GitHub CLI with an active account.",
  });
}

export function expandGitHubInstances(
  input: SourceControlAuthProbeInput,
): ReadonlyArray<SourceControlDiscoveryInstance> {
  const status = parseGitHubAuthStatus(input.stdout);
  if (!status.parsed) {
    return [
      {
        kind: "github",
        id: "github",
        host: "github.com",
        label: "GitHub",
        auth: parseGitHubAuth(input),
      },
    ];
  }

  const enterpriseHosts = [
    ...new Set(
      status.accounts.map((account) => account.host).filter((host) => host !== "github.com"),
    ),
  ].sort();

  return [
    {
      kind: "github",
      id: "github",
      host: "github.com",
      label: "GitHub",
      auth: githubComAuth(status),
    },
    ...enterpriseHosts.map((host) => {
      const accounts = status.accounts.filter((account) => account.host === host);
      const authenticated = findAuthenticatedGitHubAccount(accounts);
      return {
        kind: "github-enterprise" as const,
        id: `github-enterprise:${host}`,
        host,
        label: host,
        auth: authenticated
          ? providerAuth({ status: "authenticated", account: authenticated.account, host })
          : providerAuth({
              status: "unauthenticated",
              host,
              detail:
                accounts[0]?.error ?? `Run \`gh auth login --hostname ${host}\` to authenticate.`,
            }),
      };
    }),
  ];
}

// An `unknown` remote's provider name is the raw host, port included, so both
// sides have to drop the port before they can be compared.
function toHostName(host: string): string {
  try {
    return new URL(`https://${host}`).hostname.toLowerCase();
  } catch {
    return host.replace(/:\d+$/u, "").toLowerCase();
  }
}

export function refineUnknownGitHubRemote(input: SourceControlUnknownRemoteRefinementInput) {
  const host = toHostName(input.context.provider.name);
  const authenticated = parseGitHubAuthStatus(input.auth.stdout).accounts.some(
    (account) => toHostName(account.host) === host && account.authenticated,
  );

  if (!authenticated) {
    return null;
  }

  return {
    kind: "github-enterprise",
    name: host,
    baseUrl: input.context.provider.baseUrl,
  } as const;
}

export const discovery = {
  type: "cli",
  kind: "github",
  label: "GitHub",
  executable: "gh",
  versionArgs: ["--version"],
  authArgs: ["auth", "status", "--json", "hosts"],
  parseAuth: parseGitHubAuth,
  expandInstances: expandGitHubInstances,
  refineUnknownRemote: refineUnknownGitHubRemote,
  installHint:
    "Install the GitHub command-line tool (`gh`) via https://cli.github.com/ or your package manager (for example `brew install gh`).",
} satisfies SourceControlCliDiscoverySpec;

export const makeProvider = (kind: GitHubProviderKind) =>
  Effect.gen(function* () {
    const github = yield* GitHubCli.GitHubCli;

    const listChangeRequests: SourceControlProvider.SourceControlProvider["Service"]["listChangeRequests"] =
      (input) => {
        if (input.state === "open") {
          return github
            .listOpenPullRequests({
              cwd: input.cwd,
              headSelector: input.headSelector,
              ...(input.limit !== undefined ? { limit: input.limit } : {}),
            })
            .pipe(
              Effect.map((items) => items.map((summary) => toChangeRequest(kind, summary))),
              Effect.mapError(
                (error) =>
                  new SourceControlProviderError({
                    provider: kind,
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
                          ...toChangeRequest(kind, item),
                          updatedAt: item.updatedAt,
                        })),
                      )
                    : Effect.fail(
                        new GitHubCli.GitHubChangeRequestListDecodeError({
                          command: "gh",
                          cwd: input.cwd,
                          cause: decoded.failure,
                        }),
                      ),
                ),
              );
            }),
            Effect.mapError(
              (error) =>
                new SourceControlProviderError({
                  provider: kind,
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
      };

    return SourceControlProvider.SourceControlProvider.of({
      kind,
      listChangeRequests,
      getChangeRequest: (input) =>
        github.getPullRequest(input).pipe(
          Effect.map((summary) => toChangeRequest(kind, summary)),
          Effect.mapError(
            (error) =>
              new SourceControlProviderError({
                provider: kind,
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
      createChangeRequest: (input) =>
        github
          .createPullRequest({
            cwd: input.cwd,
            baseBranch: input.baseRefName,
            headSelector: input.headSelector,
            title: input.title,
            bodyFile: input.bodyFile,
          })
          .pipe(
            Effect.mapError(
              (error) =>
                new SourceControlProviderError({
                  provider: kind,
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
          ),
      getRepositoryCloneUrls: (input) =>
        github
          .getRepositoryCloneUrls({
            cwd: input.cwd,
            repository: input.repository,
            ...(input.host ? { host: input.host } : {}),
          })
          .pipe(
            Effect.mapError(
              (error) =>
                new SourceControlProviderError({
                  provider: kind,
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
        github
          .createRepository({
            cwd: input.cwd,
            repository: input.repository,
            visibility: input.visibility,
            ...(input.host ? { host: input.host } : {}),
          })
          .pipe(
            Effect.mapError(
              (error) =>
                new SourceControlProviderError({
                  provider: kind,
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
        github.getDefaultBranch(input).pipe(
          Effect.mapError(
            (error) =>
              new SourceControlProviderError({
                provider: kind,
                operation: "getDefaultBranch",
                command: error.command,
                cwd: input.cwd,
                detail: error.detail,
                cause: error,
              }),
          ),
        ),
      checkoutChangeRequest: (input) =>
        github.checkoutPullRequest(input).pipe(
          Effect.mapError(
            (error) =>
              new SourceControlProviderError({
                provider: kind,
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

export const make = makeProvider("github");

export const layer = Layer.effect(SourceControlProvider.SourceControlProvider, make);
