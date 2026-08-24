import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { SourceControlProviderError, type ChangeRequest } from "@t3tools/contracts";

import * as GiteaCli from "./GiteaCli.ts";
import * as SourceControlProvider from "./SourceControlProvider.ts";
import {
  firstSafeAuthLine,
  providerAuth,
  type SourceControlAuthProbeInput,
  type SourceControlCliDiscoverySpec,
  type SourceControlUnknownRemoteRefinementInput,
} from "./SourceControlProviderDiscovery.ts";
import { findGiteaLoginForHost, findPrimaryGiteaLogin, parseGiteaLogins } from "./giteaLogins.ts";

function toChangeRequest(summary: GiteaCli.GiteaPullRequestSummary): ChangeRequest {
  return {
    provider: "gitea",
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

const LOGIN_HINT = "Run `tea login add` to authenticate against a Gitea instance.";

/**
 * Reads `tea logins list --output json`. Only stdout is parsed: stderr may carry warnings that
 * would invalidate the JSON, and it is used for diagnostics only.
 */
function parseGiteaAuth(input: SourceControlAuthProbeInput) {
  const logins = parseGiteaLogins(input.stdout);
  const primary = findPrimaryGiteaLogin(logins);
  const host = primary?.hostname;

  if (primary?.user) {
    // The discovery contract holds a single account, so extra instances are named in the detail
    // rather than dropped silently — `tea` still refines remotes against all of them.
    const others = logins.length - 1;
    return providerAuth({
      status: "authenticated",
      account: primary.user,
      host,
      ...(others > 0
        ? { detail: `${logins.length} Gitea instances configured; showing the default.` }
        : {}),
    });
  }

  if (logins.length > 0) {
    return providerAuth({
      status: "unknown",
      host,
      detail: `Gitea logins are configured but report no user. ${LOGIN_HINT}`,
    });
  }

  if (input.exitCode !== 0) {
    return providerAuth({
      status: "unauthenticated",
      detail: firstSafeAuthLine(input.stderr) ?? LOGIN_HINT,
    });
  }

  return providerAuth({ status: "unauthenticated", detail: LOGIN_HINT });
}

/**
 * Gitea is nearly always self-hosted on a hostname that carries no hint of it, so the static
 * detector leaves those remotes `unknown`. This promotes one to `gitea` only when `tea` is already
 * authenticated against that exact host, which keeps unrelated Git hosts untouched and avoids any
 * network probing of arbitrary remotes.
 */
function refineUnknownGiteaRemote(input: SourceControlUnknownRemoteRefinementInput) {
  const login = findGiteaLoginForHost(
    parseGiteaLogins(input.auth.stdout),
    input.context.provider.name,
  );
  if (!login) {
    return null;
  }

  return {
    kind: "gitea",
    name: "Gitea Self-Hosted",
    baseUrl: input.context.provider.baseUrl,
  } as const;
}

export const discovery = {
  type: "cli",
  kind: "gitea",
  label: "Gitea",
  executable: "tea",
  versionArgs: ["--version"],
  authArgs: ["logins", "list", "--output", "json"],
  parseAuth: parseGiteaAuth,
  refineUnknownRemote: refineUnknownGiteaRemote,
  installHint:
    "Install the Gitea command-line tool (`tea`) from https://gitea.com/gitea/tea or your package manager (for example `brew install tea`), then run `tea login add`.",
} satisfies SourceControlCliDiscoverySpec;

export const make = Effect.gen(function* () {
  const gitea = yield* GiteaCli.GiteaCli;

  return SourceControlProvider.SourceControlProvider.of({
    kind: "gitea",
    listChangeRequests: (input) => {
      const source = SourceControlProvider.sourceControlRefFromInput(input);
      return gitea
        .listPullRequests({
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
                provider: "gitea",
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
      gitea.getPullRequest(input).pipe(
        Effect.map(toChangeRequest),
        Effect.mapError(
          (error) =>
            new SourceControlProviderError({
              provider: "gitea",
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
      return gitea
        .createPullRequest({
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
                provider: "gitea",
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
      gitea.getRepositoryCloneUrls(input).pipe(
        Effect.mapError(
          (error) =>
            new SourceControlProviderError({
              provider: "gitea",
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
      gitea.createRepository(input).pipe(
        Effect.mapError(
          (error) =>
            new SourceControlProviderError({
              provider: "gitea",
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
      gitea.getDefaultBranch(input).pipe(
        Effect.mapError(
          (error) =>
            new SourceControlProviderError({
              provider: "gitea",
              operation: "getDefaultBranch",
              command: error.command,
              cwd: input.cwd,
              detail: error.detail,
              cause: error,
            }),
        ),
      ),
    checkoutChangeRequest: (input) =>
      gitea.checkoutPullRequest(input).pipe(
        Effect.mapError(
          (error) =>
            new SourceControlProviderError({
              provider: "gitea",
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
