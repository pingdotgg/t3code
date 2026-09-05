import * as DateTime from "effect/DateTime";
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
} from "./SourceControlProviderDiscovery.ts";

function toChangeRequest(summary: GitHubCli.GitHubPullRequestSummary): ChangeRequest {
  return {
    provider: "github",
    number: summary.number,
    title: summary.title,
    url: summary.url,
    baseRefName: summary.baseRefName,
    headRefName: summary.headRefName,
    state: summary.state ?? "open",
    ...(summary.isDraft === true ? { isDraft: true } : {}),
    updatedAt:
      summary.updatedAt === undefined
        ? Option.none()
        : Option.some(DateTime.makeUnsafe(summary.updatedAt)),
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

  // gh gained `auth status --json` in 2.81.0. Older versions reject the flag and exit
  // non-zero, which reads exactly like a signed-out CLI. Name the real problem instead.
  if (input.exitCode !== 0 && output.includes("unknown flag: --json")) {
    return providerAuth({
      status: "unknown",
      detail:
        "GitHub CLI is too old to report sign-in status. Update `gh` to 2.81.0 or newer (for example `brew upgrade gh`) and rescan.",
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

export const discovery = {
  type: "cli",
  kind: "github",
  label: "GitHub",
  executable: "gh",
  versionArgs: ["--version"],
  authArgs: ["auth", "status", "--json", "hosts"],
  parseAuth: parseGitHubAuth,
  installHint:
    "Install the GitHub command-line tool (`gh`) via https://cli.github.com/ or your package manager (for example `brew install gh`).",
} satisfies SourceControlCliDiscoverySpec;

export const make = Effect.gen(function* () {
  const github = yield* GitHubCli.GitHubCli;
  const repositoryFromContext = (
    context: SourceControlProvider.SourceControlProviderContext | undefined,
  ) => {
    if (context?.remoteName !== "upstream") return undefined;
    const scpStyle = /^git@([^:/\s]+):([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i.exec(context.remoteUrl);
    if (scpStyle?.[1] && scpStyle[2] && scpStyle[3]) {
      return scpStyle[1].toLowerCase() === "github.com"
        ? `${scpStyle[2]}/${scpStyle[3]}`
        : `${scpStyle[1]}/${scpStyle[2]}/${scpStyle[3]}`;
    }
    try {
      const parsed = new URL(context.remoteUrl);
      const [owner, name, ...rest] = parsed.pathname
        .replace(/\/+$/, "")
        .replace(/\.git$/i, "")
        .split("/")
        .filter((part) => part.length > 0);
      if (!owner || !name || rest.length > 0) return undefined;
      const repositoryHost = parsed.protocol === "ssh:" ? parsed.hostname : parsed.host;
      return parsed.hostname.toLowerCase() === "github.com"
        ? `${owner}/${name}`
        : `${repositoryHost}/${owner}/${name}`;
    } catch {
      return undefined;
    }
  };
  const withRepositoryFromContext = <Input extends object>(
    input: Input,
    context: SourceControlProvider.SourceControlProviderContext | undefined,
  ): Input | (Input & { readonly repository: string }) => {
    const repository = repositoryFromContext(context);
    return repository ? { ...input, repository } : input;
  };

  const listChangeRequests: SourceControlProvider.SourceControlProvider["Service"]["listChangeRequests"] =
    (input) => {
      const repository = repositoryFromContext(input.context);
      if (input.state === "open") {
        return github
          .listOpenPullRequests({
            cwd: input.cwd,
            headSelector: input.headSelector,
            ...(input.limit !== undefined ? { limit: input.limit } : {}),
            ...(repository ? { repository } : {}),
          })
          .pipe(
            Effect.map((items) => items.map(toChangeRequest)),
            Effect.mapError(
              (error) =>
                new SourceControlProviderError({
                  provider: "github",
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
      const qualifiedHead = /^([^:/\s]+):(.+)$/u.exec(input.headSelector);
      const requestedLimit = input.limit ?? 20;
      return github
        .execute({
          cwd: input.cwd,
          args: [
            "pr",
            "list",
            "--head",
            qualifiedHead?.[2] ?? input.headSelector,
            "--state",
            stateArg,
            "--limit",
            String(qualifiedHead ? Math.max(requestedLimit, 100) : requestedLimit),
            ...(repository ? ["--repo", repository] : []),
            "--json",
            "number,title,url,baseRefName,headRefName,state,isDraft,mergedAt,updatedAt,isCrossRepository,headRepository,headRepositoryOwner",
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
                      decoded.success
                        .filter(
                          (item) =>
                            !qualifiedHead ||
                            (item.headRefName === qualifiedHead[2] &&
                              item.headRepositoryOwnerLogin?.toLowerCase() ===
                                qualifiedHead[1]?.toLowerCase()),
                        )
                        .slice(0, requestedLimit)
                        .map((item) => {
                          const { updatedAt, ...summary } = item;
                          return {
                            ...toChangeRequest({
                              ...summary,
                              ...(Option.isSome(updatedAt)
                                ? { updatedAt: DateTime.formatIso(updatedAt.value) }
                                : {}),
                            }),
                            updatedAt,
                          };
                        }),
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
                provider: "github",
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
    kind: "github",
    listChangeRequests,
    getChangeRequest: (input) =>
      github
        .getPullRequest(
          withRepositoryFromContext(
            {
              cwd: input.cwd,
              reference: input.reference,
            },
            input.context,
          ),
        )
        .pipe(
          Effect.map(toChangeRequest),
          Effect.mapError(
            (error) =>
              new SourceControlProviderError({
                provider: "github",
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
        .createPullRequest(
          withRepositoryFromContext(
            {
              cwd: input.cwd,
              baseBranch: input.baseRefName,
              headSelector: input.headSelector,
              title: input.title,
              bodyFile: input.bodyFile,
              ...(input.source?.repository ? { headRepository: input.source.repository } : {}),
            },
            input.context,
          ),
        )
        .pipe(
          Effect.mapError(
            (error) =>
              new SourceControlProviderError({
                provider: "github",
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
      github.getRepositoryCloneUrls(input).pipe(
        Effect.mapError(
          (error) =>
            new SourceControlProviderError({
              provider: "github",
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
      github.createRepository(input).pipe(
        Effect.mapError(
          (error) =>
            new SourceControlProviderError({
              provider: "github",
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
      github.getDefaultBranch(withRepositoryFromContext({ cwd: input.cwd }, input.context)).pipe(
        Effect.mapError(
          (error) =>
            new SourceControlProviderError({
              provider: "github",
              operation: "getDefaultBranch",
              command: error.command,
              cwd: input.cwd,
              detail: error.detail,
              cause: error,
            }),
        ),
      ),
    checkoutChangeRequest: (input) =>
      github
        .checkoutPullRequest(
          withRepositoryFromContext(
            {
              cwd: input.cwd,
              reference: input.reference,
              ...(input.force !== undefined ? { force: input.force } : {}),
            },
            input.context,
          ),
        )
        .pipe(
          Effect.mapError(
            (error) =>
              new SourceControlProviderError({
                provider: "github",
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
