import { SourceControlProviderKind } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { SourceControlProviderError, type ChangeRequest } from "@t3tools/contracts";
import {
  parseGitRemoteHost,
  unknownRemoteProvider as unknownHostProvider,
} from "@t3tools/source-control-core/shared/definition";

import * as GitLabCli from "./GitLabCli.ts";
import * as GitLabChangeRequestTemplate from "./gitLabChangeRequestTemplate.ts";
import * as SourceControlHost from "@t3tools/source-control-core/server/SourceControlHost";
import * as SourceControlProvider from "@t3tools/source-control-core/server/SourceControlProvider";
import {
  combinedAuthOutput,
  firstSafeAuthLine,
  matchFirst,
  parseCliHost,
  providerAuth,
  type SourceControlAuthProbeInput,
  type SourceControlCliDiscoverySpec,
  type SourceControlUnknownRemoteRefinementInput,
} from "@t3tools/source-control-core/server/discovery";
import { parseGitLabAuthStatusHosts } from "./gitLabAuthStatus.ts";

const decodeLinkSubject = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Struct({ title: Schema.String, description: Schema.NullOr(Schema.String) }),
  ),
);

function toChangeRequest(summary: GitLabCli.GitLabMergeRequestSummary): ChangeRequest {
  return {
    provider: SourceControlProviderKind.make("gitlab"),
    number: summary.number,
    title: summary.title,
    url: summary.url,
    baseRefName: summary.baseRefName,
    headRefName: summary.headRefName,
    ...(summary.headSha !== undefined ? { headSha: summary.headSha } : {}),
    state: summary.state ?? "open",
    ...(summary.isDraft === true ? { isDraft: true } : {}),
    closedAt: summary.closedAt ?? null,
    mergedAt: summary.mergedAt ?? null,
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

const INCOMPLETE_AUTH_DETAIL =
  "The GitLab account list is incomplete because glab output was truncated.";

function parseGitLabAuth(input: SourceControlAuthProbeInput) {
  if (input.stdoutTruncated || input.stderrTruncated) {
    return providerAuth({ status: "unknown", detail: INCOMPLETE_AUTH_DETAIL });
  }
  const output = combinedAuthOutput(input);
  const accounts = parseGitLabAuthStatusHosts(output).flatMap(({ host, account }) =>
    account === null ? [] : [{ host, account, active: true, authenticated: true }],
  );
  const authenticatedHost = accounts[0];
  const account =
    authenticatedHost?.account ??
    matchFirst(output, [
      /Logged in to .* as\s+([^\s(]+)/iu,
      /Logged in to .* account\s+([^\s(]+)/iu,
      /account:\s*([^\s(]+)/iu,
    ]);
  const host = authenticatedHost?.host ?? parseCliHost(output);

  if (account) {
    return {
      ...providerAuth({ status: "authenticated", account, host }),
      ...(accounts.length > 0 ? { accounts } : {}),
    };
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

const GITLAB_HOST_NOT_LOGGED_IN_PATTERN =
  /\bnot (?:been )?authenticated with glab\b|\bno gitlab instances? ha(?:s|ve) been authenticated\b/iu;

function refineUnknownGitLabRemote(input: SourceControlUnknownRemoteRefinementInput) {
  const host = input.context.provider.name.toLowerCase();
  const output = combinedAuthOutput(input.auth);
  const authenticated = parseGitLabAuthStatusHosts(output).some(
    (entry) => entry.account !== null && entry.host === host,
  );

  if (!authenticated) {
    return GITLAB_HOST_NOT_LOGGED_IN_PATTERN.test(output) ? null : undefined;
  }

  return {
    kind: SourceControlProviderKind.make("gitlab"),
    name: "GitLab Self-Hosted",
    baseUrl: input.context.provider.baseUrl,
  } as const;
}

/** The caller refines only an identity no host recognised, so its remote is on an unknown host. */
function unknownRemoteProvider(remoteUrl: string) {
  const remote = parseGitRemoteHost(remoteUrl);
  return remote === null ? null : unknownHostProvider(remote);
}

// A glab login confirms a self-hosted GitLab whose hostname does not identify its provider.
const refineRepositoryIdentity: NonNullable<
  SourceControlProvider.SourceControlProvider["Service"]["refineRepositoryIdentity"]
> = Effect.fn("GitLabSourceControlProvider.refineRepositoryIdentity")(function* ({
  identity,
  resolveContext,
}) {
  if (!identity.rootPath || (identity.provider !== undefined && identity.provider !== "unknown"))
    return identity;
  const provider = unknownRemoteProvider(identity.locator.remoteUrl);
  if (!provider) return identity;
  const context = yield* resolveContext({
    cwd: identity.rootPath,
    context: {
      provider,
      remoteName: identity.locator.remoteName,
      remoteUrl: identity.locator.remoteUrl,
    },
  });
  return context?.provider.kind === "gitlab"
    ? { ...identity, provider: SourceControlProviderKind.make("gitlab") }
    : identity;
});

export const discovery = {
  type: "cli",
  kind: SourceControlProviderKind.make("gitlab"),
  label: "GitLab",
  executable: "glab",
  versionArgs: ["--version"],
  authArgs: ["auth", "status", "--all"],
  authMaxOutputBytes: 64_000,
  completeAuthProbe: Effect.fn("GitLabSourceControlProvider.completeAuthProbe")(
    function* (all, run, environment) {
      let auth = all;
      if (all.accounts?.length !== 1) {
        // Check the current host for the primary account, or when older glab rejects --all.
        const current = yield* run(["auth", "status"]);
        const allIncomplete = Option.getOrUndefined(all.detail) === INCOMPLETE_AUTH_DETAIL;
        if (current.status === "authenticated") {
          const accounts = current.accounts ?? [];
          const additional = all.accounts?.filter(
            (account) => !accounts.some((entry) => entry.host === account.host),
          );
          auth = {
            ...current,
            ...(additional?.length ? { accounts: [...accounts, ...additional] } : {}),
            ...(allIncomplete ? { detail: all.detail } : {}),
          };
        } else if (all.status !== "authenticated" && !allIncomplete) {
          auth = current;
        }
      }

      const host = GitLabCli.defaultHost(environment);
      if (
        !GitLabCli.hasEnvironmentToken(environment) ||
        auth.accounts?.some((account) => account.host === host)
      ) {
        return auth;
      }

      const named = yield* run(["auth", "status", "--hostname", host]);
      if (named.status !== "authenticated") return auth;
      if (auth.status === "authenticated") {
        const account = named.accounts?.find((entry) => entry.host === host);
        return account ? { ...auth, accounts: [...(auth.accounts ?? []), account] } : auth;
      }
      return Option.getOrUndefined(auth.detail) === INCOMPLETE_AUTH_DETAIL
        ? { ...named, detail: auth.detail }
        : named;
    },
  ),
  probeEnv: (args, environment) => {
    const named = args.indexOf("--hostname");
    return named !== -1 &&
      GitLabCli.hostOf(args[named + 1] ?? "") === GitLabCli.defaultHost(environment)
      ? {}
      : GitLabCli.WITHOUT_ENVIRONMENT_TOKEN;
  },
  // glab host matching requires the remote's exact spelling.
  remoteRefinementArgs: ({ provider, remoteUrl }) => {
    const authority = /^[a-z][a-z0-9+.-]*:\/\/([^/]+)/iu.exec(remoteUrl.trim())?.[1];
    const remoteHost = authority
      ? authority.slice(authority.lastIndexOf("@") + 1)
      : remoteUrl.trim().replace(/^[^@:/]+@/u, "");
    const host = remoteHost.toLowerCase().startsWith(provider.name.toLowerCase())
      ? remoteHost.slice(0, provider.name.length)
      : provider.name;
    return ["auth", "status", "--hostname", host];
  },
  parseAuth: parseGitLabAuth,
  refineUnknownRemote: refineUnknownGitLabRemote,
  installHint:
    "Install the GitLab command-line tool (`glab`) from https://gitlab.com/gitlab-org/cli or your package manager (for example `brew install glab`).",
} satisfies SourceControlCliDiscoverySpec;

export const make = Effect.gen(function* () {
  const gitlab = yield* GitLabCli.GitLabCli;
  const { git } = yield* SourceControlHost.SourceControlHost;

  const readLinkSubject = Effect.fn("GitLabSourceControlProvider.readLinkSubject")(function* (
    input: { readonly cwd: string; readonly url: URL },
    endpoint: string,
  ) {
    const result = yield* gitlab
      .execute({
        cwd: input.cwd,
        callerNamedHost: input.url.host,
        args: ["api", "--hostname", input.url.host, endpoint],
        timeoutMs: 3_000,
        maxOutputBytes: 32_000,
      })
      .pipe(
        Effect.mapError(
          (cause) =>
            new SourceControlProviderError({
              provider: SourceControlProviderKind.make("gitlab"),
              operation: "resolveLink",
              cwd: input.cwd,
              detail: "The linked subject could not be read.",
              cause,
            }),
        ),
      );
    const subject = yield* decodeLinkSubject(result.stdout).pipe(
      Effect.mapError(
        (cause) =>
          new SourceControlProviderError({
            provider: SourceControlProviderKind.make("gitlab"),
            operation: "resolveLink.decode",
            cwd: input.cwd,
            detail: "The linked subject could not be read.",
            cause,
          }),
      ),
    );
    return { title: subject.title, body: subject.description };
  });

  return SourceControlProvider.SourceControlProvider.of({
    kind: SourceControlProviderKind.make("gitlab"),
    // GitLab lists fork merge requests by source branch with no owner filter, so read a full page
    // once per branch. The first selector wins: GitManager puts `owner:branch` first for a fork
    // head, which tells the list to name fork source projects.
    headBranchProbe: ({ headSelectors }) => {
      const byBranch = new Map<string, string>();
      for (const selector of headSelectors) {
        const branch = SourceControlProvider.sourceBranch({ headSelector: selector });
        if (!byBranch.has(branch)) byBranch.set(branch, selector);
      }
      return { headSelectors: [...byBranch.values()], limit: 100 };
    },
    readChangeRequestTemplate: Effect.fn("GitLabSourceControlProvider.readChangeRequestTemplate")(
      function ({ cwd, treeish }) {
        return GitLabChangeRequestTemplate.detect(cwd, treeish, git.execute);
      },
    ),
    refineRepositoryIdentity,
    resolveLink: (input) => {
      // Automatic enrichment must not send ambient CLI credentials to a host from message text.
      if (input.url.host !== "gitlab.com") return undefined;
      const match = /^\/(.+)\/-\/(merge_requests|issues)\/([1-9]\d*)(?:\/.*)?$/.exec(
        input.url.pathname,
      );
      if (!match) return undefined;
      return readLinkSubject(
        input,
        `projects/${encodeURIComponent(match[1]!)}/${match[2]}/${match[3]}`,
      );
    },
    listChangeRequests: Effect.fn("GitLabSourceControlProvider.listChangeRequests")(
      function (input) {
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
                  provider: SourceControlProviderKind.make("gitlab"),
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
    ),
    getChangeRequest: Effect.fn("GitLabSourceControlProvider.getChangeRequest")(function (input) {
      return gitlab.getMergeRequest(input).pipe(
        Effect.map(toChangeRequest),
        Effect.mapError(
          (error) =>
            new SourceControlProviderError({
              provider: SourceControlProviderKind.make("gitlab"),
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
      );
    }),
    createsDraftChangeRequests: true,
    createChangeRequest: Effect.fn("GitLabSourceControlProvider.createChangeRequest")(
      function (input) {
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
            ...(input.draft === true ? { draft: true } : {}),
          })
          .pipe(
            Effect.mapError(
              (error) =>
                new SourceControlProviderError({
                  provider: SourceControlProviderKind.make("gitlab"),
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
    ),
    getRepositoryCloneUrls: Effect.fn("GitLabSourceControlProvider.getRepositoryCloneUrls")(
      function (input) {
        return gitlab.getRepositoryCloneUrls(input).pipe(
          Effect.mapError(
            (error) =>
              new SourceControlProviderError({
                provider: SourceControlProviderKind.make("gitlab"),
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
        );
      },
    ),
    createRepository: Effect.fn("GitLabSourceControlProvider.createRepository")(function (input) {
      return gitlab.createRepository(input).pipe(
        Effect.mapError(
          (error) =>
            new SourceControlProviderError({
              provider: SourceControlProviderKind.make("gitlab"),
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
      );
    }),
    getDefaultBranch: Effect.fn("GitLabSourceControlProvider.getDefaultBranch")(function (input) {
      return gitlab.getDefaultBranch(input).pipe(
        Effect.mapError(
          (error) =>
            new SourceControlProviderError({
              provider: SourceControlProviderKind.make("gitlab"),
              operation: "getDefaultBranch",
              command: error.command,
              cwd: input.cwd,
              detail: error.detail,
              cause: error,
            }),
        ),
      );
    }),
    checkoutChangeRequest: Effect.fn("GitLabSourceControlProvider.checkoutChangeRequest")(
      function (input) {
        return gitlab.checkoutMergeRequest(input).pipe(
          Effect.mapError(
            (error) =>
              new SourceControlProviderError({
                provider: SourceControlProviderKind.make("gitlab"),
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
        );
      },
    ),
  });
});
