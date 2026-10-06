import * as Schema from "effect/Schema";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import {
  SourceControlProviderError,
  type ChangeRequest,
  type SourceControlProviderDiscoveryItem,
} from "@t3tools/contracts";

import { HostProcessEnvironment } from "@t3tools/shared/hostProcess";

import * as GitHubApi from "./GitHubApi.ts";
import * as GitHubCli from "./GitHubCli.ts";
import { findAuthenticatedGitHubAccount, parseGitHubAuthStatus } from "./gitHubAuthStatus.ts";
import * as SourceControlProvider from "./SourceControlProvider.ts";
import {
  combinedAuthOutput,
  firstSafeAuthLine,
  probeSourceControlProvider,
  providerAuth,
  type SourceControlAuthProbeInput,
  type SourceControlCliDiscoverySpec,
  type SourceControlManagedCliDiscoverySpec,
} from "./SourceControlProviderDiscovery.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";

const decodeLinkSubject = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Struct({ title: Schema.String, body: Schema.optional(Schema.NullOr(Schema.String)) }),
  ),
);

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
    closedAt: summary.closedAt ?? null,
    mergedAt: summary.mergedAt ?? null,
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

const decodeViewer = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ login: Schema.String })),
);

/** The environment variable gh would take a github.com token from, if one is set. */
function environmentTokenVariable(environment: NodeJS.ProcessEnv): string | null {
  return ["GH_TOKEN", "GITHUB_TOKEN"].find((name) => environment[name]?.trim()) ?? null;
}

/**
 * GitHub is usable with a token from the environment or with `gh` to hand one over. An
 * environment token is checked against the API, since `gh auth status` may not know it.
 */
export const makeDiscovery = Effect.gen(function* () {
  const api = yield* GitHubApi.GitHubApi;
  const process = yield* VcsProcess.VcsProcess;
  const environment = yield* HostProcessEnvironment;
  return {
    type: "managed-cli",
    kind: discovery.kind,
    label: discovery.label,
    installHint: discovery.installHint,
    probe: Effect.fn("GitHubSourceControlProvider.discovery")(function* (cwd: string) {
      const cli = yield* probeSourceControlProvider({ cwd, process, spec: discovery });
      const variable = environmentTokenVariable(environment);
      if (variable === null) return cli;
      const viewer = yield* api
        .rest({ host: "github.com", operation: "discovery", path: "user" })
        .pipe(Effect.result);
      const login = Result.isSuccess(viewer)
        ? Option.getOrUndefined(decodeViewer(viewer.success.body))?.login
        : undefined;
      return {
        ...cli,
        status: "available" as const,
        auth:
          login !== undefined
            ? providerAuth({
                status: "authenticated",
                account: login,
                host: "github.com",
                detail: `Using the token in ${variable} from the server environment.`,
              })
            : Result.isFailure(viewer) && viewer.failure._tag !== "GitHubApiAuthenticationError"
              ? // Only a refusal says the token is bad; a network error or a pause says nothing.
                providerAuth({
                  status: "unknown",
                  host: "github.com",
                  detail: `Could not check the token in ${variable}: ${viewer.failure.message}`,
                })
              : providerAuth({
                  status: "unauthenticated",
                  host: "github.com",
                  detail: `GitHub refused the token in ${variable}. Replace it, or unset it to use \`gh auth login\`.`,
                }),
      } satisfies SourceControlProviderDiscoveryItem;
    }),
    refineUnknownRemote: () => Effect.succeed(null),
  } satisfies SourceControlManagedCliDiscoverySpec;
});

export const make = Effect.gen(function* () {
  const github = yield* GitHubCli.GitHubCli;
  const api = yield* GitHubApi.GitHubApi;

  const listChangeRequests: SourceControlProvider.SourceControlProvider["Service"]["listChangeRequests"] =
    (input) => {
      if (input.state === "open") {
        return github
          .listOpenPullRequests({
            cwd: input.cwd,
            headSelector: input.headSelector,
            ...(input.context === undefined
              ? {}
              : { rateLimitHost: new URL(input.context.provider.baseUrl).host }),
            ...(input.limit !== undefined ? { limit: input.limit } : {}),
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
                  detail: error.message,
                  cause: error,
                }),
            ),
          );
      }

      return github
        .listPullRequestsByHead({
          cwd: input.cwd,
          headSelector: input.headSelector,
          state: input.state,
          limit: input.limit ?? 20,
          ...(input.context === undefined
            ? {}
            : { rateLimitHost: new URL(input.context.provider.baseUrl).host }),
        })
        .pipe(
          Effect.map((items) =>
            items.map(({ updatedAt, ...summary }) => ({
              ...toChangeRequest({
                ...summary,
                ...(Option.isSome(updatedAt)
                  ? { updatedAt: DateTime.formatIso(updatedAt.value) }
                  : {}),
              }),
              updatedAt,
            })),
          ),
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
                detail: error.message,
                cause: error,
              }),
          ),
        );
    };

  const readLinkSubject = Effect.fn("GitHubSourceControlProvider.readLinkSubject")(function* (
    input: { readonly cwd: string; readonly url: URL },
    endpoint: string,
  ) {
    const result = yield* api
      .rest({
        host: input.url.host,
        operation: "resolveLink",
        path: endpoint,
        maxResponseBytes: 1_000_000,
      })
      .pipe(
        Effect.timeout("3 seconds"),
        Effect.mapError(
          (cause) =>
            new SourceControlProviderError({
              provider: "github",
              operation: "resolveLink",
              cwd: input.cwd,
              detail: "The linked subject could not be read.",
              cause,
            }),
        ),
      );
    const subject = yield* decodeLinkSubject(result.body).pipe(
      Effect.mapError(
        (cause) =>
          new SourceControlProviderError({
            provider: "github",
            operation: "resolveLink.decode",
            cwd: input.cwd,
            detail: "The linked subject could not be read.",
            cause,
          }),
      ),
    );
    return { title: subject.title, body: subject.body ?? null };
  });

  return SourceControlProvider.SourceControlProvider.of({
    kind: "github",
    resolveLink: (input) => {
      // Automatic enrichment must not send ambient CLI credentials to a host from message text.
      if (input.url.host !== "github.com") return undefined;
      const match = /^\/([\w.-]+)\/([\w.-]+)\/(?:pull|issues)\/([1-9]\d*)(?:\/.*)?$/.exec(
        input.url.pathname,
      );
      if (!match) return undefined;
      return readLinkSubject(input, `repos/${match[1]}/${match[2]}/issues/${match[3]}`);
    },
    listChangeRequests,
    getChangeRequest: (input) =>
      github
        .getPullRequest({
          ...input,
          ...(input.context === undefined
            ? {}
            : { rateLimitHost: new URL(input.context.provider.baseUrl).host }),
        })
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
                detail: error.message,
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
                provider: "github",
                operation: "createChangeRequest",
                command: error.command,
                cwd: input.cwd,
                reference: SourceControlProvider.transportSafeSourceControlErrorValue(
                  input.headSelector,
                ),
                detail: error.message,
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
              detail: error.message,
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
              detail: error.message,
              cause: error,
            }),
        ),
      ),
    getDefaultBranch: (input) =>
      github
        .getDefaultBranch({
          ...input,
          ...(input.context === undefined
            ? {}
            : { rateLimitHost: new URL(input.context.provider.baseUrl).host }),
        })
        .pipe(
          Effect.mapError(
            (error) =>
              new SourceControlProviderError({
                provider: "github",
                operation: "getDefaultBranch",
                command: error.command,
                cwd: input.cwd,
                detail: error.message,
                cause: error,
              }),
          ),
        ),
    checkoutChangeRequest: (input) =>
      github.checkoutPullRequest(input).pipe(
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
              detail: error.message,
              cause: error,
            }),
        ),
      ),
  });
});
