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

function isBareRepositoryName(repository: string): boolean {
  return !repository.includes("/");
}

const AMBIGUOUS_REPOSITORY_CANDIDATE_LIMIT = 5;

type RepositorySearchMatch =
  | { readonly _tag: "match"; readonly fullName: string }
  | { readonly _tag: "ambiguous"; readonly candidates: ReadonlyArray<string> }
  | { readonly _tag: "none" };

// Bare names resolve against the caller's personal namespace on `gh repo
// view`, which is usually empty on an enterprise host, so they go through
// search instead. An exact repo-name match wins outright; a sole near match
// still resolves, since that is the whole point of accepting a bare name.
// Anything else is a choice between repositories that search ranking is no
// basis for making, so report the candidates rather than guess.
function pickRepositorySearchMatch(
  query: string,
  results: ReadonlyArray<GitHubCli.GitHubRepositorySearchResult>,
): RepositorySearchMatch {
  if (results.length === 0) {
    return { _tag: "none" };
  }

  const normalizedQuery = query.toLowerCase();
  const exact = results.filter(
    (result) => result.fullName.split("/").pop()?.toLowerCase() === normalizedQuery,
  );
  if (exact.length === 1) {
    return { _tag: "match", fullName: exact[0]!.fullName };
  }
  const candidates = exact.length > 1 ? exact : results;
  if (candidates.length > 1) {
    return { _tag: "ambiguous", candidates: candidates.map((result) => result.fullName) };
  }
  return { _tag: "match", fullName: candidates[0]!.fullName };
}

/**
 * What a bare name that resolved to nothing, or to more than one repository, tells the reader.
 * It lives beside the taxonomy that produced it: the failure carries the same structural fields
 * either way, and only the sentence differs between the two outcomes.
 */
function repositorySearchFailureDetail(
  match: Extract<RepositorySearchMatch, { readonly _tag: "ambiguous" | "none" }>,
  context: { readonly repository: string; readonly host?: string },
): string {
  const repository = SourceControlProvider.transportSafeSourceControlErrorValue(context.repository);
  const host = context.host
    ? SourceControlProvider.transportSafeSourceControlErrorValue(context.host)
    : "the configured host";
  if (match._tag === "none") {
    return `No repository named "${repository}" was found on ${host}.`;
  }
  const candidates = match.candidates
    .slice(0, AMBIGUOUS_REPOSITORY_CANDIDATE_LIMIT)
    .map((candidate) => SourceControlProvider.transportSafeSourceControlErrorValue(candidate))
    .join(", ");
  return `More than one repository on ${host} matches "${repository}": ${candidates}. Enter the full owner/repo path.`;
}

export const makeProvider = (kind: GitHubProviderKind) =>
  Effect.gen(function* () {
    const github = yield* GitHubCli.GitHubCli;

    // A `gh` call with no host and no repo context falls back to github.com, so
    // it does not fail — it quietly answers for public GitHub. Only operations
    // that cannot borrow the host from the surrounding remote need this: an
    // in-repo `gh repo view owner/repo` resolves its own host and must keep
    // working without one.
    const ensureEnterpriseHost = (input: {
      readonly cwd: string;
      readonly repository: string;
      readonly host?: string;
      readonly operation: string;
    }): Effect.Effect<void, SourceControlProviderError> =>
      kind === "github-enterprise" && !input.host
        ? Effect.fail(
            new SourceControlProviderError({
              provider: kind,
              operation: input.operation,
              command: "gh",
              cwd: input.cwd,
              repository: SourceControlProvider.transportSafeSourceControlErrorValue(
                input.repository,
              ),
              detail: "Choose a GitHub Enterprise host before continuing.",
            }),
          )
        : Effect.void;

    const resolveRepositoryReference = (input: {
      readonly cwd: string;
      readonly repository: string;
      readonly host?: string;
    }): Effect.Effect<string, SourceControlProviderError> => {
      const repository = input.repository.trim();
      if (kind !== "github-enterprise" || !isBareRepositoryName(repository)) {
        return Effect.succeed(repository);
      }

      // `gh search repos` ignores repo context entirely, so unlike a lookup by
      // owner/repo this cannot borrow the host from the surrounding remote.
      return ensureEnterpriseHost({
        cwd: input.cwd,
        repository,
        ...(input.host ? { host: input.host } : {}),
        operation: "getRepositoryCloneUrls",
      }).pipe(
        Effect.andThen(() =>
          github
            .searchRepositories({
              cwd: input.cwd,
              query: repository,
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
                    repository:
                      SourceControlProvider.transportSafeSourceControlErrorValue(repository),
                    detail: error.detail,
                    cause: error,
                  }),
              ),
              Effect.flatMap((results) => {
                const match = pickRepositorySearchMatch(repository, results);
                if (match._tag === "match") {
                  return Effect.succeed(match.fullName);
                }

                return Effect.fail(
                  new SourceControlProviderError({
                    provider: kind,
                    operation: "getRepositoryCloneUrls",
                    command: "gh",
                    cwd: input.cwd,
                    repository:
                      SourceControlProvider.transportSafeSourceControlErrorValue(repository),
                    detail: repositorySearchFailureDetail(match, {
                      repository,
                      ...(input.host ? { host: input.host } : {}),
                    }),
                  }),
                );
              }),
            ),
        ),
      );
    };

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
        resolveRepositoryReference(input).pipe(
          Effect.flatMap((repository) =>
            github
              .getRepositoryCloneUrls({
                cwd: input.cwd,
                repository,
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
          ),
        ),
      createRepository: (input) =>
        ensureEnterpriseHost({ ...input, operation: "createRepository" }).pipe(
          Effect.andThen(() =>
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
