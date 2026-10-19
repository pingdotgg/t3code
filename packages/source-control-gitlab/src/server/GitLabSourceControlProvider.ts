import { SourceControlProviderKind } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { SourceControlProviderError, type ChangeRequest } from "@t3tools/contracts";
import { detectSourceControlProviderFromRemoteUrl } from "@t3tools/shared/sourceControl";

import * as GitLabCli from "./GitLabCli.ts";
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
import { findAuthenticatedGitLabHost, parseGitLabAuthStatusHosts } from "./gitLabAuthStatus.ts";

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

function unknownRemoteProvider(remoteUrl: string) {
  // The shared detector does not recognize userless SCP remotes.
  const scpHost = /^([^@:/\\\s]{2,}):\/?[^/\s]+(?:\/[^/\s]+)+$/u.exec(remoteUrl.trim())?.[1];
  const provider = detectSourceControlProviderFromRemoteUrl(
    scpHost ? `ssh://${scpHost}` : remoteUrl,
  );
  return provider?.kind === "unknown" ? provider : null;
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
  authArgs: ["auth", "status"],
  // glab matches its configured hosts by exact name, so ask with the remote's own spelling.
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

  const readLinkSubject = Effect.fn("GitLabSourceControlProvider.readLinkSubject")(function* (
    input: { readonly cwd: string; readonly url: URL },
    endpoint: string,
  ) {
    const result = yield* gitlab
      .execute({
        cwd: input.cwd,
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
    getChangeRequest: (input) =>
      gitlab.getMergeRequest(input).pipe(
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
    getRepositoryCloneUrls: (input) =>
      gitlab.getRepositoryCloneUrls(input).pipe(
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
      ),
    createRepository: (input) =>
      gitlab.createRepository(input).pipe(
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
      ),
    getDefaultBranch: (input) =>
      gitlab.getDefaultBranch(input).pipe(
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
      ),
    checkoutChangeRequest: (input) =>
      gitlab.checkoutMergeRequest(input).pipe(
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
      ),
  });
});
